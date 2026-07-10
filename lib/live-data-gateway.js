const { getAppPool, getSourcePool } = require('./db');

const OPERATIONS = Object.freeze([
  'innovations.customer_account',
  'innovations.customer_statement',
  'optilens.customer_deliveries',
]);

const positiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const dateOnly = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

function normalizeRequest(request) {
  if (!request || typeof request !== 'object' || !OPERATIONS.includes(request.operation)) {
    throw Object.assign(new Error(`Unsupported live-data operation '${request && request.operation || ''}'.`), { code: 'unsupported_operation' });
  }
  const rawTarget = request.target && typeof request.target === 'object' ? request.target : {};
  const target = {
    innovationsCustomerId: positiveInteger(rawTarget.innovations_customer_id),
    accountNumber: typeof rawTarget.account_number === 'string' ? rawTarget.account_number.trim().slice(0, 120) : '',
  };
  if (!target.innovationsCustomerId && !target.accountNumber) {
    throw Object.assign(new Error('The request has no customer mapping.'), { code: 'customer_mapping_missing' });
  }
  const args = request.arguments && typeof request.arguments === 'object' ? request.arguments : {};
  if (request.operation === 'innovations.customer_statement' && !positiveInteger(args.statement_id)) {
    throw Object.assign(new Error('statement_id must be a positive integer.'), { code: 'invalid_statement_id' });
  }
  return { operation: request.operation, target, args };
}

async function getInnovationsCustomerAccount(target) {
  const pool = await getSourcePool();
  const result = await pool.request()
    .input('customer_id', target.innovationsCustomerId)
    .input('account_number', target.accountNumber || null)
    .query(`
      SELECT TOP (1)
        c.CustomerID AS innovations_customer_id,
        CAST(c.AccountNumber AS nvarchar(120)) AS account_number,
        c.CustomerName AS customer_name,
        b.CreditLimit AS credit_limit,
        b.CurrentBalance AS current_balance,
        b.LastStatementAmount AS last_statement_amount,
        b.LastStatementDate AS last_statement_date,
        b.LastPaymentAmount AS last_payment_amount,
        b.LastPaymentDate AS last_payment_date
      FROM dbo.Customers c
      LEFT JOIN dbo.CustomerBalances b ON b.CustomerID = c.CustomerID
      WHERE (@customer_id IS NOT NULL AND c.CustomerID = @customer_id)
         OR (@customer_id IS NULL AND @account_number IS NOT NULL AND c.AccountNumber = @account_number);

      SELECT TOP (24)
        s.FinARStatementID AS id,
        CAST(c.AccountNumber AS nvarchar(120)) AS account_number,
        s.FromDate AS period_start,
        s.ToDate AS period_end,
        s.OpeningBalance AS opening_balance,
        s.ClosingBalance AS closing_balance,
        s.Payments AS payments,
        s.FinanceCharges AS finance_charges,
        s.Discount AS discount,
        s.DueDate AS due_date,
        s.Status AS status,
        CAST(s.Void AS bit) AS void,
        CAST(s.Printed AS bit) AS printed
      FROM dbo.FinARStatements s
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      WHERE s.Void = 0
        AND ((@customer_id IS NOT NULL AND c.CustomerID = @customer_id)
          OR (@customer_id IS NULL AND @account_number IS NOT NULL AND c.AccountNumber = @account_number))
      ORDER BY COALESCE(s.StatementDate, s.ToDate, s.FromDate) DESC, s.FinARStatementID DESC;
    `);

  const customer = result.recordsets[0]?.[0] || null;
  if (!customer) throw Object.assign(new Error('Customer account was not found in Innovations.'), { code: 'customer_not_found' });
  return {
    customer: {
      innovations_customer_id: customer.innovations_customer_id,
      account_number: customer.account_number,
      name: customer.customer_name,
    },
    balance: {
      account_number: customer.account_number,
      credit_limit: customer.credit_limit,
      current_balance: customer.current_balance,
      last_statement_amount: customer.last_statement_amount,
      last_statement_date: customer.last_statement_date,
      last_payment_amount: customer.last_payment_amount,
      last_payment_date: customer.last_payment_date,
    },
    statements: result.recordsets[1] || [],
    retrieved_at: new Date().toISOString(),
  };
}

