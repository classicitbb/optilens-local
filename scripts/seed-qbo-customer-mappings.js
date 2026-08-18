#!/usr/bin/env node
'use strict';

const { seedExactCustomerMappings } = require('../lib/qbo-invoice-sync');

seedExactCustomerMappings()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(`QuickBooks customer mapping seed failed: ${error.message}`);
    process.exit(1);
  });
