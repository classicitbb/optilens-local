'use strict';
const { claimAndExchange } = require('../lib/qbo-oauth-exchange');
const transactionId = process.argv[2];
if (!transactionId) throw new Error('Usage: npm run qbo:auth:exchange -- <transaction-id>');
claimAndExchange(transactionId).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