async function getInnovationsCustomerStatement(target, statementId) {
  const pool = await getSourcePool();
  const result = await pool.request()
    .input('statement_id', statementId)
    .input('customer_id', target.innovationsCustomerId)
    .input('account_number', target.accountNumber || null)
    .query(`
      SELECT TOP (1)
        s.FinARStatementID AS id,
        CAST(c.AccountNumber AS nvarchar(120)) AS account_number,
        c.CustomerName AS customer_name,
        s.FromDate AS period_start,
        s.ToDate AS period_end,
        s.OpeningBalance AS opening_balance,
        s.ClosingBalance AS closing_balance,
        s.Payments AS payments,
        s.FinanceCharges AS finance_charges,
        s.Discount AS discount,
        s.DueDate AS due_date,
        s.Status AS status,
        CAST(s.Void AS bit) AS void,
        CAST(s.Printed AS bit) AS printed
      FROM dbo.FinARStatements s
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      WHERE s.FinARStatementID = @statement_id
        AND s.Void = 0
        AND ((@customer_id IS NOT NULL AND c.CustomerID = @customer_id)
          OR (@customer_id IS NULL AND @account_number IS NOT NULL AND c.AccountNumber = @account_number));

      SELECT
        i.FinARStatementItemID AS id,
        i.FinARStatementID AS statement_id,
        i.OrderType AS order_type,
        i.InvoiceID AS invoice_id,
        i.Reference AS reference,
        i.Patient AS patient,
        i.PostDate AS post_date,
        i.Amount AS amount
      FROM dbo.FinARStatementItems i
      INNER JOIN dbo.FinARStatements s ON s.FinARStatementID = i.FinARStatementID
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      WHERE i.FinARStatementID = @statement_id
        AND i.HideFromStatement = 0
        AND s.Void = 0
        AND ((@customer_id IS NOT NULL AND c.CustomerID = @customer_id)
          OR (@customer_id IS NULL AND @account_number IS NOT NULL AND c.AccountNumber = @account_number))
      ORDER BY i.PostDate DESC, i.FinARStatementItemID DESC;
    `);
  const statement = result.recordsets[0]?.[0] || null;
  if (!statement) throw Object.assign(new Error('Statement was not found for this customer.'), { code: 'statement_not_found' });
  return { statement, lines: result.recordsets[1] || [], retrieved_at: new Date().toISOString() };
}

async function getOptilensCustomerDeliveries(target, args) {
  if (!target.accountNumber) {
    throw Object.assign(new Error('OptiLens delivery lookup requires an account number.'), { code: 'account_number_missing' });
  }
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 90);
  const fromDate = dateOnly(args.from_date) || from.toISOString().slice(0, 10);
  const toDate = dateOnly(args.to_date) || today.toISOString().slice(0, 10);
  const pool = await getAppPool();
  const result = await pool.request()
    .input('account_number', target.accountNumber)
    .input('from_date', fromDate)
    .input('to_date', toDate)
    .query(`
      SELECT TOP (100)
        s.shipment_session_id,
        s.source_shipment_id,
        s.customer_account,
        s.app_status,
        s.source_shipped,
        s.started_at,
        s.closed_at,
        s.reopened_at,
        s.last_edited_at,
        s.legacy_delivery_no,
        s.tracking_number,
        s.shipping_method_name,
        s.source_item_count,
        s.source_synced_at,
        COUNT(i.shipment_session_item_id) AS item_count
      FROM delivery.shipment_sessions s
      LEFT JOIN delivery.shipment_session_items i
        ON i.shipment_session_id = s.shipment_session_id AND i.removed_at IS NULL
      WHERE s.customer_account = @account_number
        AND COALESCE(s.closed_at, s.started_at) >= TRY_CONVERT(date, @from_date)
        AND COALESCE(s.closed_at, s.started_at) < DATEADD(day, 1, TRY_CONVERT(date, @to_date))
      GROUP BY
        s.shipment_session_id, s.source_shipment_id, s.customer_account,
        s.app_status, s.source_shipped, s.started_at, s.closed_at,
        s.reopened_at, s.last_edited_at, s.legacy_delivery_no,
        s.tracking_number, s.shipping_method_name, s.source_item_count,
        s.source_synced_at
      ORDER BY COALESCE(s.closed_at, s.started_at) DESC;
    `);
  return {
    account_number: target.accountNumber,
    from_date: fromDate,
    to_date: toDate,
    deliveries: result.recordset || [],
    retrieved_at: new Date().toISOString(),
  };
}

async function dispatch(request) {
  const normalized = normalizeRequest(request);
  if (normalized.operation === 'innovations.customer_account') return getInnovationsCustomerAccount(normalized.target);
  if (normalized.operation === 'innovations.customer_statement') {
    return getInnovationsCustomerStatement(normalized.target, positiveInteger(normalized.args.statement_id));
  }
  return getOptilensCustomerDeliveries(normalized.target, normalized.args);
}

module.exports = { OPERATIONS, dispatch, normalizeRequest, positiveInteger, dateOnly };

