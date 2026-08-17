'use strict';

const crypto = require('crypto');
const { ensureAccessToken } = require('../ensureAccessToken');
const { logIntuitError } = require('../errors');

const CHARGE_URL = 'https://sandbox.api.intuit.com/quickbooks/v4/payments/charges';

// Documented sandbox charge body from Intuit Payments REST API features.
const CHARGE_BODY = {
  amount: '10.55',
  card: {
    expYear: '2020',
    expMonth: '02',
    address: {
      region: 'CA',
      postalCode: '94086',
      streetAddress: '1130 Kifer Rd',
      country: 'US',
      city: 'Sunnyvale',
    },
    name: 'emulate=0',
    cvc: '123',
    number: '4111111111111111',
  },
  currency: 'USD',
  context: {
    mobile: 'false',
    isEcommerce: 'true',
  },
};

async function main() {
  console.warn(
    'WARNING: This posts a sandbox charge using Intuit documented test payload (USD).'
  );
  try {
    const oauthClient = await ensureAccessToken();
    const response = await oauthClient.makeApiCall({
      url: CHARGE_URL,
      method: 'POST',
      headers: {
        'Request-Id': crypto.randomUUID(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(CHARGE_BODY),
    });
    console.log(JSON.stringify(response.json || response.data, null, 2));
  } catch (error) {
    logIntuitError(error);
    process.exit(1);
  }
}

main();
