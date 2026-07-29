const DEFAULT_POLL_TIME = "08:10";

function parsePollTime(value = DEFAULT_POLL_TIME) {
  const match = String(value).trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Supplier mailbox poll time must use HH:mm format; received ${value}.`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Supplier mailbox poll time must be a valid 24-hour time; received ${value}.`);
  }
  return { hour, minute };
}

function nextLocalRun(now = new Date(), pollTime = DEFAULT_POLL_TIME) {
  const { hour, minute } = parsePollTime(pollTime);
  const next = new Date(now.getTime());
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "system local time";
}

function summarize(result) {
  return [
    `state=${result?.state || "unknown"}`,
    `scanned=${Number(result?.scanned || 0)}`,
    `captured=${Number(result?.captured || 0)}`
  ].join(" ");
}

function resultSummary(result, trigger) {
  return {
    trigger,
    state: result?.state || "unknown",
    scanned: Number(result?.scanned || 0),
    captured: Number(result?.captured || 0),
    resultCount: Array.isArray(result?.results) ? result.results.length : 0
  };
}

function createSupplierMailboxPoller({
  syncMailbox,
  pollTime = process.env.OPTILENS_SUPPLIER_MAILBOX_POLL_TIME || DEFAULT_POLL_TIME,
  now = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console
} = {}) {
  if (typeof syncMailbox !== "function") throw new TypeError("A supplier mailbox sync function is required.");
  parsePollTime(pollTime);

  let timer = null;
  let activeRun = null;
  let state = {
    enabled: false,
    pollTime,
    timeZone: localTimeZone(),
    startedAt: null,
    nextRunAt: null,
    lastRunAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null
  };

  function scheduleNext() {
    if (!state.enabled) return;
    if (timer) clearTimeoutFn(timer);

    const current = now();
    const next = nextLocalRun(current, pollTime);
    const delay = Math.max(0, next.getTime() - current.getTime());
    state = { ...state, nextRunAt: next.toISOString() };
    timer = setTimeoutFn(() => {
      timer = null;
      return runScheduled().catch(() => {});
    }, delay);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function runOnce(trigger = "scheduled") {
    if (activeRun) return activeRun;

    state = { ...state, lastRunAt: now().toISOString(), lastError: null };
    activeRun = Promise.resolve()
      .then(() => syncMailbox({ actorUserId: null }))
      .then((result) => {
        state = {
          ...state,
          lastCompletedAt: now().toISOString(),
          lastResult: resultSummary(result, trigger),
          lastError: null
        };
        logger.log(`Supplier mailbox poll completed (${trigger}): ${summarize(result)}.`);
        return result;
      })
      .catch((error) => {
        state = { ...state, lastResult: null, lastError: error.message };
        logger.error(`Supplier mailbox poll failed (${trigger}): ${error.message}`);
        throw error;
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  }

  async function runScheduled() {
    try {
      return await runOnce("scheduled");
    } finally {
      scheduleNext();
    }
  }

  function start() {
    if (state.enabled) return { ...state, running: Boolean(activeRun) };
    state = { ...state, enabled: true, startedAt: now().toISOString() };
    scheduleNext();
    logger.log(`Supplier mailbox poller scheduled daily at ${pollTime} (${state.timeZone}). Next run: ${state.nextRunAt}.`);
    return { ...state, running: Boolean(activeRun) };
  }

  function stop() {
    if (timer) clearTimeoutFn(timer);
    timer = null;
    state = { ...state, enabled: false, nextRunAt: null };
    return { ...state, running: Boolean(activeRun) };
  }

  function status() {
    const detail = state.lastError
      ? `Last poll failed: ${state.lastError}`
      : state.lastResult
        ? `Last poll ${state.lastResult.state}: ${state.lastResult.captured} message(s) captured.`
        : `Scheduled daily at ${state.pollTime}.`;
    return { ...state, running: Boolean(activeRun), detail };
  }

  return { start, stop, status, runNow: () => runOnce("manual") };
}

function startSupplierMailboxPoller(options = {}) {
  const { syncMailbox } = require("./service");
  return createSupplierMailboxPoller({ syncMailbox, ...options });
}

module.exports = {
  DEFAULT_POLL_TIME,
  createSupplierMailboxPoller,
  nextLocalRun,
  parsePollTime,
  startSupplierMailboxPoller
};
