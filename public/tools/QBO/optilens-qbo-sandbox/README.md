# Optilens QBO sandbox OAuth 2.0

Local Node.js scaffold using Intuit official intuit-oauth client (authorizeUri, createToken, refresh / refreshUsingToken, makeApiCall).
Token endpoint used by the SDK: POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer.

## Run

1. Copy `.env.example` to `.env`. Set `INTUIT_CLIENT_SECRET` from the app Keys and OAuth tab (Development). Leave `INTUIT_CLIENT_ID` as provided.
2. On Keys and OAuth, add Redirect URI `http://localhost:8000/callback`. The Quick Start URI (`https://developer.intuit.com/app/developer/quickstart`) cannot receive a local callback.
3. Install dependencies, then start the local server (port 8000).
4. Open http://localhost:8000/connect , consent, pick a sandbox company.
5. Then run the company, userinfo, refresh, and charge scripts from package.json.

## Token lifetime

Access tokens last 3600s. Refresh tokens rotate. Always persist the latest refresh_token from the most recent token response (this app writes data/tokens.json, including createdAt and realmId).

## Payments

The charge script POSTs Intuit documented sandbox charge example to https://sandbox.api.intuit.com/quickbooks/v4/payments/charges with Request-Id, Content-Type application/json, and Accept application/json. Currency is USD per Intuit docs.

## Calls

- Company info: GET https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/companyinfo/{realmId}
- User info: GET https://sandbox-accounts.platform.intuit.com/v1/openid_connect/userinfo
- Charge: POST https://sandbox.api.intuit.com/quickbooks/v4/payments/charges

## Docs

- https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
- https://github.com/intuit/oauth-jsclient
- Payments REST features (charge payload): https://developer.intuit.com/app/developer/qbpayments/docs/learn/rest-api-features
