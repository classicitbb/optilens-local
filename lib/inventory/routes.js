/**
 * Inventory Intelligence HTTP routes (internal staff only).
 *
 * Every route requires an authenticated session. Reads need inventory.read,
 * delivery.read (the existing Business Metrics read authority) or platform.admin;
 * anything that changes state needs inventory.write or platform.admin. There is no
 * customer-facing route, no public variant and no portal projection.
 *
 * Errors: only InventoryError messages reach the caller. Anything else (SQL
 * errors, connection details) is logged and replaced with a generic message.
 *
 * Mutations accept an `Idempotency-Key` header; a repeat returns the first result.
 */

const {
  listRecommendations, getRecommendation, listRevisions, approveRecommendation, editAndApproveRecommendation,
  rejectRecommendation, completeReview, approveMany, approveAllEligible
} = require("./recommendations-service");
const { listTasks, getTask, updateTaskState, assignShelfCount, listTaskHistory } = require("./task-service");
const { getSettingHistory, getActiveSetting } = require("./settings-service");
const { generateDraftPoPreview } = require("./draft-po-service");
const { listInventoryAudit } = require("./audit-service");
const { getLatestScanStatus, listScanRuns, requestFullScan, triggerRecalculationEvent, scheduleDrain } = require("./scan-runner");
const { recordStockCount, listStockCounts } = require("./count-service");
const { listConfidenceHistory } = require("./confidence-store");
const { listRequests, EVENT_TYPES } = require("./events");
const { runIdempotent } = require("./idempotency");
const { getCockpitSummary } = require("./summary");
const { loadLensIdentity } = require("./source-adapter");
const db = require("../db");
const { toSafeError, badRequest, forbidden, notFound } = require("./errors");

const BASE = "/api/inventory-intelligence/";
const READ_PERMISSIONS = ["inventory.read", "delivery.read", "platform.admin"];
const WRITE_PERMISSIONS = ["inventory.write", "platform.admin"];
const ITEM_EVENT_TYPES = EVENT_TYPES.filter((t) => t.startsWith("EVENT_"));
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function hasAny(user, permissions) {
  const held = new Set(user.permissions || []);
  return permissions.some((p) => held.has(p));
}

function actorOf(user) {
  return String(user.username || user.userId || "unknown");
}

function intParam(url, name, fallback, { min = 0, max = 500 } = {}) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw badRequest(`${name} must be a whole number.`);
  return Math.max(min, Math.min(max, value));
}

function requireGuid(value, label) {
  if (!GUID.test(String(value || ""))) throw badRequest(`${label} is not a valid identifier.`);
  return String(value);
}

