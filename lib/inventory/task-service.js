/**
 * Operational task workflow for Inventory Intelligence.
 *
 * Every actionable recommendation produces (or reuses) one task. At most one
 * unresolved task exists per item and task type: the lookup below prevents
 * duplicates in the normal case and the filtered unique index on
 * (idempotency_key) WHERE status is active prevents them under a race.
 *
 * Task history is append-only: every status change, assignment, edit,
 * escalation and scan refresh adds a row; nothing updates or deletes one.
 */

const { randomUUID } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { recordInventoryAudit } = require("./audit-service");
const { badRequest, conflict, notFound } = require("./errors");

const TASK_TYPES = Object.freeze([
  "APPROVE_REPLENISHMENT_CHANGE",
  "REVIEW_SUGGESTED_PO",
  "COUNT_SHELF",
  "REVIEW_WRITE_OFF",
  "REVIEW_OVERSTOCK",
  "RESOLVE_SUPPLIER_MAPPING",
  "CORRECT_ITEM_DATA"
]);

const TASK_STATUSES = Object.freeze([
  "OPEN", "ASSIGNED", "IN_PROGRESS", "PENDING_APPROVAL",
  "APPROVED", "REJECTED", "COMPLETED", "CANCELLED", "BLOCKED"
]);

const TASK_PRIORITIES = Object.freeze(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
const PRIORITY_RANK = Object.freeze({ CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });
const DUE_DAYS = Object.freeze({ CRITICAL: 1, HIGH: 3, MEDIUM: 7, LOW: 14, INFO: 30 });

/** Unresolved: these statuses hold the item+purpose "slot" so a rescan reuses the task. */
const ACTIVE_STATUSES = Object.freeze(["OPEN", "ASSIGNED", "IN_PROGRESS", "PENDING_APPROVAL", "BLOCKED"]);
const ACTIVE_SET = new Set(ACTIVE_STATUSES);

const TASK_TRANSITIONS = Object.freeze({
  OPEN: ["ASSIGNED", "IN_PROGRESS", "PENDING_APPROVAL", "APPROVED", "REJECTED", "COMPLETED", "CANCELLED", "BLOCKED"],
  ASSIGNED: ["OPEN", "IN_PROGRESS", "PENDING_APPROVAL", "APPROVED", "REJECTED", "COMPLETED", "CANCELLED", "BLOCKED"],
  IN_PROGRESS: ["ASSIGNED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "COMPLETED", "CANCELLED", "BLOCKED"],
  PENDING_APPROVAL: ["ASSIGNED", "IN_PROGRESS", "APPROVED", "REJECTED", "CANCELLED", "BLOCKED"],
  BLOCKED: ["OPEN", "ASSIGNED", "IN_PROGRESS", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  COMPLETED: [],
  CANCELLED: []
});

const TASK_COLUMNS = `
  task_id AS taskId,
  recommendation_id AS recommendationId,
  item_id AS itemId,
  supplier_id AS supplierId,
  idempotency_key AS idempotencyKey,
  task_type AS taskType,
  status,
  assignee,
  priority,
  due_date AS dueDate,
  source_run_id AS sourceRunId,
  task_payload_json AS taskPayloadJson,
  resolution_note AS resolutionNote,
  audit_correlation_id AS auditCorrelationId,
  created_at AS createdAt,
  updated_at AS updatedAt,
  completed_at AS completedAt,
  cancelled_at AS cancelledAt,
  escalated_at AS escalatedAt`;

function dueDateFor(priority, from = new Date()) {
  const days = DUE_DAYS[priority] || DUE_DAYS.MEDIUM;
  const due = new Date(from.getTime() + days * 86400000);
  return due.toISOString().slice(0, 10);
}

function taskKey(itemId, taskType) {
  return `task:${itemId}:${taskType}`;
}

function mapTaskRow(row) {
  if (!row) return null;
  const dueDate = row.dueDate instanceof Date ? row.dueDate.toISOString().slice(0, 10) : (row.dueDate || null);
  return {
    ...row,
    dueDate,
    createdAt: store.toIso(row.createdAt),
    updatedAt: store.toIso(row.updatedAt),
    completedAt: store.toIso(row.completedAt),
    cancelledAt: store.toIso(row.cancelledAt),
    escalatedAt: store.toIso(row.escalatedAt),
    taskPayload: store.parseJson(row.taskPayloadJson)
  };
}

function isDuplicateKeyError(error) {
  return Boolean(error) && (error.number === 2601 || error.number === 2627);
}

function validateDueDate(value) {
  if (value == null || value === "") return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw badRequest("Due date must be a valid date (YYYY-MM-DD).");
  }
  return text;
}

function validateAssignee(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 120) throw badRequest("Assignee must be 120 characters or fewer.");
  return text;
}

async function getTask(taskId, { tx = null, lock = false } = {}) {
  if (!taskId) return null;
  if (store.isTestMode()) {
    const t = store.mem.tasks.get(taskId);
    return t ? mapTaskRow({ ...t }) : null;
  }
  const req = await store.request(tx);
  const result = await req
    .input("task_id", sql.UniqueIdentifier, taskId)
    .query(`SELECT ${TASK_COLUMNS} FROM inventory.operational_tasks ${lock ? "WITH (UPDLOCK, HOLDLOCK)" : ""} WHERE task_id = @task_id;`);
  return mapTaskRow(result.recordset[0]);
}

async function findActiveTaskByIdempotencyKey(idempotencyKey, { tx = null } = {}) {
  if (store.isTestMode()) {
    for (const t of store.mem.tasks.values()) {
      if (t.idempotencyKey === idempotencyKey && ACTIVE_SET.has(t.status)) return mapTaskRow({ ...t });
    }
    return null;
  }
  const req = await store.request(tx);
  const result = await req
    .input("idempotency_key", sql.NVarChar(200), idempotencyKey)
    .query(`
      SELECT TOP 1 ${TASK_COLUMNS}
      FROM inventory.operational_tasks WITH (UPDLOCK, HOLDLOCK)
      WHERE idempotency_key = @idempotency_key
        AND status IN (${ACTIVE_STATUSES.map((s) => `N'${s}'`).join(", ")});
    `);
  return mapTaskRow(result.recordset[0]);
}

async function recordTaskHistory({ taskId, eventType, fromStatus = null, toStatus = null, actor, note = null, details = null, tx = null }) {
  const entry = {
    taskHistoryId: null,
    taskId,
    eventType,
    fromStatus,
    toStatus,
    actor: store.clip(actor || "system", 120),
    note: store.clip(note, 1000),
    details: details || null,
    detailsJson: details ? JSON.stringify(details) : null,
    createdAt: new Date().toISOString()
  };

  if (store.isTestMode()) {
    entry.taskHistoryId = store.nextSequence();
    store.mem.taskHistory.push(entry);
    return entry;
  }

  const req = await store.request(tx);
  const result = await req
    .input("task_id", sql.UniqueIdentifier, taskId)
    .input("event_type", sql.NVarChar(60), eventType)
    .input("from_status", sql.NVarChar(40), fromStatus)
    .input("to_status", sql.NVarChar(40), toStatus)
    .input("actor", sql.NVarChar(120), entry.actor)
    .input("note", sql.NVarChar(1000), entry.note)
    .input("details_json", sql.NVarChar(sql.MAX), entry.detailsJson)
    .query(`
      INSERT INTO inventory.task_history (task_id, event_type, from_status, to_status, actor, note, details_json)
      OUTPUT INSERTED.task_history_id AS taskHistoryId
      VALUES (@task_id, @event_type, @from_status, @to_status, @actor, @note, @details_json);
    `);
  entry.taskHistoryId = result.recordset[0].taskHistoryId;
  return entry;
}

async function listTaskHistory(taskId) {
  if (store.isTestMode()) {
    return store.mem.taskHistory.filter((h) => h.taskId === taskId).map((h) => ({ ...h }));
  }
  const req = await store.request();
  const result = await req
    .input("task_id", sql.UniqueIdentifier, taskId)
    .query(`
      SELECT task_history_id AS taskHistoryId, task_id AS taskId, event_type AS eventType,
             from_status AS fromStatus, to_status AS toStatus, actor, note,
             details_json AS detailsJson, created_at AS createdAt
      FROM inventory.task_history
      WHERE task_id = @task_id
      ORDER BY task_history_id ASC;
    `);
  return result.recordset.map((h) => ({
    ...h,
    details: store.parseJson(h.detailsJson),
    createdAt: store.toIso(h.createdAt)
  }));
}

/**
 * Creates the task for an item+purpose, or reuses the unresolved one.
 * Returns { task, created, changed }.
 */
async function syncOperationalTask({
  recommendationId = null,
  itemId,
  supplierId = null,
  taskType,
  priority = "MEDIUM",
  dueDate = null,
  sourceRunId = null,
  taskPayload = null,
  actor = "system",
  tx = null
}) {
  if (!TASK_TYPES.includes(taskType)) throw badRequest(`Unknown task type ${taskType}.`);
  if (!TASK_PRIORITIES.includes(priority)) throw badRequest(`Unknown priority ${priority}.`);

  const idempotencyKey = taskKey(itemId, taskType);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const payloadJson = taskPayload ? JSON.stringify(taskPayload) : null;

  const existing = await findActiveTaskByIdempotencyKey(idempotencyKey, { tx });
  if (existing) {
    const payloadChanged = (existing.taskPayloadJson || null) !== payloadJson;
    const linkChanged = existing.recommendationId !== recommendationId;
    const escalate = (PRIORITY_RANK[priority] || 0) > (PRIORITY_RANK[existing.priority] || 0);

    if (!payloadChanged && !linkChanged && !escalate) {
      return { task: existing, created: false, changed: false };
    }

    const newPriority = escalate ? priority : existing.priority;
    const updated = {
      ...existing,
      recommendationId,
      supplierId: supplierId || existing.supplierId,
      sourceRunId: sourceRunId || existing.sourceRunId,
      taskPayloadJson: payloadJson,
      taskPayload: taskPayload || null,
      priority: newPriority,
      escalatedAt: escalate ? now : existing.escalatedAt,
      updatedAt: now
    };

    if (store.isTestMode()) {
      const { taskPayload: _drop, ...stored } = updated;
      store.mem.tasks.set(existing.taskId, stored);
    } else {
      const req = await store.request(tx);
      await req
        .input("task_id", sql.UniqueIdentifier, existing.taskId)
        .input("recommendation_id", sql.UniqueIdentifier, recommendationId)
        .input("supplier_id", sql.NVarChar(100), updated.supplierId)
        .input("source_run_id", sql.UniqueIdentifier, updated.sourceRunId)
        .input("task_payload_json", sql.NVarChar(sql.MAX), payloadJson)
        .input("priority", sql.NVarChar(20), newPriority)
        .input("escalated_at", sql.DateTime2, updated.escalatedAt ? new Date(updated.escalatedAt) : null)
        .input("updated_at", sql.DateTime2, nowDate)
        .query(`
          UPDATE inventory.operational_tasks
          SET recommendation_id = @recommendation_id,
              supplier_id = @supplier_id,
              source_run_id = @source_run_id,
              task_payload_json = @task_payload_json,
              priority = @priority,
              escalated_at = @escalated_at,
              updated_at = @updated_at
          WHERE task_id = @task_id;
        `);
    }

    // Evidence drifting day to day updates the task quietly. Only a change of
    // substance - a new recommendation behind it, or a higher priority - is history.
    if (escalate || linkChanged) {
      await recordTaskHistory({
        taskId: existing.taskId,
        eventType: escalate ? "ESCALATED" : "SCAN_REFRESHED",
        fromStatus: existing.status,
        toStatus: existing.status,
        actor,
        note: escalate
          ? `Priority raised from ${existing.priority} to ${priority} by recalculation`
          : "Task now follows the latest recommendation revision",
        tx
      });
    }
    return { task: updated, created: false, changed: true };
  }

  const taskId = randomUUID();
  const task = {
    taskId,
    recommendationId,
    itemId,
    supplierId,
    idempotencyKey,
    taskType,
    status: "OPEN",
    assignee: null,
    priority,
    dueDate: validateDueDate(dueDate) || dueDateFor(priority, nowDate),
    sourceRunId,
    taskPayloadJson: payloadJson,
    resolutionNote: null,
    auditCorrelationId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
    escalatedAt: null
  };

  if (store.isTestMode()) {
    store.mem.tasks.set(taskId, { ...task });
  } else {
    try {
      const req = await store.request(tx);
      await req
        .input("task_id", sql.UniqueIdentifier, taskId)
        .input("recommendation_id", sql.UniqueIdentifier, recommendationId)
        .input("item_id", sql.NVarChar(100), itemId)
        .input("supplier_id", sql.NVarChar(100), supplierId)
        .input("idempotency_key", sql.NVarChar(200), idempotencyKey)
        .input("task_type", sql.NVarChar(60), taskType)
        .input("status", sql.NVarChar(40), task.status)
        .input("priority", sql.NVarChar(20), priority)
        .input("due_date", sql.VarChar(10), task.dueDate)
        .input("source_run_id", sql.UniqueIdentifier, sourceRunId)
        .input("task_payload_json", sql.NVarChar(sql.MAX), payloadJson)
        .input("audit_correlation_id", sql.NVarChar(120), task.auditCorrelationId)
        .input("created_at", sql.DateTime2, nowDate)
        .query(`
          INSERT INTO inventory.operational_tasks (
            task_id, recommendation_id, item_id, supplier_id, idempotency_key, task_type,
            status, priority, due_date, source_run_id, task_payload_json,
            audit_correlation_id, created_at, updated_at
          ) VALUES (
            @task_id, @recommendation_id, @item_id, @supplier_id, @idempotency_key, @task_type,
            @status, @priority, @due_date, @source_run_id, @task_payload_json,
            @audit_correlation_id, @created_at, @created_at
          );
        `);
    } catch (error) {
      // A concurrent scan created the unresolved task between our lookup and insert.
      if (isDuplicateKeyError(error) && !tx) {
        const winner = await findActiveTaskByIdempotencyKey(idempotencyKey);
        if (winner) return { task: winner, created: false, changed: false };
      }
      throw error;
    }
  }

  await recordTaskHistory({ taskId, eventType: "CREATED", fromStatus: null, toStatus: "OPEN", actor, note: `Task created for ${taskType}`, tx });
  await recordInventoryAudit({
    recommendationId,
    taskId,
    scanRunId: sourceRunId,
    actor,
    action: "TASK_CREATED",
    entityType: "OperationalTask",
    entityId: taskId,
    afterState: { taskType, status: "OPEN", priority, itemId, dueDate: task.dueDate },
    reason: `Operational task created: ${taskType}`,
    correlationId: task.auditCorrelationId,
    tx
  });

  return { task: mapTaskRow({ ...task }), created: true, changed: true };
}

/**
 * Changes a task's status, assignee, priority or due date. Validates the
 * status transition; every change is recorded in task history and the audit log.
 */
async function updateTaskState({
  taskId,
  status = null,
  assignee = undefined,
  priority = null,
  dueDate = undefined,
  note = null,
  actor,
  tx = null
}) {
  const current = await getTask(taskId, { tx, lock: true });
  if (!current) throw notFound(`Task ${taskId} was not found.`);

  if (status && !TASK_STATUSES.includes(status)) throw badRequest(`Unknown task status ${status}.`);
  if (priority && !TASK_PRIORITIES.includes(priority)) throw badRequest(`Unknown priority ${priority}.`);

  const newAssignee = assignee !== undefined ? validateAssignee(assignee) : current.assignee;
  const newDueDate = dueDate !== undefined ? validateDueDate(dueDate) : current.dueDate;

  // Assigning someone to an untouched task is an assignment, not a silent edit.
  let toStatus = status || current.status;
  if (!status && assignee !== undefined && newAssignee && current.status === "OPEN") toStatus = "ASSIGNED";

  const fromStatus = current.status;
  if (toStatus !== fromStatus) {
    const allowed = TASK_TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw conflict(`A task that is ${fromStatus} cannot move to ${toStatus}.`, "INVALID_TRANSITION");
    }
  } else if (!ACTIVE_SET.has(fromStatus) && (assignee !== undefined || priority || dueDate !== undefined)) {
    throw conflict(`A task that is ${fromStatus} can no longer be edited.`, "TASK_CLOSED");
  }

  const nowDate = new Date();
  const now = nowDate.toISOString();
  let completedAt = current.completedAt;
  let cancelledAt = current.cancelledAt;
  if (toStatus !== fromStatus) {
    if (toStatus === "COMPLETED" || toStatus === "APPROVED") completedAt = now;
    if (toStatus === "CANCELLED" || toStatus === "REJECTED") cancelledAt = now;
  }

  const updated = {
    ...current,
    status: toStatus,
    assignee: newAssignee,
    priority: priority || current.priority,
    dueDate: newDueDate,
    resolutionNote: note ? store.clip(note, 1000) : current.resolutionNote,
    updatedAt: now,
    completedAt,
    cancelledAt
  };

  const unchanged = toStatus === fromStatus
    && updated.assignee === current.assignee
    && updated.priority === current.priority
    && updated.dueDate === current.dueDate;
  if (unchanged) return current;

  if (store.isTestMode()) {
    const { taskPayload: _drop, ...stored } = updated;
    store.mem.tasks.set(taskId, stored);
  } else {
    const req = await store.request(tx);
    await req
      .input("task_id", sql.UniqueIdentifier, taskId)
      .input("status", sql.NVarChar(40), toStatus)
      .input("assignee", sql.NVarChar(120), updated.assignee)
      .input("priority", sql.NVarChar(20), updated.priority)
      .input("due_date", sql.VarChar(10), updated.dueDate)
      .input("resolution_note", sql.NVarChar(1000), updated.resolutionNote)
      .input("completed_at", sql.DateTime2, completedAt ? new Date(completedAt) : null)
      .input("cancelled_at", sql.DateTime2, cancelledAt ? new Date(cancelledAt) : null)
      .input("updated_at", sql.DateTime2, nowDate)
      .query(`
        UPDATE inventory.operational_tasks
        SET status = @status, assignee = @assignee, priority = @priority, due_date = @due_date,
            resolution_note = @resolution_note, completed_at = @completed_at,
            cancelled_at = @cancelled_at, updated_at = @updated_at
        WHERE task_id = @task_id;
      `);
  }

  // Handing a task to someone is an assignment even when it also moves OPEN -> ASSIGNED.
  const assigneeChanged = updated.assignee !== current.assignee;
  let eventType = "EDIT";
  if (assigneeChanged && ["ASSIGNED", "IN_PROGRESS"].includes(toStatus)) eventType = "ASSIGNED";
  else if (fromStatus !== toStatus) eventType = "STATUS_CHANGE";
  else if (assigneeChanged) eventType = "ASSIGNED";

  await recordTaskHistory({
    taskId, eventType, fromStatus, toStatus, actor,
    note: note || (eventType === "ASSIGNED" ? `Assigned to ${updated.assignee || "nobody"}` : `Task updated (${toStatus})`),
    details: eventType === "ASSIGNED" ? { assignee: updated.assignee, dueDate: updated.dueDate } : null,
    tx
  });

  await recordInventoryAudit({
    recommendationId: current.recommendationId,
    taskId,
    actor,
    action: `TASK_${eventType}`,
    entityType: "OperationalTask",
    entityId: taskId,
    beforeState: { status: fromStatus, assignee: current.assignee, priority: current.priority, dueDate: current.dueDate },
    afterState: { status: toStatus, assignee: updated.assignee, priority: updated.priority, dueDate: updated.dueDate },
    reason: note || `Task ${eventType.toLowerCase().replace("_", " ")}`,
    correlationId: current.auditCorrelationId,
    tx
  });

  return updated;
}

