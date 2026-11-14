'use strict';

const sql = require('mssql');
const { getSourcePool } = require('./db');
const innova = require('./innova-api-client');
const { recordAuditEvent } = require('./audit');

const clean = (value) => String(value ?? '').trim();
const key = (value) => clean(value).toLowerCase();
const review = (message) => Object.assign(new Error(message), { review: true });

function identity(account, name) {
  account = clean(account);
  name = clean(name);
  if (!account || account.length > 120 || !name || name.length > 300) {
    throw review('Provide a valid customer account and name.');
  }
  return { account, name };
}

async function locked(pool, work) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const { recordset } = await tx.request().query(`
      DECLARE @result int;
      EXEC @result = sp_getapplock @Resource=N'qbo.customer-creation', @LockMode=N'Exclusive',
        @LockOwner=N'Transaction', @LockTimeout=15000;
      SELECT @result AS result;
    `);
    if (recordset[0].result < 0) throw new Error('Customer sync is busy. Retry the run.');
    return await work();
  } finally {
    await tx.rollback();
  }
}

async function lookupSource({ account, name }) {
  const pool = await getSourcePool();
  const { recordset } = await pool.request().input('account', sql.NVarChar(120), account)
    .input('name', sql.NVarChar(300), name).query(`
      SELECT TOP (2) CustomerID AS id, AccountNumber AS account, CustomerName AS name, IsActive AS active
      FROM dbo.Customers
      WHERE LTRIM(RTRIM(AccountNumber))=@account OR LTRIM(RTRIM(CustomerName))=@name
    `);
  if (recordset.length > 1) throw review('Innovations has conflicting account or name matches. Verify the customer master.');
  const customer = recordset[0];
  if (!customer) return null;
  if (key(customer.account) !== key(account)) throw review('Innovations has a name-only match. Verify its account number.');
  if (!customer.active || !customer.id) throw review('Innovations customer is inactive or incomplete.');
  identity(customer.account, customer.name);
  return customer;
}

async function createSource({ account, name }, config) {
  const result = await innova.request('POST', '/customers', { config, body: {
    customer: { accountNumber: account, name, isActive: true }
  } });
  return result.data?.customer?.ID;
}

function customerRequest(pool, customer) {
  return pool.request().input('account', sql.NVarChar(120), customer.account)
    .input('name', sql.NVarChar(300), customer.name);
}

async function saveCustomer(pool, realmId, customer, { sourceId = null, actorUserId = null } = {}) {
  // Save the customer and company-scoped job atomically. Caller holds the app lock.
  const { recordset } = await customerRequest(pool, customer)
    .input('sourceId', sql.Int, sourceId).input('actor', sql.UniqueIdentifier, actorUserId)
    .input('realm', sql.NVarChar(80), realmId).query(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @id uniqueidentifier, @created bit=0;
      SELECT @id=customer_id FROM qbo.local_customers WHERE account=@account;
      IF EXISTS (SELECT 1 FROM qbo.local_customers WHERE
        (account<>@account AND (customer_name=@name OR innovations_id=@sourceId))
        OR (account=@account AND ((@sourceId IS NOT NULL AND innovations_id<>@sourceId)
          OR (@sourceId IS NULL AND customer_name<>@name))))
        THROW 50001, 'Local customer identity conflicts. Review the saved account and name.', 1;
      IF @id IS NULL
      BEGIN
        SET @id=NEWID();
        SET @created=1;
        INSERT INTO qbo.local_customers (customer_id,account,customer_name,innovations_id,origin,actor_user_id,innovations_state)
        VALUES (@id,@account,@name,@sourceId,CASE WHEN @sourceId IS NULL THEN N'local' ELSE N'innovations' END,
          @actor,CASE WHEN @sourceId IS NULL THEN N'pending' ELSE N'linked' END);
      END
      IF @sourceId IS NOT NULL
        UPDATE qbo.local_customers SET innovations_id=@sourceId, innovations_state=N'linked', innovations_error=NULL WHERE customer_id=@id;
      IF NOT EXISTS (SELECT 1 FROM qbo.customer_jobs WHERE realm_id=@realm AND customer_id=@id)
        INSERT INTO qbo.customer_jobs (realm_id,customer_id) VALUES (@realm,@id);
      COMMIT;
      SELECT *, @created AS was_created FROM qbo.local_customers WHERE customer_id=@id;
    `).catch((error) => {
      if (error.number === 50001) throw review(error.message);
      throw error;
    });
  return recordset[0];
}

async function audit(row, destination, outcome, reason = null) {
  await recordAuditEvent({
    moduleCode: 'automation', actorUserId: row.actor_user_id,
    eventType: 'automation.customer_sync', entityType: 'LocalCustomer', entityId: row.customer_id,
    eventData: { origin: row.origin, destination, outcome, reason }
  });
}

async function syncDestination({ reconcile, create, markAttempt, uncertain, idempotent }) {
  const existing = await reconcile();
  if (existing) return { value: existing, outcome: 'linked' };
  if (uncertain && !idempotent) {
    throw review('An Innovations create was attempted and is not yet visible. Verify the account in Innovations before retrying.');
  }
  await markAttempt();
  return { value: await create(), outcome: 'created' };
}

async function syncSource(pool, row, adapters = { lookupSource, createSource }) {
  if (row.innovations_state === 'linked') return;
  const customer = { account: row.account, name: row.customer_name };
  const state = (value, reason = null, id = null) => pool.request()
    .input('local', sql.UniqueIdentifier, row.customer_id).input('state', sql.NVarChar(20), value)
    .input('reason', sql.NVarChar(500), reason).input('id', sql.Int, id)
    .query(`UPDATE qbo.local_customers SET innovations_state=@state, innovations_error=@reason,
      innovations_id=COALESCE(@id, innovations_id) WHERE customer_id=@local`);
  let attempted = ['attempted', 'uncertain'].includes(row.innovations_state);
  let config;
  let result;
  try {
    result = await syncDestination({
      reconcile: () => adapters.lookupSource(customer),
      create: async () => {
        const id = await adapters.createSource(customer, config);
        const verified = await adapters.lookupSource(customer);
        if (!id || String(id) !== String(verified?.id)) throw new Error('Verify the created Innovations account in the customer master.');
        return verified;
      },
      markAttempt: async () => {
        if (process.env.OPTILENS_INNOVATIONS_CUSTOMER_CREATE_ENABLED !== 'true') throw new Error('Enable authorized Innovations customer creation to process this job.');
        config = innova.getConfig();
        if (!config) throw new Error('Configure InnovaAPI before creating customers.');
        await innova.getToken(config);
        await state('attempted');
        attempted = true;
      },
      uncertain: attempted
    });
  } catch (error) {
    if ([400, 401, 403, 422, 429].includes(error.statusCode)) attempted = false;
    const reason = error.review || !attempted && !error.statusCode ? error.message.slice(0, 500)
      : attempted ? 'Innovations create outcome is uncertain. Reconcile the customer master.'
        : `Innovations rejected customer creation (HTTP ${error.statusCode}). Check configuration and customer details.`;
    await state(attempted ? 'uncertain' : error.review ? 'review' : 'pending', reason);
    await audit(row, 'innovations', error.review ? 'review' : 'failed', reason);
    return;
  }
  await state('linked', null, result.value.id);
  await audit(row, 'innovations', result.outcome);
}

module.exports = { identity, key, review, locked, lookupSource, saveCustomer, audit, syncDestination, syncSource };
