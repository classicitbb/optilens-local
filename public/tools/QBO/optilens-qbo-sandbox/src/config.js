'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const clientId = process.env.INTUIT_CLIENT_ID;
const clientSecret = process.env.INTUIT_CLIENT_SECRET;

if (!clientId) {
  throw new Error(
    'INTUIT_CLIENT_ID is missing. Copy .env.example to .env and set Keys & OAuth values.'
  );
}

if (!clientSecret) {
  throw new Error(
    'INTUIT_CLIENT_SECRET is missing. Copy .env.example to .env and set the Development client secret from Keys & OAuth. Source never hardcodes the secret.'
  );
}

module.exports = {
  clientId,
  clientSecret,
  environment: process.env.INTUIT_ENVIRONMENT || 'sandbox',
  redirectUri: process.env.INTUIT_REDIRECT_URI || 'http://localhost:8000/callback',
  port: 8000,
};
