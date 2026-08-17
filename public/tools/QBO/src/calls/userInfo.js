'use strict';

const { ensureAccessToken } = require('../ensureAccessToken');
const { logIntuitError } = require('../errors');

async function main() {
  try {
    const oauthClient = await ensureAccessToken();
    const response = await oauthClient.makeApiCall({
      url: 'https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo',
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    console.log(JSON.stringify(response.json || response.data, null, 2));
  } catch (error) {
    logIntuitError(error);
    process.exit(1);
  }
}

main();
