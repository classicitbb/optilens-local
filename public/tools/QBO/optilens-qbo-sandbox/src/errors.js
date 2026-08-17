'use strict';

/**
 * Log Intuit OAuth/API error fields only — never dump tokens or full responses.
 * Official error shape from intuit-oauth:
 *   { error, error_description, intuit_tid, originalMessage }
 * @see https://github.com/intuit/oauth-jsclient#error-logging
 */
function statusFrom(error) {
  if (error == null) {
    return undefined;
  }
  if (error.status != null) {
    return error.status;
  }
  const authResponse = error.authResponse;
  if (!authResponse) {
    return undefined;
  }
  if (typeof authResponse.status === 'function') {
    return authResponse.status();
  }
  if (authResponse.status != null) {
    return authResponse.status;
  }
  if (authResponse.response && authResponse.response.status != null) {
    return authResponse.response.status;
  }
  return undefined;
}

function logIntuitError(error) {
  if (!error) {
    console.error('Unknown Intuit error');
    return;
  }
  if (error.error) {
    console.error('error:', error.error);
  }
  if (error.error_description) {
    console.error('error_description:', error.error_description);
  }
  if (error.intuit_tid) {
    console.error('intuit_tid:', error.intuit_tid);
  }
  const status = statusFrom(error);
  if (status != null) {
    console.error('status:', status);
  }
  if (!error.error && error.message) {
    console.error('message:', error.message);
  }
}

function exitOnError(error) {
  logIntuitError(error);
  process.exit(1);
}

module.exports = {
  logIntuitError,
  exitOnError,
};
