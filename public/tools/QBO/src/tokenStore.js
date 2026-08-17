'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_PATH = path.join(DATA_DIR, 'tokens.json');

/**
 * Persist the token fields Intuit documents, plus realmId from the callback.
 * @see https://github.com/intuit/oauth-jsclient (Getter / Setter for Token)
 */
function toRecord(token, previous) {
  const data = token && typeof token.getToken === 'function' ? token.getToken() : token || {};
  const prev = previous || {};
  return {
    token_type: data.token_type,
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token,
    x_refresh_token_expires_in: data.x_refresh_token_expires_in,
    id_token: data.id_token || '',
    createdAt: data.createdAt,
    realmId: data.realmId || prev.realmId,
  };
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

function saveToken(token) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const record = toRecord(token, loadToken());
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return record;
}

module.exports = {
  TOKEN_PATH,
  loadToken,
  saveToken,
};
