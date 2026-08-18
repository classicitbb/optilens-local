'use strict';

const { ensureAccessToken } = require('../ensureAccessToken');
const { logIntuitError } = require('../errors');

// QBO DocNumber is limited to 21 characters. Keep the fixture IDs short.
const DOC_PREFIX = 'OLSBX-260818';

function base(realmId, resource) {
  return `https://sandbox-quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}/${resource}`;
}

async function api(client, request) {
  const response = await client.makeApiCall({
    ...request,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(request.headers || {}) },
  });
  return response.json || response.data;
}

async function query(client, realmId, sql) {
  const data = await api(client, { url: `${base(realmId, 'query')}?query=${encodeURIComponent(sql)}`, method: 'GET' });
  return data.QueryResponse || {};
}

async function getByDocNumber(client, realmId, resource, docNumber) {
  const result = await query(client, realmId, `SELECT * FROM ${resource} WHERE DocNumber = '${docNumber}' MAXRESULTS 10`);
  return result[resource] || [];
}

async function create(client, realmId, resource, payload) {
  return api(client, { url: base(realmId, resource.toLowerCase()), method: 'POST', body: JSON.stringify(payload) });
}

async function update(client, realmId, resource, payload) {
  return api(client, { url: base(realmId, resource.toLowerCase()), method: 'POST', body: JSON.stringify(payload) });
}

async function main() {
  const client = await ensureAccessToken();
  const realmId = client.getToken().getToken().realmId;
  const customerResult = await query(client, realmId, "SELECT * FROM Customer WHERE DisplayName = 'Ideal Optical - IDO' MAXRESULTS 10");
  const itemResult = await query(client, realmId, "SELECT * FROM Item WHERE Name = 'Rx Orders - Local' MAXRESULTS 10");
  const creditItemResult = await query(client, realmId, "SELECT * FROM Item WHERE Name = 'Rx Credit Orders - Local' MAXRESULTS 10");
  const customer = customerResult.Customer?.[0];
  const item = itemResult.Item?.[0];
  const creditItem = creditItemResult.Item?.[0];
  if (!customer?.Id || !item?.Id || !creditItem?.Id) throw new Error('Seeded sandbox customer or item is missing. Run npm run seed:sandbox first.');

  const invoiceDocNumber = `${DOC_PREFIX}-INV`;
  const creditDocNumber = `${DOC_PREFIX}-CR`;
  const invoiceLine = {
    DetailType: 'SalesItemLineDetail',
    Amount: 177.50,
    Description: 'YEARWOOD, MARISSA · OptiLens sandbox invoice test',
    SalesItemLineDetail: {
      ItemRef: { value: String(item.Id), name: item.Name },
      Qty: 1,
      UnitPrice: 177.50,
      TaxCodeRef: { value: 'NON', name: 'NON' },
    },
  };
  const creditLine = {
    DetailType: 'SalesItemLineDetail',
    Amount: 50,
    Description: 'Sandbox credit test referencing the invoice fixture',
    SalesItemLineDetail: {
      ItemRef: { value: String(creditItem.Id), name: creditItem.Name },
      Qty: 1,
      UnitPrice: 50,
      TaxCodeRef: { value: 'NON', name: 'NON' },
    },
  };
  const invoicePayload = {
    DocNumber: invoiceDocNumber,
    TxnDate: '2026-08-17',
    DueDate: '2026-09-16',
    CustomerRef: { value: String(customer.Id), name: customer.DisplayName },
    Line: [invoiceLine],
    GlobalTaxCalculation: 'NotApplicable',
    PrivateNote: 'OptiLens sandbox test. Innovations invoice fixture 89916.',
  };
  const creditPayload = {
    DocNumber: creditDocNumber,
    TxnDate: '2026-08-17',
    CustomerRef: { value: String(customer.Id), name: customer.DisplayName },
    Line: [creditLine],
    GlobalTaxCalculation: 'NotApplicable',
    PrivateNote: `OptiLens sandbox test credit. Intended reference: ${invoiceDocNumber}.`,
  };

  const result = { realmId, taxCodeUsed: 'NON', invoice: {}, creditMemo: {} };
  let invoice = (await getByDocNumber(client, realmId, 'Invoice', invoiceDocNumber))[0];
  if (!invoice) {
    const created = await create(client, realmId, 'Invoice', invoicePayload);
    invoice = created.Invoice;
    result.invoice.created = { id: invoice?.Id, docNumber: invoice?.DocNumber, total: invoice?.TotalAmt, syncToken: invoice?.SyncToken };
  } else result.invoice.existing = { id: invoice.Id, docNumber: invoice.DocNumber, total: invoice.TotalAmt, syncToken: invoice.SyncToken };

  if (!invoice?.Id) throw new Error('QBO invoice creation did not return an invoice.');
  const updatePayload = { ...invoicePayload, Id: invoice.Id, SyncToken: invoice.SyncToken, sparse: true, PrivateNote: 'OptiLens sandbox test updated successfully.' };
  const updated = await update(client, realmId, 'Invoice', updatePayload);
  result.invoice.updated = { id: updated.Invoice?.Id, syncToken: updated.Invoice?.SyncToken, privateNote: updated.Invoice?.PrivateNote };

  const credit = (await getByDocNumber(client, realmId, 'CreditMemo', creditDocNumber))[0];
  if (!credit) {
    const created = await create(client, realmId, 'CreditMemo', creditPayload);
    result.creditMemo.created = { id: created.CreditMemo?.Id, docNumber: created.CreditMemo?.DocNumber, total: created.CreditMemo?.TotalAmt };
  } else result.creditMemo.existing = { id: credit.Id, docNumber: credit.DocNumber, total: credit.TotalAmt };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { logIntuitError(error); process.exit(1); });