/**
 * Creates or reuses the unresolved COUNT_SHELF task for an item and assigns it.
 */
async function assignShelfCount({ itemId, recommendationId = null, assignee, dueDate = null, note = null, actor }) {
  if (!itemId) throw badRequest("An item is required to assign a shelf count.");
  const person = validateAssignee(assignee);
  if (!person) throw badRequest("Choose who should count the shelf.");
  const due = validateDueDate(dueDate);

  return store.withTransaction(async (tx) => {
    const { task } = await syncOperationalTask({
      recommendationId,
      itemId,
      taskType: "COUNT_SHELF",
      priority: "HIGH",
      dueDate: due,
      actor,
      tx
    });
    return updateTaskState({
      taskId: task.taskId,
      status: task.status === "OPEN" ? "ASSIGNED" : null,
      assignee: person,
      dueDate: due || task.dueDate,
      note: note || "Assigned for physical shelf count",
      actor,
      tx
    });
  });
}

/**
 * Cancels an unstarted (OPEN, unassigned) task whose purpose no longer applies
 * because a recalculation superseded its recommendation. Tasks a person has
 * picked up are left alone.
 */
async function cancelObsoleteTasks({ itemId, keepTaskType = null, actor = "system", reason, tx = null }) {
  let cancelled = 0;
  const candidates = [];
  if (store.isTestMode()) {
    for (const t of store.mem.tasks.values()) {
      if (t.itemId === itemId && t.status === "OPEN" && !t.assignee && t.taskType !== keepTaskType) candidates.push(t.taskId);
    }
  } else {
    const req = await store.request(tx);
    const result = await req
      .input("item_id", sql.NVarChar(100), itemId)
      .input("keep", sql.NVarChar(60), keepTaskType)
      .query(`
        SELECT task_id AS taskId FROM inventory.operational_tasks WITH (UPDLOCK)
        WHERE item_id = @item_id AND status = N'OPEN' AND assignee IS NULL
          AND (@keep IS NULL OR task_type <> @keep);
      `);
    for (const row of result.recordset) candidates.push(row.taskId);
  }
  for (const taskId of candidates) {
    await updateTaskState({ taskId, status: "CANCELLED", note: reason, actor, tx });
    cancelled += 1;
  }
  return cancelled;
}

