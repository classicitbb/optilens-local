#!/usr/bin/env node
'use strict';

const { syncInvoices } = require('../lib/qbo-invoice-sync');

syncInvoices({
  dryRun: !process.argv.includes('--apply'),
  trigger: 'scheduled'
}).then((result) => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.counts.failed ? 1 : 0);
}).catch((error) => {
  console.error(`QuickBooks invoice sync failed: ${error.message}`);
  process.exit(1);
});
