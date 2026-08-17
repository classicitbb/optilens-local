'use strict';

const OAuthClient = require('intuit-oauth');
const config = require('./config');

/**
 * Build an Intuit OAuthClient from env (official constructor options).
 * Token endpoint used by the SDK:
 *   POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *
 * @see https://github.com/intuit/oauth-jsclient
 */
function createClient() {
  return new OAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    environment: config.environment,
    redirectUri: config.redirectUri,
    logging: false,
  });
}

module.exports = {
  OAuthClient,
  createClient,
};
