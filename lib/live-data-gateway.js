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
    orderLookup: rawTarget.order_lookup === 'bill_to' ? 'bill_to' : 'customer',
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
    promise_date: row.promise_date ?? null,
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
      a.PromisedTime AS promise_date,
      a.CurrentStatusID AS current_status_id
    FROM dbo.Orders a
    INNER JOIN dbo.GenStatus b ON b.GenStatus = a.GenStatus
    LEFT JOIN dbo.Customers bill_to_a ON bill_to_a.CustomerID = a.BillToID
    WHERE b.Active = 1
      AND a.JobID IS NOT NULL
      AND a.JobID <> ''
      AND a.OrderType IN (1, 3)
      AND (
        (@order_lookup = 'bill_to' AND @account_number IS NOT NULL AND bill_to_a.AccountNumber = @account_number)
        OR (@order_lookup <> 'bill_to' AND @customer_id IS NOT NULL AND a.CustomerID = @customer_id)
        OR (@order_lookup <> 'bill_to' AND @customer_id IS NULL AND @account_number IS NOT NULL AND a.CustomerAccount = @account_number)
      )

    UNION

    SELECT
      a.SerialNum AS order_id,
      b.CustomerOrdReference AS rx_number,
      b.PatientID AS patient,
      CAST(CONCAT(CONVERT(varchar, a.RxDate, 120), ' ', CONVERT(varchar, a.RxTime, 108)) AS datetimeoffset) AS received_at,
      b.PromisedTime AS promise_date,
      a.TermCode AS current_status_id
    FROM dbo.RxArchive a
    INNER JOIN dbo.Orders b ON b.OrderID = a.SerialNum
    LEFT JOIN dbo.Customers bill_to_b ON bill_to_b.CustomerID = b.BillToID
    WHERE a.ShipDate = CAST(SYSDATETIME() AS date)
      AND a.TermCode IN (
        SELECT StatusItemID
        FROM dbo.StatusItems
        WHERE Terminating = 1
          AND Cancellation = 0
      )
      AND (
        (@order_lookup = 'bill_to' AND @account_number IS NOT NULL AND bill_to_b.AccountNumber = @account_number)
        OR (@order_lookup <> 'bill_to' AND @customer_id IS NOT NULL AND b.CustomerID = @customer_id)
        OR (@order_lookup <> 'bill_to' AND @customer_id IS NULL AND @account_number IS NOT NULL AND b.CustomerAccount = @account_number)
      )
  )
  SELECT TOP (100)
    matching_orders.rx_number,
    matching_orders.patient,
    matching_orders.received_at,
    matching_orders.promise_date,
    COALESCE(NULLIF(status_translation.TranslationText, ''), status_items.StatusItemName) AS status_name
  FROM matching_orders
  LEFT JOIN dbo.StatusItems status_items ON status_items.StatusItemID = matching_orders.current_status_id
  OUTER APPLY (
    -- Customer-facing override text, keyed off TypeID 19 (status external
    -- description) and scoped to English so multi-locale rows never fan out
    -- this join into duplicate order rows. Falls back to StatusItemName below
    -- when no English translation exists (or it's blank).
    SELECT TOP (1) t.TranslationText
    FROM dbo.Translations t
    INNER JOIN dbo.Locales l ON l.LocaleID = t.LocaleID
    WHERE t.ItemID = status_items.StatusItemID
      AND t.TypeID = 19
      AND l.ShortName IN ('en', 'en-us')
    ORDER BY t.LocaleID
  ) status_translation
  ORDER BY matching_orders.received_at DESC, matching_orders.order_id DESC;
`;

// The mirror is the normal shared read model, but WIP orders are time-sensitive
// and can arrive in Zen before a mirror cycle completes.  This read-only Zen
// query preserves the customer-safe payload while allowing the portal to show
// current branch orders to their Bill To account immediately.
const ZEN_ACTIVE_CUSTOMER_ORDERS_QUERY = `
  SELECT
    a.OrderID AS order_id,
    a.CustomerOrdReference AS rx_number,
    a.PatientID AS patient,
    a.ReceivedTime AS received_at,
    a.PromisedTime AS promise_date,
    s.StatusItemName AS status_name
  FROM Orders a
  INNER JOIN GenStatus g ON g.GenStatus = a.GenStatus
  LEFT OUTER JOIN Customers bill_to ON bill_to.CustomerID = a.BillToID
  LEFT OUTER JOIN StatusItems s ON s.StatusItemID = a.CurrentStatusID
  WHERE g.Active = 1
    AND a.JobID IS NOT NULL
    AND a.JobID <> ''
    AND a.OrderType IN (1, 3)
    AND (
      (? = 'bill_to' AND bill_to.AccountNumber = ?)
      OR (? <> 'bill_to' AND a.CustomerAccount = ?)
    )
  ORDER BY a.ReceivedTime DESC, a.OrderID DESC;
`;

const ZEN_TODAY_SHIPPED_CUSTOMER_ORDERS_QUERY = `
  SELECT
    a.SerialNum AS order_id,
    b.CustomerOrdReference AS rx_number,
    b.PatientID AS patient,
    a.RxDate AS received_at,
    b.PromisedTime AS promise_date,
    s.StatusItemName AS status_name
  FROM RxArchive a
  INNER JOIN Orders b ON b.OrderID = a.SerialNum
  LEFT OUTER JOIN Customers bill_to ON bill_to.CustomerID = b.BillToID
  LEFT OUTER JOIN StatusItems s ON s.StatusItemID = a.TermCode
  WHERE a.ShipDate = CURDATE()
    AND a.TermCode IN (
      SELECT StatusItemID
      FROM StatusItems
      WHERE Terminating = 1
        AND Cancellation = 0
    )
    AND (
      (? = 'bill_to' AND bill_to.AccountNumber = ?)
      OR (? <> 'bill_to' AND b.CustomerAccount = ?)
    )
  ORDER BY a.RxDate DESC, a.SerialNum DESC;
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

  const zenOrders = await getZenCustomerOrders(target);
  if (zenOrders) {
    return {
      account_number: target.accountNumber,
      order_lookup: target.orderLookup,
      orders: zenOrders,
      retrieved_at: new Date().toISOString(),
      source_status: 'live',
    };
  }

  const pool = await getSourcePool();
  const result = await pool.request()
    .input('customer_id', target.innovationsCustomerId)
    .input('account_number', target.accountNumber)
    .input('order_lookup', target.orderLookup)
    .query(CUSTOMER_ORDER_STATUS_QUERY);

  return {
    account_number: target.accountNumber,
    order_lookup: target.orderLookup,
    orders: (result.recordset || []).map(orderPayload),
    retrieved_at: new Date().toISOString(),
  };
}

