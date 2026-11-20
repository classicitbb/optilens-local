const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentService, reviewWindow, readPages } = require('../lib/qbo-payment-service');
const { createPaymentRoutes } = require('../lib/qbo-payment-routes');
test('review windows reject invalid dates and unbounded requests', () => {
  for (const options of [{ from: '2026-02-30' }, { from: '9999-99-99' }, { limit: '101' }, { limit: '-1' }, { from: '2026-11-19', to: '2026-11-18' }, { from: '2020-01-01', to: '2026-11-19' }]) assert.throws(() => reviewWindow(options), { statusCode: 400 });
});
test('pagination records incomplete evidence at cap', async () => {
  let calls = 0;
  const result = await readPages({ query: async () => { calls++; return { Payment: Array(1000).fill({ Id: 'x' }) }; } }, 'Payment');
  assert.equal(calls, 10); assert.equal(result.complete, false);
});
test('read service uses only source projections, company read, mappings and QBO SELECT queries', async () => {
  const statements = [];
  const sourceRow = { id: 42, date: '2026-11-19', account: 'TEST', customer: 'Synthetic', amount: '100.0000', discount: '0.0000', allowance: '0.0000', methodCode: 2 };
  const sourcePool = { request: () => ({ input() { return this; }, async query(query) {
    statements.push(query); return { recordsets: [[sourceRow], [{ paymentId: 42, invoiceNumber: 1001, amount: '100.0000' }]] };
  } }) };
  const appPool = { request: () => ({ input(name, realm) { assert.equal(realm, 'company-test'); return this; }, async query(q) { statements.push(q); return { recordset: [{ source_account: 'TEST', qbo_customer_id: '9' }] }; } }) };
  const qbo = { environment: 'sandbox', realmId: 'company-test', async query(q) {
    statements.push(q);
    return q.includes('FROM Invoice') ? { Invoice: [{ Id: '11', DocNumber: '1001', CustomerRef: { value: '9' }, Balance: 100 }] } : {};
  } };
  const service = createPaymentService({ getSourcePool: async () => sourcePool, getAppPool: async () => appPool, openQboReadConnection: async () => qbo });
  const result = await service.review({ from: '2026-11-19', to: '2026-11-19' });
  assert.equal(result.rows[0].status, 'ready'); assert.equal(result.readOnly, true);
  assert.ok(statements.some((q) => q.includes('FROM CompanyInfo')));
  assert.ok(statements.some((q) => q.includes("DocNumber = '1001'")));
  assert.ok(statements.every((q) => !/\b(?:UPDATE|DELETE|INSERT|MERGE)\b/i.test(q)));
  assert.ok(!statements[0].includes('CardExpiry')); assert.ok(!statements[0].includes('p.AccountNumber'));
});
test('payments route requires read permission and rejects all writes', async () => {
  let reads = 0, permission;
  const route = createPaymentRoutes({ loadReview: async () => { reads++; return { readOnly: true }; } });
  const invoke = (method, requirePermission = async (_, p) => { permission = p; }) => route({ req: { method }, res: {}, url: new URL('http://test/api/automation/qbo-payments/review'), requirePermission, handleApi: async (_, fn) => fn() });
  assert.equal(await invoke('GET'), true); assert.equal(permission, 'automation.read');
  await assert.rejects(invoke('POST'), { statusCode: 405 });
  await assert.rejects(invoke('GET', async () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); }), { statusCode: 403 });
  assert.equal(reads, 1);
});
test('route sanitizes connector failures without exposing private details', async () => {
  const route = createPaymentRoutes({ loadReview: async () => { throw new Error('private connection details'); } });
  await assert.rejects(route({ req: { method: 'GET' }, res: {}, url: new URL('http://test/api/automation/qbo-payments/review'), requirePermission: async () => {}, handleApi: async (_, fn) => fn() }), (error) => error.statusCode === 503 && !error.message.includes('private connection details'));
});
