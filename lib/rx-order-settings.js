const ORDER_SETTINGS_KEY_PREFIX = "rx.order-settings.";

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function text(value, label, max, { required = false } = {}) {
  const result = String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
  if (required && !result) throw inputError(`${label} cannot be blank.`);
  return result;
}

function normaliseOrderSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const batchSize = Number(source.batchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw inputError("Number of orders must be a whole number between 1 and 500.");
  }
  const extension = text(source.extension, "Output extension", 12, { required: true }).toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw inputError("Output extension must be a simple extension such as .rx.");
  return {
    batchSize,
    randomSeed: text(source.randomSeed, "Random seed", 120),
    instructions: text(source.instructions, "Instructions", 500, { required: true }),
    custNum: text(source.custNum, "Customer number", 40, { required: true }),
    custSeqNum: text(source.custSeqNum, "Customer sequence", 30, { required: true }),
    shipName: text(source.shipName, "Ship name", 180, { required: true }),
    labNum: text(source.labNum, "Lab number", 30, { required: true }),
    remoteOperator: text(source.remoteOperator, "Remote operator", 80, { required: true }),
    extension
  };
}

function orderSettingsKey(user) {
  const identity = String(user?.userId || user?.username || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 70);
  return `${ORDER_SETTINGS_KEY_PREFIX}${identity}`;
}

function parseOrderSettings(value) {
  if (!value) return null;
  try { return normaliseOrderSettings(JSON.parse(value)); } catch { return null; }
}

module.exports = { normaliseOrderSettings, orderSettingsKey, parseOrderSettings };