async function getZenCustomerOrders(target) {
  const zen = require('./zen-source');
  if (!zen.isAvailable()) return null;

  let connection = null;
  try {
    connection = await zen.connectZen();
    const parameters = [target.orderLookup, target.accountNumber, target.orderLookup, target.accountNumber];
    const [activeRows, shippedRows] = await Promise.all([
      connection.query(ZEN_ACTIVE_CUSTOMER_ORDERS_QUERY, parameters),
      connection.query(ZEN_TODAY_SHIPPED_CUSTOMER_ORDERS_QUERY, parameters),
    ]);
    const uniqueRows = new Map();
    for (const row of [...activeRows, ...shippedRows]) {
      uniqueRows.set(String(row.order_id), row);
    }
    return [...uniqueRows.values()]
      .sort((left, right) => String(right.received_at || '').localeCompare(String(left.received_at || '')))
      .slice(0, 100)
      .map(orderPayload);
  } catch {
    // A temporary Zen outage must not remove the portal's established
    // read-model fallback.
    return null;
  } finally {
    await connection?.close().catch(() => {});
  }
}

// Customer-facing tracking links: match on the shipping method name and prefill
// the carrier's tracking page with the number. Unknown carriers return null and
// the portal falls back to showing the bare tracking number.
const TRACKING_URL_TEMPLATES = [
  { match: /fedex/i, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}` },
  { match: /dhl/i, url: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(n)}` },
  { match: /ups/i, url: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}` },
  { match: /usps/i, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}` },
  { match: /amerijet/i, url: (n) => `https://www.amerijet.com/track-shipment/?tracking=${encodeURIComponent(n)}` },
];

function trackingUrlFor(shippingMethodName, trackingNumber) {
  const number = String(trackingNumber || '').trim();
  if (!number) return null;
  const method = String(shippingMethodName || '');
  const carrier = TRACKING_URL_TEMPLATES.find((entry) => entry.match.test(method));
  return carrier ? carrier.url(number) : null;
}