/**
 * Lists tasks with filters and a bounded page. Returns { items, total, limit, offset }.
 */
async function listTasks({ status = null, taskType = null, assignee = null, itemId = null, recommendationId = null, limit = 100, offset = 0 } = {}) {
  const take = Math.max(1, Math.min(500, Number(limit) || 100));
  const skip = Math.max(0, Number(offset) || 0);

  if (status && !TASK_STATUSES.includes(status)) throw badRequest(`Unknown task status ${status}.`);
  if (taskType && !TASK_TYPES.includes(taskType)) throw badRequest(`Unknown task type ${taskType}.`);

  if (store.isTestMode()) {
    let list = Array.from(store.mem.tasks.values());
    if (status) list = list.filter((t) => t.status === status);
    if (taskType) list = list.filter((t) => t.taskType === taskType);
    if (assignee) list = list.filter((t) => t.assignee === assignee);
    if (itemId) list = list.filter((t) => t.itemId === itemId);
    if (recommendationId) list = list.filter((t) => t.recommendationId === recommendationId);
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { items: list.slice(skip, skip + take).map((t) => mapTaskRow({ ...t })), total: list.length, limit: take, offset: skip };
  }

  const req = await store.request();
  let where = "1 = 1";
  if (status) { req.input("status", sql.NVarChar(40), status); where += " AND status = @status"; }
  if (taskType) { req.input("task_type", sql.NVarChar(60), taskType); where += " AND task_type = @task_type"; }
  if (assignee) { req.input("assignee", sql.NVarChar(120), assignee); where += " AND assignee = @assignee"; }
  if (itemId) { req.input("item_id", sql.NVarChar(100), itemId); where += " AND item_id = @item_id"; }
  if (recommendationId) { req.input("recommendation_id", sql.UniqueIdentifier, recommendationId); where += " AND recommendation_id = @recommendation_id"; }
  req.input("skip", sql.Int, skip).input("take", sql.Int, take);

  const result = await req.query(`
    SELECT COUNT(*) AS total FROM inventory.operational_tasks WHERE ${where};
    SELECT ${TASK_COLUMNS}
    FROM inventory.operational_tasks
    WHERE ${where}
    ORDER BY updated_at DESC, task_id
    OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
  `);
  return {
    items: result.recordsets[1].map(mapTaskRow),
    total: result.recordsets[0][0].total,
    limit: take,
    offset: skip
  };
}

function clearFallbackTasks() {
  store.mem.tasks.clear();
  store.mem.taskHistory.length = 0;
}

module.exports = {
  TASK_TYPES,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_TRANSITIONS,
  ACTIVE_STATUSES,
  dueDateFor,
  taskKey,
  syncOperationalTask,
  findActiveTaskByIdempotencyKey,
  getTask,
  updateTaskState,
  assignShelfCount,
  cancelObsoleteTasks,
  recordTaskHistory,
  listTaskHistory,
  listTasks,
  clearFallbackTasks
};
