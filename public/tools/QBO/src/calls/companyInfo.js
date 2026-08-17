'use strict';

const { ensureAccessToken } = require('../ensureAccessToken');
const { logIntuitError } = require('../errors');

async function main() {
  try {
    const oauthClient = await ensureAccessToken();
    const token = oauthClient.getToken().getToken();
    const realmId = token.realmId;
    if (!realmId) {
      throw new Error('Missing realmId. Re-authorize via /connect.');
    }
    const url =
      'https://sandbox-quickbooks.api.intuit.com/v3/company/' +
      realmId +
      '/companyinfo/' +
      realmId;
    const response = await oauthClient.makeApiCall({
      url: url,
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