function stringBody(body, name, { max = 500, required = false } = {}) {
  const value = body[name];
  if (value == null || value === "") {
    if (required) throw badRequest(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw badRequest(`${name} must be text.`);
  if (value.length > max) throw badRequest(`${name} must be ${max} characters or fewer.`);
  return value;
}

/**
 * Handles /api/inventory-intelligence/*. Returns true when the request was handled.
 */
async function handleInventoryRoute({ req, res, url, readJsonBody, currentUser, sendJson }) {
  if (!url.pathname.startsWith(BASE)) return false;
  const path = url.pathname.slice(BASE.length).replace(/\/+$/, "");
  const method = req.method;

  const reply = async (action, status = 200) => {
    try {
      sendJson(res, await action(), status);
    } catch (error) {
      const safe = toSafeError(error);
      sendJson(res, { error: safe.message, code: safe.code }, safe.statusCode);
    }
  };

  const read = async () => {
    const user = await currentUser(req);
    if (!hasAny(user, READ_PERMISSIONS)) throw forbidden("You do not have permission to view Inventory Intelligence.");
    return user;
  };

  const write = async () => {
    const user = await currentUser(req);
    if (!hasAny(user, WRITE_PERMISSIONS)) throw forbidden("You do not have permission to change Inventory Intelligence.");
    return user;
  };

  /** Runs a mutation once per Idempotency-Key and marks replays. */
  const mutate = async (operation, user, fn) => {
    const { result, replayed } = await runIdempotent({
      key: req.headers["idempotency-key"],
      operation,
      actor: actorOf(user),
      fn
    });
    // A decision or count may have queued a recalculation; process it shortly, in the background.
    if (!replayed) scheduleDrain({ actor: actorOf(user) });
    return replayed && result && typeof result === "object" ? { ...result, replayed: true } : result;
  };

  /* ───── reads ───── */

  if (path === "summary" && method === "GET") {
    await reply(async () => {
      const user = await read();
      const summary = await getCockpitSummary();
      return { ...summary, capabilities: { canApprove: hasAny(user, WRITE_PERMISSIONS) } };
    });
    return true;
  }

  if (path === "queue" && method === "GET") {
    await reply(async () => {
      await read();
      return listRecommendations({
        queue: url.searchParams.get("queue") || "ALL",
        status: url.searchParams.get("status") || "ACTIVE",
        search: url.searchParams.get("search") || "",
        sortBy: url.searchParams.get("sortBy") || "onHand",
        sortDir: url.searchParams.get("sortDir") || "ASC",
        limit: intParam(url, "limit", 50, { min: 1, max: 200 }),
        offset: intParam(url, "offset", 0, { min: 0, max: 1000000 })
      });
    });
    return true;
  }

  if (path === "item-identity" && method === "GET") {
    await reply(async () => {
      await read();
      const itemId = url.searchParams.get("itemId") || "";
      return { identity: await loadLensIdentity(itemId) };
    });
    return true;
  }

  if (path === "assignees" && method === "GET") {
    await reply(async () => {
      await write();
      const pool = await db.getAppPool();
      const result = await pool.request().query(`
        SELECT username, display_name AS displayName
        FROM core.users
        WHERE is_active = 1 AND username <> N'local-dashboard'
        ORDER BY display_name, username;
      `);
      return { users: result.recordset.map((row) => ({ username: row.username, displayName: row.displayName })) };
    });
    return true;
  }

  const detail = path.match(/^recommendations\/([^/]+)$/);
  if (detail && method === "GET" && detail[1] !== "approve-all" && detail[1] !== "approve-selected") {
    await reply(async () => {
      await read();
      const id = requireGuid(decodeURIComponent(detail[1]), "Recommendation");
      const recommendation = await getRecommendation(id);
      if (!recommendation) throw notFound("That recommendation was not found.");
      const task = recommendation.linkedTaskId ? await getTask(recommendation.linkedTaskId) : null;
      const [taskHistory, activeSetting, settingHistory, revisions, audit, counts, confidenceHistory] = await Promise.all([
        task ? listTaskHistory(task.taskId) : [],
        getActiveSetting(recommendation.itemId),
        getSettingHistory(recommendation.itemId),
        listRevisions(recommendation.itemId),
        listInventoryAudit({ recommendationId: id, limit: 100 }),
        listStockCounts(recommendation.itemId, 5),
        listConfidenceHistory(recommendation.itemId, 5)
      ]);
      return { recommendation, task, taskHistory, activeSetting, settingHistory, revisions, audit, counts, confidenceHistory };
    });
    return true;
  }

  if (path === "tasks" && method === "GET") {
    await reply(async () => {
      await read();
      return listTasks({
        status: url.searchParams.get("status") || null,
        taskType: url.searchParams.get("taskType") || null,
        assignee: url.searchParams.get("assignee") || null,
        itemId: url.searchParams.get("itemId") || null,
        limit: intParam(url, "limit", 100, { min: 1, max: 500 }),
        offset: intParam(url, "offset", 0, { min: 0, max: 1000000 })
      });
    });
    return true;
  }

  const taskDetail = path.match(/^tasks\/([^/]+)$/);
  if (taskDetail && method === "GET" && taskDetail[1] !== "assign-shelf-count") {
    await reply(async () => {
      await read();
      const id = requireGuid(decodeURIComponent(taskDetail[1]), "Task");
      const task = await getTask(id);
      if (!task) throw notFound("That task was not found.");
      return { task, history: await listTaskHistory(id) };
    });
    return true;
  }

  const settingsHistory = path.match(/^settings\/(.+)\/history$/);
  if (settingsHistory && method === "GET") {
    await reply(async () => {
      await read();
      const itemId = decodeURIComponent(settingsHistory[1]);
      return { itemId, active: await getActiveSetting(itemId), history: await getSettingHistory(itemId) };
    });
    return true;
  }

  if (path === "draft-po" && method === "GET") {
    await reply(async () => {
      const user = await read();
      return generateDraftPoPreview({ supplierId: url.searchParams.get("supplierId") || null, actor: actorOf(user) });
    });
    return true;
  }

  if (path === "audit" && method === "GET") {
    await reply(async () => {
      await read();
      const recommendationId = url.searchParams.get("recommendationId");
      const taskId = url.searchParams.get("taskId");
      const scanRunId = url.searchParams.get("scanRunId");
      return {
        auditEvents: await listInventoryAudit({
          entityType: url.searchParams.get("entityType") || null,
          entityId: url.searchParams.get("entityId") || null,
          recommendationId: recommendationId ? requireGuid(recommendationId, "recommendationId") : null,
          taskId: taskId ? requireGuid(taskId, "taskId") : null,
          scanRunId: scanRunId ? requireGuid(scanRunId, "scanRunId") : null,
          action: url.searchParams.get("action") || null,
          limit: intParam(url, "limit", 100, { min: 1, max: 500 }),
          offset: intParam(url, "offset", 0, { min: 0, max: 1000000 })
        })
      };
    });
    return true;
  }

  if (path === "scan/status" && method === "GET") {
    await reply(async () => {
      await read();
      const [latestScan, pastRuns, pendingRequests] = await Promise.all([
        getLatestScanStatus(), listScanRuns(intParam(url, "limit", 10, { min: 1, max: 50 })), listRequests({ status: "PENDING", limit: 50 })
      ]);
      return { latestScan, pastRuns, pendingRequests: pendingRequests.length };
    });
    return true;
  }

  /* ───── decisions ───── */

  if (path === "recommendations/approve-all" && method === "POST") {
    await reply(async () => {
      const user = await write();
      const body = await readJsonBody(req);
      return mutate("approve-all", user, () => approveAllEligible({ queue: body.queue, actor: actorOf(user) }));
    });
    return true;
  }

  if (path === "recommendations/approve-selected" && method === "POST") {
    await reply(async () => {
      const user = await write();
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.recommendationIds) ? body.recommendationIds : null;
      if (!ids || ids.length === 0) throw badRequest("Select at least one recommendation.");
      if (ids.length > 200) throw badRequest("Approve at most 200 recommendations at a time.");
      ids.forEach((id) => requireGuid(id, "Recommendation"));
      return mutate("approve-selected", user, () => approveMany({
        recommendationIds: Array.from(new Set(ids)), actor: actorOf(user), reason: stringBody(body, "reason") || "Approved from the work queue"
      }));
    });
    return true;
  }

  const decision = path.match(/^recommendations\/([^/]+)\/(approve|edit-and-approve|reject|complete)$/);
  if (decision && method === "POST") {
    await reply(async () => {
      const user = await write();
      const recommendationId = requireGuid(decodeURIComponent(decision[1]), "Recommendation");
      const action = decision[2];
      const body = await readJsonBody(req).catch(() => ({}));
      const actor = actorOf(user);

      return mutate(`${action}:${recommendationId}`, user, async () => {
        if (action === "approve") {
          return approveRecommendation({ recommendationId, reason: stringBody(body, "reason"), actor });
        }
        if (action === "edit-and-approve") {
          return editAndApproveRecommendation({
            recommendationId,
            orderPoint: body.orderPoint, reorderQuantity: body.reorderQuantity, leadTimeDays: body.leadTimeDays,
            leadTimeOverrideReason: stringBody(body, "leadTimeOverrideReason"),
            minOrderQty: body.minOrderQty, packMultiple: body.packMultiple, safetyStock: body.safetyStock,
            supplierId: stringBody(body, "supplierId", { max: 100 }), supplierName: stringBody(body, "supplierName", { max: 200 }),
            reason: stringBody(body, "reason"), actor
          });
        }
        if (action === "reject") {
          return rejectRecommendation({ recommendationId, reason: stringBody(body, "reason"), actor });
        }
        return completeReview({ recommendationId, reason: stringBody(body, "reason"), actor });
      });
    });
    return true;
  }

  /* ───── tasks ───── */

  if (path === "tasks/assign-shelf-count" && method === "POST") {
    await reply(async () => {
      const user = await write();
      const body = await readJsonBody(req);
      return mutate(`assign-shelf-count:${body.itemId}`, user, async () => ({
        task: await assignShelfCount({
          itemId: stringBody(body, "itemId", { max: 100, required: true }),
          recommendationId: body.recommendationId ? requireGuid(body.recommendationId, "Recommendation") : null,
          assignee: stringBody(body, "assignee", { max: 120 }),
          dueDate: stringBody(body, "dueDate", { max: 10 }),
          note: stringBody(body, "note", { max: 1000 }),
          actor: actorOf(user)
        })
      }));
    });
    return true;
  }

  const taskAction = path.match(/^tasks\/([^/]+)\/(assign|count-result)$/);
  if (taskAction && method === "POST") {
    await reply(async () => {
      const user = await write();
      const taskId = requireGuid(decodeURIComponent(taskAction[1]), "Task");
      const body = await readJsonBody(req);
      return mutate(`${taskAction[2]}:${taskId}`, user, async () => {
        if (taskAction[2] === "assign") {
          return {
            task: await updateTaskState({
              taskId,
              status: stringBody(body, "status", { max: 40 }) || null,
              assignee: body.assignee === undefined ? undefined : (body.assignee === null ? null : stringBody(body, "assignee", { max: 120 }) ?? null),
              priority: stringBody(body, "priority", { max: 20 }) || null,
              dueDate: body.dueDate === undefined ? undefined : (body.dueDate || null),
              note: stringBody(body, "note", { max: 1000 }) || null,
              actor: actorOf(user)
            })
          };
        }
        const task = await getTask(taskId);
        if (!task) throw notFound("That task was not found.");
        return {
          count: await recordStockCount({
            itemId: task.itemId, taskId, countedQuantity: body.countedQuantity, systemQuantity: body.systemQuantity,
            note: stringBody(body, "note", { max: 500 }), actor: actorOf(user)
          })
        };
      });
    });
    return true;
  }

  /* ───── scans and events ───── */

  if (path === "scan/run" && method === "POST") {
    await reply(async () => {
      const user = await write();
      return mutate("scan-run", user, () => requestFullScan({ actor: actorOf(user), triggerType: "MANUAL_FULL" }));
    }, 202);
    return true;
  }

  if (path === "recalculate-event" && method === "POST") {
    await reply(async () => {
      const user = await write();
      const body = await readJsonBody(req);
      if (!ITEM_EVENT_TYPES.includes(body.eventType)) throw badRequest(`eventType must be one of ${ITEM_EVENT_TYPES.join(", ")}.`);
      const itemId = stringBody(body, "itemId", { max: 100, required: true });
      return mutate(`recalculate:${body.eventType}:${itemId}`, user, () => triggerRecalculationEvent(
        body.eventType, { itemId, sourceRef: stringBody(body, "sourceRef", { max: 120 }) }, actorOf(user)
      ));
    }, 202);
    return true;
  }

  // Anything else under the prefix is unknown. Say so rather than falling through to static files.
  await reply(async () => { throw notFound("Unknown inventory intelligence endpoint."); });
  return true;
}

module.exports = {
  handleInventoryRoute,
  READ_PERMISSIONS,
  WRITE_PERMISSIONS,
  getCockpitSummary
};
