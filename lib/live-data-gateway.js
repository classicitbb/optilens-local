const { getAppPool, getSourcePool } = require('./db');

const OPERATIONS = Object.freeze([
  'innovations.customer_account',
  'innovations.customer_statement',
  'innovations.customer_orders',
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

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function statementPayload(row) {
  const discount = nullableNumber(row.discount);
  const allowance = nullableNumber(row.allowance);
  return {
    ...row,
    discounts_allowance: (discount || 0) + (allowance || 0),
  };
}

function statementLinePayload(row) {
  return {
    id: row.id ?? null,
    statement_id: row.statement_id ?? null,
    order_type_name: row.order_type_name || null,
    invoice_id: row.invoice_id ?? null,
    order_id: row.order_id ?? null,
    patient: row.patient || null,
    payment_method: row.payment_method || null,
    reference: row.reference || null,
    post_date: row.post_date ?? null,
    amount: nullableNumber(row.amount),
  };
}

function orderPayload(row) {
  return {
    rx_number: row.rx_number || null,
    patient: row.patient || null,
    received_at: row.received_at ?? null,
    status_name: row.status_name || null,
  };
}

// This intentionally mirrors the lab's WIP report: active Rx/stock work plus
// valid shipments created today. The portal only needs the four visible columns,
// so identifiers, tray data, and internal status metadata never leave the local
// connector. SYSDATETIME avoids the dbo.Now() execute permission that the
// read-only reporting login does not have.
const CUSTOMER_ORDER_STATUS_QUERY = `
  WITH matching_orders AS (
    SELECT
      a.OrderID AS order_id,
      a.CustomerOrdReference AS rx_number,
      a.PatientID AS patient,
      a.ReceivedTime AS received_at,
      a.CurrentStatusID AS current_status_id
    FROM dbo.Orders a
    INNER JOIN dbo.GenStatus b ON b.GenStatus = a.GenStatus
    WHERE b.Active = 1
      AND a.JobID IS NOT NULL
      AND a.JobID <> ''
      AND a.OrderType IN (1, 3)
      AND (
        (@customer_id IS NOT NULL AND a.CustomerID = @customer_id)
        OR (@customer_id IS NULL AND @account_number IS NOT NULL AND a.CustomerAccount = @account_number)
      )

    UNION

    SELECT
      a.SerialNum AS order_id,
      b.CustomerOrdReference AS rx_number,
      b.PatientID AS patient,
      CAST(CONCAT(CONVERT(varchar, a.RxDate, 120), ' ', CONVERT(varchar, a.RxTime, 108)) AS datetimeoffset) AS received_at,
      a.TermCode AS current_status_id
    FROM dbo.RxArchive a
    INNER JOIN dbo.Orders b ON b.OrderID = a.SerialNum
    WHERE a.ShipDate = CAST(SYSDATETIME() AS date)
      AND a.TermCode IN (
        SELECT StatusItemID
        FROM dbo.StatusItems
        WHERE Terminating = 1
          AND Cancellation = 0
      )
      AND (
        (@customer_id IS NOT NULL AND b.CustomerID = @customer_id)
        OR (@customer_id IS NULL AND @account_number IS NOT NULL AND b.CustomerAccount = @account_number)
      )
  )
  SELECT TOP (100)
    matching_orders.rx_number,
    matching_orders.patient,
    matching_orders.received_at,
    status_items.StatusItemName AS status_name
  FROM matching_orders
  LEFT JOIN dbo.StatusItems status_items ON status_items.StatusItemID = matching_orders.current_status_id
  ORDER BY matching_orders.received_at DESC, matching_orders.order_id DESC;
`;

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
        s.StatementDate AS statement_date,
        s.FromDate AS period_start,
        COALESCE(s.ToDate, p.PeriodEnd) AS period_end,
        c.VolumeDiscount AS volume_discount,
        s.OpeningBalance AS opening_balance,
        s.Transactions AS transactions,
        s.ClosingBalance AS closing_balance,
        s.Payments AS payments,
        s.FinanceCharges AS finance_charges,
        s.Discount AS discount,
        s.Allowance AS allowance,
        COALESCE(s.Discount, 0) + COALESCE(s.Allowance, 0) AS discounts_allowance,
        s.AgingAmount1 AS aging_amount_1,
        s.AgingAmount2 AS aging_amount_2,
        s.AgingAmount3 AS aging_amount_3,
        s.AgingAmount4 AS aging_amount_4,
        s.DueDate AS due_date,
        s.Status AS status,
        CAST(s.Void AS bit) AS void,
        CAST(s.Printed AS bit) AS printed
      FROM dbo.FinARStatements s
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      LEFT JOIN dbo.FinARPeriods p ON p.FinARPeriodID = s.FinARPeriodID
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
    statements: (result.recordsets[1] || []).map(statementPayload),
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
        s.StatementDate AS statement_date,
        s.FromDate AS period_start,
        COALESCE(s.ToDate, p.PeriodEnd) AS period_end,
        c.VolumeDiscount AS volume_discount,
        s.OpeningBalance AS opening_balance,
        s.Transactions AS transactions,
        s.ClosingBalance AS closing_balance,
        s.Payments AS payments,
        s.FinanceCharges AS finance_charges,
        s.Discount AS discount,
        s.Allowance AS allowance,
        COALESCE(s.Discount, 0) + COALESCE(s.Allowance, 0) AS discounts_allowance,
        s.AgingAmount1 AS aging_amount_1,
        s.AgingAmount2 AS aging_amount_2,
        s.AgingAmount3 AS aging_amount_3,
        s.AgingAmount4 AS aging_amount_4,
        s.DueDate AS due_date,
        s.Status AS status,
        CAST(s.Void AS bit) AS void,
        CAST(s.Printed AS bit) AS printed
      FROM dbo.FinARStatements s
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      LEFT JOIN dbo.FinARPeriods p ON p.FinARPeriodID = s.FinARPeriodID
      WHERE s.FinARStatementID = @statement_id
        AND s.Void = 0
        AND ((@customer_id IS NOT NULL AND c.CustomerID = @customer_id)
          OR (@customer_id IS NULL AND @account_number IS NOT NULL AND c.AccountNumber = @account_number));

      SELECT
        i.FinARStatementItemID AS id,
        i.FinARStatementID AS statement_id,
        COALESCE(t.OrderTypeName, CONVERT(nvarchar(50), i.OrderType)) AS order_type_name,
        i.InvoiceID AS invoice_id,
        i.OrderID AS order_id,
        i.Reference AS reference,
        i.Patient AS patient,
        i.PaymentMethod AS payment_method,
        i.PostDate AS post_date,
        i.Amount AS amount
      FROM dbo.FinARStatementItems i
      INNER JOIN dbo.FinARStatements s ON s.FinARStatementID = i.FinARStatementID
      INNER JOIN dbo.Customers c ON c.CustomerID = s.CustomerID
      LEFT JOIN dbo.OrderTypes t ON t.OrderType = i.OrderType
      WHERE i.FinARStatementID = @statement_id
        AND i.HideFromStatement = 0
        AND s.Void = 0
        AND ((@customer_id IS NOT NULL AND c.CustomerID = @customer_id)
          OR (@customer_id IS NULL AND @account_number IS NOT NULL AND c.AccountNumber = @account_number))
      ORDER BY i.PostDate ASC, i.FinARStatementItemID ASC;
    `);
  const statement = result.recordsets[0]?.[0] || null;
  if (!statement) throw Object.assign(new Error('Statement was not found for this customer.'), { code: 'statement_not_found' });
  return {
    statement: statementPayload(statement),
    lines: (result.recordsets[1] || []).map(statementLinePayload),
    retrieved_at: new Date().toISOString(),
  };
}

async function getInnovationsCustomerOrders(target, args) {
  if (!target.accountNumber) {
    throw Object.assign(new Error('Order lookup requires an LMS account number.'), { code: 'account_number_missing' });
  }

  const pool = await getSourcePool();
  const result = await pool.request()
    .input('customer_id', target.innovationsCustomerId)
    .input('account_number', target.accountNumber)
    .query(CUSTOMER_ORDER_STATUS_QUERY);

  return {
    account_number: target.accountNumber,
    orders: (result.recordset || []).map(orderPayload),
    retrieved_at: new Date().toISOString(),
  };
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
  if (normalized.operation === 'innovations.customer_orders') {
    return getInnovationsCustomerOrders(normalized.target, normalized.args);
  }
  return getOptilensCustomerDeliveries(normalized.target, normalized.args);
}

module.exports = { OPERATIONS, dispatch, normalizeRequest, positiveInteger, dateOnly, statementPayload, statementLinePayload, orderPayload, CUSTOMER_ORDER_STATUS_QUERY };
