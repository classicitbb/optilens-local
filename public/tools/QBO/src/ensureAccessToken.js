'use strict';
const { createClient } = require('./client');
const { loadToken, saveToken } = require('./tokenStore');

async function ensureAccessToken() {
  const stored = loadToken();
  if (!stored || !stored.refresh_token) {
    throw new Error(
      'No tokens found. Run the start script and open /connect.'
    );
  }

  const oauthClient = createClient();
  oauthClient.setToken(stored);

  if (!oauthClient.isAccessTokenValid()) {
    const authResponse = await oauthClient.refresh();
    saveToken(authResponse.getToken());
  }

  return oauthClient;
}

module.exports = { ensureAccessToken };
