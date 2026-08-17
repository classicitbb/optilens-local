'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { OAuthClient, createClient } = require('./client');
const { saveToken } = require('./tokenStore');
const { logIntuitError } = require('./errors');

const oauthClient = createClient();
const pendingStates = new Set();
const app = express();

const SCOPES = [
  OAuthClient.scopes.Accounting,
  OAuthClient.scopes.Payment,
  OAuthClient.scopes.OpenId,
  OAuthClient.scopes.Profile,
  OAuthClient.scopes.Email,
  OAuthClient.scopes.Phone,
  OAuthClient.scopes.Address,
];

function homePage() {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Optilens QBO sandbox</title></head>',
    '<body>',
    '<h1>QuickBooks Online sandbox OAuth 2.0</h1>',
    '<p><a href="/connect">Connect to QuickBooks (sandbox)</a></p>',
    '<p>After consent, tokens are saved to <code>data/tokens.json</code>.</p>',
    '<p>Then run, in another terminal:</p>',
    '<ul>',
    '<li><code>company</code> GET companyinfo</li>',
    '<li><code>userinfo</code> GET OpenID userinfo</li>',
    '<li><code>refresh</code> rotate tokens</li>',
    '<li><code>charge</code> POST documented sandbox charge</li>',
    '</ul>',
    '</body></html>'
  ].join('\n');
}

app.get('/', function (_req, res) {
  res.type('html').send(homePage());
});

app.get('/connect', function (_req, res) {
  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.add(state);
  const authUri = oauthClient.authorizeUri({
    scope: SCOPES,
    state: state,
  });
  res.redirect(authUri);
});

function connectedPage(realmId) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Connected</title></head>',
    '<body>',
    '<h1>Authorization complete</h1>',
    '<p>Tokens saved to <code>data/tokens.json</code>.</p>',
    '<p>realmId: <code>' + escapeHtml(String(realmId)) + '</code></p>',
    '<p>Access and refresh tokens are not shown.</p>',
    '<p>You can now run the company, userinfo, refresh, or charge scripts.</p>',
    '<p><a href="/">Home</a></p>',
    '</body></html>'
  ].join('\n');
}

app.get('/callback', async function (req, res) {
  try {
    const state = req.query.state;
    if (!state || !pendingStates.has(state)) {
      res.status(400).send('State mismatch. Start over at /connect.');
      return;
    }
    pendingStates.delete(state);
    const authResponse = await oauthClient.createToken(req.url);
    const token = authResponse.getToken();
    saveToken(token);
    const realmId = token.realmId || '';
    res.type('html').send(connectedPage(realmId));
  } catch (error) {
    logIntuitError(error);
    res.status(500).send('Token exchange failed. See server logs.');
  }
});

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.listen(config.port, function () {
  console.log('Listening on http://localhost:' + config.port);
  console.log('Open /connect to authorize.');
});
