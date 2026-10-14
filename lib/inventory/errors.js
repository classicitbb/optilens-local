/**
 * Error types for Inventory Intelligence.
 *
 * Only InventoryError messages are ever shown to API callers. Anything else
 * (SQL errors, connection strings, stack traces) is logged server-side and
 * replaced with a generic message by toSafeError().
 */

class InventoryError extends Error {
  constructor(message, statusCode = 400, code = "INVENTORY_ERROR") {
    super(message);
    this.name = "InventoryError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

const badRequest = (message, code = "BAD_REQUEST") => new InventoryError(message, 400, code);
const forbidden = (message, code = "FORBIDDEN") => new InventoryError(message, 403, code);
const notFound = (message, code = "NOT_FOUND") => new InventoryError(message, 404, code);
const conflict = (message, code = "CONFLICT") => new InventoryError(message, 409, code);
const unavailable = (message = "Inventory data is currently unavailable.", code = "UNAVAILABLE") =>
  new InventoryError(message, 503, code);

const CONNECTION_CODES = new Set(["ESOCKET", "ETIMEOUT", "ELOGIN", "ECONNCLOSED", "ENOTOPEN", "ECONNRESET", "ETIMEDOUT", "EREQUEST_TIMEOUT"]);

/**
 * Converts any thrown value into a { statusCode, message, code } that is safe to return.
 */
function toSafeError(error) {
  if (error && error.expose === true) {
    return { statusCode: error.statusCode || 400, message: error.message, code: error.code || "INVENTORY_ERROR" };
  }

  // Auth errors thrown by the platform already carry a safe, intentional message.
  if (error && (error.statusCode === 401 || error.statusCode === 403)) {
    return { statusCode: error.statusCode, message: error.message, code: error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" };
  }

  // eslint-disable-next-line no-console
  console.error("[inventory] internal error:", error && error.stack ? error.stack : error);

  if (error && (CONNECTION_CODES.has(error.code) || /not configured|Failed to connect/i.test(String(error.message)))) {
    return { statusCode: 503, message: "Inventory data is currently unavailable.", code: "UNAVAILABLE" };
  }
  return { statusCode: 500, message: "The inventory service could not complete the request.", code: "INTERNAL" };
}

module.exports = {
  InventoryError,
  badRequest,
  forbidden,
  notFound,
  conflict,
  unavailable,
  toSafeError
};
