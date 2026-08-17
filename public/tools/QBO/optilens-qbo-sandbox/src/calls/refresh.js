'use strict';

const { ensureAccessToken } = require('../ensureAccessToken');
const { saveToken } = require('../tokenStore');
const { logIntuitError } = require('../errors');

async function main() {
  try {
    const oauthClient = await ensureAccessToken();
    const authResponse = await oauthClient.refresh();
    const saved = saveToken(authResponse.getToken());
    console.log(JSON.stringify({
      token_type: saved.token_type,
      expires_in: saved.expires_in,
      x_refresh_token_expires_in: saved.x_refresh_token_expires_in,
      createdAt: saved.createdAt,
      realmId: saved.realmId,
      rotated_refresh_token: true,
    }, null, 2));
  } catch (error) {
    logIntuitError(error);
    process.exit(1);
  }
}

main();
