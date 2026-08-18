'use strict';

const fs = require('fs');
const path = require('path');
const { ensureAccessToken } = require('../ensureAccessToken');
const { logIntuitError } = require('../errors');

const CSV_PATH = path.join(__dirname, '..', '..', 'QBO CSV Import Format..csv');

function csvRows(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = lines.shift().split(',').map((value) => value.trim());
  return lines.map((line) => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === ',' && !quoted) { values.push(value); value = ''; }
      else value += char;
    }
    values.push(value);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function qboBase(realmId) {
  return `https://sandbox-quickbooks.api.intuit.com/v3/company/${encodeURIComponent(realmId)}`;
}

function queryText(value) { return String(value).replaceAll("'", "''"); }

async function api(oauthClient, request) {
  const response = await oauthClient.makeApiCall({
    ...request,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(request.headers || {}) },
  });
  return response.json || response.data;
}

async function query(oauthClient, realmId, sql) {
  const data = await api(oauthClient, {
    url: `${qboBase(realmId)}/query?query=${encodeURIComponent(sql)}`,
    method: 'GET',
  });
  return data.QueryResponse || {};
}

async function create(oauthClient, realmId, resource, payload) {
  return api(oauthClient, {
    url: `${qboBase(realmId)}/${resource.toLowerCase()}`,
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function main() {
  const oauthClient = await ensureAccessToken();
  const token = oauthClient.getToken().getToken();
  const realmId = token.realmId;
  if (!realmId) throw new Error('Missing QBO realmId. Re-authorize via /connect.');

  const rows = csvRows(fs.readFileSync(CSV_PATH, 'utf8'));
  const customerNames = [...new Set(rows.map((row) => row.Customer.trim()).filter(Boolean))].sort();
  const itemNames = [...new Set(rows.map((row) => row['Item (Product/Service)'].trim()).filter(Boolean))].sort();

  const customers = await query(oauthClient, realmId, 'SELECT * FROM Customer MAXRESULTS 1000');
  const items = await query(oauthClient, realmId, 'SELECT * FROM Item MAXRESULTS 1000');
  const accounts = await query(oauthClient, realmId, "SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1000");
  const customerByName = new Map((customers.Customer || []).map((row) => [String(row.DisplayName || '').toLowerCase(), row]));
  const itemByName = new Map((items.Item || []).map((row) => [String(row.Name || '').toLowerCase(), row]));
  const incomeAccount = (accounts.Account || []).find((row) => row.Active !== false && row.Id);
  if (!incomeAccount) throw new Error('No active QBO income account exists for sandbox service items.');

  const result = { realmId, customers: { existing: 0, created: [], failed: [] }, items: { existing: 0, created: [], failed: [] }, incomeAccount: { id: incomeAccount.Id, name: incomeAccount.Name } };

  for (const displayName of customerNames) {
    if (customerByName.has(displayName.toLowerCase())) { result.customers.existing += 1; continue; }
    try {
      const created = await create(oauthClient, realmId, 'customer', { DisplayName: displayName, CompanyName: displayName, Notes: 'OptiLens sandbox fixture; created for invoice-sync testing.' });
      const customer = created.Customer;
      result.customers.created.push({ name: displayName, id: customer?.Id || null });
      if (customer?.Id) customerByName.set(displayName.toLowerCase(), customer);
    } catch (error) { result.customers.failed.push({ name: displayName, error: error.message }); }
  }

  for (const name of itemNames) {
    if (itemByName.has(name.toLowerCase())) { result.items.existing += 1; continue; }
    try {
      const created = await create(oauthClient, realmId, 'item', {
        Name: name,
        Type: 'Service',
        IncomeAccountRef: { value: String(incomeAccount.Id), name: incomeAccount.Name },
        Description: 'OptiLens sandbox fixture for Innovations invoice synchronization.',
      });
      const item = created.Item;
      result.items.created.push({ name, id: item?.Id || null });
      if (item?.Id) itemByName.set(name.toLowerCase(), item);
    } catch (error) { result.items.failed.push({ name, error: error.message }); }
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.customers.failed.length || result.items.failed.length) process.exitCode = 1;
}

main().catch((error) => { logIntuitError(error); process.exit(1); });