async function getOptilensCustomerDeliveries(target, args) {
  if (!target.accountNumber) {
    throw Object.assign(new Error('OptiLens delivery lookup requires an account number.'), { code: 'account_number_missing' });
  }
  // Portal contract: open shipments always show, regardless of age; closed
  // shipments remain visible for 45 days (or the caller's closed_since), then
  // drop off.
  const today = new Date();
  const closedFloor = new Date(today);
  closedFloor.setDate(closedFloor.getDate() - 45);
  const closedSince = dateOnly(args.closed_since) || dateOnly(args.from_date) || closedFloor.toISOString().slice(0, 10);
  const pool = await getAppPool();
  const result = await pool.request()
    .input('account_number', target.accountNumber)
    .input('closed_since', closedSince)
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
        AND (s.closed_at IS NULL OR s.closed_at >= TRY_CONVERT(date, @closed_since))
      GROUP BY
        s.shipment_session_id, s.source_shipment_id, s.customer_account,
        s.app_status, s.source_shipped, s.started_at, s.closed_at,
        s.reopened_at, s.last_edited_at, s.legacy_delivery_no,
        s.tracking_number, s.shipping_method_name, s.source_item_count,
        s.source_synced_at
      ORDER BY (CASE WHEN s.closed_at IS NULL THEN 0 ELSE 1 END), COALESCE(s.closed_at, s.started_at) DESC;
    `);

  const sessions = result.recordset || [];

  // The portal expands each shipment to show the orders it contains.
  const itemsResult = await pool.request()
    .input('account_number', target.accountNumber)
    .input('closed_since', closedSince)
    .query(`
      SELECT
        i.shipment_session_id,
        i.source_order_id,
        i.invoice_number,
        i.patient_name,
        i.item_state
      FROM delivery.shipment_session_items i
      INNER JOIN delivery.shipment_sessions s ON s.shipment_session_id = i.shipment_session_id
      WHERE s.customer_account = @account_number
        AND (s.closed_at IS NULL OR s.closed_at >= TRY_CONVERT(date, @closed_since))
        AND i.removed_at IS NULL
      ORDER BY i.created_at;
    `);

  const itemsBySession = new Map();
  for (const item of itemsResult.recordset || []) {
    const key = String(item.shipment_session_id);
    if (!itemsBySession.has(key)) itemsBySession.set(key, []);
    itemsBySession.get(key).push({
      order_id: item.source_order_id,
      rx_number: null,
      patient: item.patient_name,
      description: item.invoice_number ? `Invoice ${item.invoice_number}` : null,
      quantity: null,
      status_name: item.item_state,
    });
  }

  // Sessions synced from Innovations often have no locally-scanned items yet —
  // their lines live in the source system (that's also what the delivery
  // checklist shows and how buildShipmentItems() in server.js fetches them
  // for the admin view). Fall back to source shipment items per shipment ID.
  // A single unfiltered account-wide query (no shipmentId) previously landed
  // here, capped at TOP(250) ordered oldest-first — for any account with
  // more than ~250 shipment items ever recorded, that returns only ancient
  // rows and never reaches a recent shipment, so every current delivery
  // silently rendered with zero items on the customer portal even though the
  // exact same data is one shipmentId-scoped query away (proven by the admin
  // path, which always passes shipmentId and always works).
  const sessionsNeedingSourceItems = sessions.filter(
    (session) => session.source_shipment_id && !itemsBySession.has(String(session.shipment_session_id)),
  );
  const sourceItemsByShipment = new Map();
  const uniqueSourceShipmentIds = [...new Set(sessionsNeedingSourceItems.map((session) => session.source_shipment_id))];
  if (uniqueSourceShipmentIds.length) {
    const { listShipmentItems } = require('./source-innovations');
    await Promise.all(uniqueSourceShipmentIds.map(async (shipmentId) => {
      try {
        const sourceItems = await listShipmentItems({ customerAccount: target.accountNumber, shipmentId });
        sourceItemsByShipment.set(String(shipmentId), (sourceItems || []).map((item) => ({
          order_id: item.orderId,
          rx_number: item.rxNumber ?? null,
          patient: item.patientName ?? null,
          description: [item.orderTypeName, item.invoiceNumber ? `Invoice ${item.invoiceNumber}` : null].filter(Boolean).join(' · ') || null,
          quantity: null,
          status_name: item.sourceShipped ? 'Shipped' : 'In shipment',
        })));
      } catch {
        // Source lookup is best-effort — this shipment still renders with its count.
      }
    }));
  }

  return {
    account_number: target.accountNumber,
    closed_since: closedSince,
    deliveries: sessions.map((session) => ({
      ...session,
      tracking_url: trackingUrlFor(session.shipping_method_name, session.tracking_number),
      orders: itemsBySession.get(String(session.shipment_session_id))
        || (session.source_shipment_id ? sourceItemsByShipment.get(String(session.source_shipment_id)) : null)
        || [],
    })),
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

module.exports = { OPERATIONS, dispatch, normalizeRequest, positiveInteger, dateOnly, statementPayload, statementLinePayload, orderPayload, CUSTOMER_ORDER_STATUS_QUERY, ZEN_ACTIVE_CUSTOMER_ORDERS_QUERY, ZEN_TODAY_SHIPPED_CUSTOMER_ORDERS_QUERY };
