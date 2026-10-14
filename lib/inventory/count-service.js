/**
 * Shelf-count results.
 *
 * A physical count is evidence, not an edit. Recording one:
 *   - stores the counted quantity next to the system quantity at the time
 *     (inventory.stock_count_results, app-owned and append-only);
 *   - completes the COUNT_SHELF task;
 *   - queues a stock-adjustment recalculation, so the item is re-evaluated by
 *     the same deterministic path as any other event.
 *
 * It does not mutate a recommendation and it does not write to Innovations. If
 * the shelf and the source disagree, the engine says so (the source balance is
 * corrected by people in Innovations); the count simply makes the stock figure
 * "verified as of" a date.
 */

const { randomUUID } = require("node:crypto");
const sql = require("mssql");
const store = require("./store");
const { recordInventoryAudit } = require("./audit-service");
const { findActiveTaskByIdempotencyKey, getTask, updateTaskState, taskKey } = require("./task-service");
const { getLatestRecommendationForItem } = require("./recommendations-service");
const { enqueueRecalculation } = require("./events");
const { badRequest, conflict } = require("./errors");

function wholeNumber(value, label, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    throw badRequest(`${label} is required.`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1000000) {
    throw badRequest(`${label} must be a whole number of zero or more.`);
  }
  return number;
}

/**
 * Records a physical count for an item. `systemQuantity` defaults to the on-hand
 * figure the latest recommendation was based on.
 */
async function recordStockCount({ itemId, countedQuantity, systemQuantity = null, taskId = null, note = null, actor }) {
  if (!itemId) throw badRequest("An item is required to record a count.");
  if (!actor) throw badRequest("The person recording the count is required.");
  const counted = wholeNumber(countedQuantity, "Counted quantity");
  let system = wholeNumber(systemQuantity, "System quantity", { allowNull: true });

  return store.withTransaction(async (tx) => {
    if (system === null) {
      const latest = await getLatestRecommendationForItem(itemId, { tx });
      const onHand = latest && latest.evidence ? latest.evidence.onHand : null;
      system = Number.isFinite(onHand) ? onHand : null;
    }

    let task = null;
    if (taskId) {
      task = await getTask(taskId, { tx, lock: true });
      if (!task || task.itemId !== itemId || task.taskType !== "COUNT_SHELF") {
        throw badRequest("That task is not a shelf-count task for this item.");
      }
      if (!["OPEN", "ASSIGNED", "IN_PROGRESS", "BLOCKED", "PENDING_APPROVAL"].includes(task.status)) {
        throw conflict("A count has already been recorded for this task.", "ALREADY_RECORDED");
      }
    } else {
      task = await findActiveTaskByIdempotencyKey(taskKey(itemId, "COUNT_SHELF"), { tx });
    }

    const countId = randomUUID();
    const countedAt = new Date();
    const record = {
      countId,
      itemId,
      countedQuantity: counted,
      systemQuantity: system,
      variance: system === null ? null : counted - system,
      countedBy: store.clip(actor, 120),
      countedAt: countedAt.toISOString(),
      taskId: task ? task.taskId : null,
      note: store.clip(note, 500)
    };

    if (store.isTestMode()) {
      store.mem.counts.push(record);
    } else {
      const req = await store.request(tx);
      await req
        .input("count_id", sql.UniqueIdentifier, countId)
        .input("item_id", sql.NVarChar(100), itemId)
        .input("counted_quantity", sql.Int, counted)
        .input("system_quantity", sql.Int, system)
        .input("counted_by", sql.NVarChar(120), record.countedBy)
        .input("counted_at", sql.DateTime2, countedAt)
        .input("task_id", sql.UniqueIdentifier, record.taskId)
        .input("note", sql.NVarChar(500), record.note)
        .query(`
          INSERT INTO inventory.stock_count_results (
            count_id, item_id, counted_quantity, system_quantity, counted_by, counted_at, task_id, note
          ) VALUES (
            @count_id, @item_id, @counted_quantity, @system_quantity, @counted_by, @counted_at, @task_id, @note
          );
        `);
    }

    if (task) {
      const summary = record.variance === null
        ? `Counted ${counted}.`
        : `Counted ${counted} against ${system} on the system (variance ${record.variance >= 0 ? "+" : ""}${record.variance}).`;
      await updateTaskState({
        taskId: task.taskId,
        status: "COMPLETED",
        note: note ? `${summary} ${note}` : summary,
        actor, tx
      });
    }

    await recordInventoryAudit({
      taskId: task ? task.taskId : null,
      actor,
      action: "STOCK_COUNT_RECORDED",
      entityType: "StockCount",
      entityId: countId,
      afterState: record,
      reason: note || "Physical shelf count recorded",
      tx
    });

    // A count is a stock-adjustment event: the engine re-evaluates the item through its normal path.
    await enqueueRecalculation({
      eventType: "EVENT_STOCK_ADJUSTMENT",
      itemId,
      sourceRef: `count:${countId}`,
      payload: { countId, countedQuantity: counted, systemQuantity: system },
      actor, tx
    });

    return record;
  });
}

/** The newest count per item, as a Map keyed by item id. */
async function getLatestCounts() {
  const map = new Map();
  if (store.isTestMode()) {
    for (const c of store.mem.counts) {
      const existing = map.get(c.itemId);
      if (!existing || c.countedAt > existing.countedAt) map.set(c.itemId, { ...c });
    }
    return map;
  }
  const req = await store.request();
  const result = await req.query(`
    SELECT itemId, countedQuantity, systemQuantity, countedBy, countedAt FROM (
      SELECT item_id AS itemId, counted_quantity AS countedQuantity, system_quantity AS systemQuantity,
             counted_by AS countedBy, counted_at AS countedAt,
             ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY counted_at DESC) AS rn
      FROM inventory.stock_count_results
    ) latest
    WHERE rn = 1;
  `);
  for (const row of result.recordset) {
    map.set(row.itemId, { ...row, countedAt: store.toIso(row.countedAt) });
  }
  return map;
}

/** Count history for one item, newest first. */
async function listStockCounts(itemId, limit = 20) {
  const take = Math.max(1, Math.min(100, Number(limit) || 20));
  if (store.isTestMode()) {
    return store.mem.counts.filter((c) => c.itemId === itemId).sort((a, b) => String(b.countedAt).localeCompare(String(a.countedAt))).slice(0, take).map((c) => ({ ...c }));
  }
  const req = await store.request();
  const result = await req
    .input("item_id", sql.NVarChar(100), itemId)
    .input("take", sql.Int, take)
    .query(`
      SELECT TOP (@take) count_id AS countId, item_id AS itemId, counted_quantity AS countedQuantity,
             system_quantity AS systemQuantity, counted_by AS countedBy, counted_at AS countedAt,
             task_id AS taskId, note
      FROM inventory.stock_count_results
      WHERE item_id = @item_id
      ORDER BY counted_at DESC;
    `);
  return result.recordset.map((r) => ({
    ...r,
    variance: r.systemQuantity == null ? null : r.countedQuantity - r.systemQuantity,
    countedAt: store.toIso(r.countedAt)
  }));
}

function clearFallbackCounts() {
  store.mem.counts.length = 0;
}

module.exports = { recordStockCount, getLatestCounts, listStockCounts, clearFallbackCounts };
