'use strict';

const { ensureAccessToken } = require('../ensureAccessToken');
const { logIntuitError } = require('../errors');

async function query(client, realmId, sql) {
  const url = `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}`;
  const response = await client.makeApiCall({ url, method: 'GET', headers: { Accept: 'application/json' } });
  return response.json?.QueryResponse || response.data?.QueryResponse || {};
}

async function main() {
  const client = await ensureAccessToken();
  const realmId = client.getToken().getToken().realmId;
  const [customers, items, taxCodes] = await Promise.all([
    query(client, realmId, 'SELECT * FROM Customer MAXRESULTS 1000'),
    query(client, realmId, 'SELECT * FROM Item MAXRESULTS 1000'),
    query(client, realmId, 'SELECT * FROM TaxCode MAXRESULTS 1000'),
  ]);
  console.log(JSON.stringify({
    realmId,
    customerCount: customers.maxResults || (customers.Customer || []).length,
    itemCount: items.maxResults || (items.Item || []).length,
    customers: (customers.Customer || []).map(({ Id, DisplayName, Active }) => ({ Id, DisplayName, Active })),
    items: (items.Item || []).map(({ Id, Name, Type, Active, IncomeAccountRef }) => ({ Id, Name, Type, Active, IncomeAccountRef })),
    taxCodes: (taxCodes.TaxCode || []).map(({ Id, Name, Active, Taxable }) => ({ Id, Name, Active, Taxable })),
  }, null, 2));
}

main().catch((error) => { logIntuitError(error); process.exit(1); });
