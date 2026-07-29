// Drill-down queries behind the Overview tab's drawer — live Innovations MSSQL only.
//
// Every handler returns the same envelope so the front-end drawer stays generic:
//
//   { kind, title, subtitle, generatedAt, summary[], columns[], rows[], next }
//
// `columns[].format` drives client-side formatting (text | money | int | date | pct)
// and `next` names the drill a row click opens, if any. Adding a drill should mean
// adding one entry to HANDLERS and nothing else.

const sql = require("mssql");
const { getSourcePool } = require("../db");
const { ZERO_COST_LOOKBACK_DAYS, WIP_STALE_DAYS } = require("./summary");

const ROW_LIMIT = 300;

const COLS = {
  account: { key: "accountNumber", label: "Account", format: "text" },
  customer: { key: "customerName", label: "Customer", format: "text" },
  rx: { key: "rxNumber", label: "Rx", format: "text" },
  patient: { key: "patient", label: "Patient", format: "text" },
  invoice: { key: "invoiceId", label: "Invoice", format: "text", align: "right" }
};

async function getDrill(kind, params = {}) {
  const handler = HANDLERS[kind];
  if (!handler) {
    const error = new Error(`Unknown drill "${kind}".`);
    error.statusCode = 404;
    throw error;
  }
  const pool = await getSourcePool();
  const data = await handler(pool, params);
  return { kind, generatedAt: new Date().toISOString(), ...data };
}

const HANDLERS = {
  /** Customers holding open items in one aging bucket. */
  async "aging-bucket"(pool, params) {
    const bucket = intParam(params.bucket, "bucket");
    const result = await pool.request()
      .input("bucket", sql.Int, bucket)
      .query(`
        SELECT TOP (${ROW_LIMIT})
          o.CustomerID AS customerId,
          c.AccountNumber AS accountNumber,
          c.CustomerName AS customerName,
          COUNT(*) AS items,
          ISNULL(SUM(o.AmountDue), 0) AS amountDue,
          MIN(o.InvoiceTime) AS oldestInvoice,
          MAX(o.LastPaymentDate) AS lastPayment
        FROM dbo.FinAROpenItems o
        INNER JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        WHERE o.FinARAgingPeriodNum = @bucket
        GROUP BY o.CustomerID, c.AccountNumber, c.CustomerName
        ORDER BY amountDue DESC;
      `);

    const rows = result.recordset.map((r) => ({
      customerId: r.customerId,
      accountNumber: r.accountNumber,
      customerName: trim(r.customerName),
      items: n(r.items),
      amountDue: n(r.amountDue),
      oldestInvoice: r.oldestInvoice,
      lastPayment: r.lastPayment
    }));

    return {
      title: "Receivables by customer",
      subtitle: `Aging bucket ${bucket}`,
      summary: [
        { label: "Customers", value: rows.length, format: "int" },
        { label: "Open items", value: sum(rows, "items"), format: "int" },
        { label: "Amount due", value: sum(rows, "amountDue"), format: "money" }
      ],
      columns: [
        COLS.account, COLS.customer,
        { key: "items", label: "Items", format: "int", align: "right" },
        { key: "amountDue", label: "Amount due", format: "money", align: "right" },
        { key: "oldestInvoice", label: "Oldest", format: "date" },
        { key: "lastPayment", label: "Last payment", format: "date" }
      ],
      rows,
      next: { kind: "aging-customer", carry: ["customerId"], fixed: { bucket } }
    };
  },

  /** The individual open invoices behind one customer in one bucket. */
  async "aging-customer"(pool, params) {
    const bucket = intParam(params.bucket, "bucket");
    const customerId = intParam(params.customerId, "customerId");
    const result = await pool.request()
      .input("bucket", sql.Int, bucket)
      .input("customerId", sql.Int, customerId)
      .query(`
        SELECT TOP (${ROW_LIMIT})
          o.InvoiceID AS invoiceId, o.OrderID AS orderId, o.RxNumber AS rxNumber,
          o.Patient AS patient, o.PoNumber AS poNumber, o.InvoiceTime AS invoiceTime,
          o.ShipTime AS shipTime, o.SubTotal AS subtotal, o.TaxAmount AS taxAmount,
          o.Total AS total, o.AmountDue AS amountDue, o.PaymentAmount AS paymentAmount,
          o.LastPaymentDate AS lastPayment,
          c.AccountNumber AS accountNumber, c.CustomerName AS customerName
        FROM dbo.FinAROpenItems o
        INNER JOIN dbo.Customers c ON c.CustomerID = o.CustomerID
        WHERE o.FinARAgingPeriodNum = @bucket AND o.CustomerID = @customerId
        ORDER BY o.InvoiceTime;
      `);

    const rows = result.recordset.map((r) => ({
      invoiceId: r.invoiceId,
      rxNumber: trim(r.rxNumber),
      patient: trim(r.patient),
      poNumber: trim(r.poNumber),
      invoiceTime: r.invoiceTime,
      total: n(r.total),
      amountDue: n(r.amountDue),
      paymentAmount: n(r.paymentAmount),
      lastPayment: r.lastPayment
    }));
    const who = result.recordset[0];

    return {
      title: who ? trim(who.customerName) : "Open invoices",
      subtitle: `${who ? who.accountNumber : ""} · aging bucket ${bucket}`.trim(),
      summary: [
        { label: "Open invoices", value: rows.length, format: "int" },
        { label: "Amount due", value: sum(rows, "amountDue"), format: "money" },
        { label: "Paid to date", value: sum(rows, "paymentAmount"), format: "money" }
      ],
      columns: [
        COLS.invoice, COLS.rx, COLS.patient,
        { key: "poNumber", label: "PO", format: "text" },
        { key: "invoiceTime", label: "Invoiced", format: "date" },
        { key: "total", label: "Total", format: "money", align: "right" },
        { key: "amountDue", label: "Due", format: "money", align: "right" },
        { key: "lastPayment", label: "Last payment", format: "date" }
      ],
      rows
    };
  },

  /** Open work in progress, grouped by customer. */
  async "wip-customers"(pool) {
    const result = await pool.request().query(`
      SELECT TOP (${ROW_LIMIT})
        b.CustomerID AS customerId, c.AccountNumber AS accountNumber,
        c.CustomerName AS customerName, b.CurrentWIPValue AS wipValue,
        b.WIPLimit AS wipLimit
      FROM dbo.CustomerBalances b
      INNER JOIN dbo.Customers c ON c.CustomerID = b.CustomerID
      WHERE b.CurrentWIPValue <> 0
      ORDER BY b.CurrentWIPValue DESC;
    `);

    const rows = result.recordset.map((r) => ({
      customerId: r.customerId,
      accountNumber: r.accountNumber,
      customerName: trim(r.customerName),
      wipValue: n(r.wipValue),
      wipLimit: n(r.wipLimit)
    }));

    return {
      title: "Work in progress by customer",
      subtitle: "Open value from the LMS customer roll-up",
      summary: [
        { label: "Customers", value: rows.length, format: "int" },
        { label: "WIP value", value: sum(rows, "wipValue"), format: "money" }
      ],
      columns: [
        COLS.account, COLS.customer,
        { key: "wipValue", label: "WIP value", format: "money", align: "right" },
        { key: "wipLimit", label: "WIP limit", format: "money", align: "right" }
      ],
      rows,
      next: { kind: "wip-customer", carry: ["customerId"] }
    };
  },

  /** Unshipped orders for one customer. */
  async "wip-customer"(pool, params) {
    const customerId = intParam(params.customerId, "customerId");
    const result = await pool.request()
      .input("customerId", sql.Int, customerId)
      .query(`
        SELECT TOP (${ROW_LIMIT})
          a.OrderID AS orderId, a.CustomerOrdReference AS rxNumber,
          a.ReceivedTime AS receivedTime, a.PromisedTime AS promisedTime,
          DATEDIFF(day, a.ReceivedTime, SYSDATETIME()) AS ageDays,
          g.GenStatusName AS status, ot.OrderTypeName AS orderType,
          c.AccountNumber AS accountNumber, c.CustomerName AS customerName
        FROM dbo.Orders a
        INNER JOIN dbo.GenStatus g ON g.GenStatus = a.GenStatus
        LEFT JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
        INNER JOIN dbo.Customers c ON c.CustomerID = a.CustomerID
        WHERE g.Shipped = 0 AND g.Cancelled = 0 AND a.CustomerID = @customerId
          AND a.ReceivedTime >= DATEADD(month, -6, SYSDATETIME())
        ORDER BY a.ReceivedTime;
      `);

    const rows = result.recordset.map(wipOrderRow);
    const who = result.recordset[0];

    return {
      title: who ? trim(who.customerName) : "Open orders",
      subtitle: `${who ? who.accountNumber : ""} · unshipped orders`.trim(),
      summary: [
        { label: "Open orders", value: rows.length, format: "int" },
        { label: "Oldest", value: rows.length ? Math.max(...rows.map((r) => r.ageDays)) : 0, format: "days" }
      ],
      columns: wipColumns(),
      rows
    };
  },

  /** Every unshipped order past the staleness threshold, oldest first. */
  async "wip-stale"(pool) {
    const result = await pool.request()
      .input("staleDays", sql.Int, WIP_STALE_DAYS)
      .query(`
        SELECT TOP (${ROW_LIMIT})
          a.OrderID AS orderId, a.CustomerOrdReference AS rxNumber,
          a.ReceivedTime AS receivedTime, a.PromisedTime AS promisedTime,
          DATEDIFF(day, a.ReceivedTime, SYSDATETIME()) AS ageDays,
          g.GenStatusName AS status, ot.OrderTypeName AS orderType,
          c.AccountNumber AS accountNumber, c.CustomerName AS customerName
        FROM dbo.Orders a
        INNER JOIN dbo.GenStatus g ON g.GenStatus = a.GenStatus
        LEFT JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
        INNER JOIN dbo.Customers c ON c.CustomerID = a.CustomerID
        WHERE g.Shipped = 0 AND g.Cancelled = 0
          AND a.ReceivedTime >= DATEADD(month, -6, SYSDATETIME())
          AND DATEDIFF(day, a.ReceivedTime, SYSDATETIME()) > @staleDays
        ORDER BY a.ReceivedTime;
      `);

    const rows = result.recordset.map(wipOrderRow);

    return {
      title: `Orders open longer than ${WIP_STALE_DAYS} days`,
      subtitle: "Received but not yet shipped",
      summary: [
        { label: "Orders", value: rows.length, format: "int" },
        { label: "Oldest", value: rows.length ? Math.max(...rows.map((r) => r.ageDays)) : 0, format: "days" }
      ],
      columns: [COLS.account, COLS.customer, ...wipColumns()],
      rows
    };
  },

  /** Lens / add-on lines shipped with no cost — the KPI whose target is zero. */
  async "zero-cost-lines"(pool) {
    const result = await pool.request()
      .input("days", sql.Int, ZERO_COST_LOOKBACK_DAYS)
      .query(`
        SELECT TOP (${ROW_LIMIT})
          c.InvoiceID AS invoiceId, a.OrderID AS orderId,
          a.CustomerOrdReference AS rxNumber, cu.AccountNumber AS accountNumber,
          cu.CustomerName AS customerName, ot.OrderTypeName AS orderType,
          d.Description AS description, d.SKU AS sku, a.ShippedTime AS shippedAt,
          CASE WHEN d.CategoryType IN (1, 16) THEN N'lens' ELSE N'add-on' END AS lineKind,
          CAST(COALESCE(d.Quantity, 0) AS decimal(18, 2)) AS quantity,
          CAST(COALESCE(d.InvoicePrice, 0) AS decimal(18, 2)) AS unitPrice,
          CAST(COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) AS decimal(18, 2)) AS lineRevenue,
          CAST(COALESCE(c.Total, 0) AS decimal(18, 2)) AS invoiceTotal
        FROM dbo.Orders a
        INNER JOIN dbo.GenStatus gs ON gs.GenStatus = a.GenStatus
        INNER JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
        INNER JOIN dbo.Invoices c ON a.OrderID = c.OrderID
        INNER JOIN dbo.InvoiceLines d ON c.InvoiceID = d.InvoiceID
        INNER JOIN dbo.Customers cu ON cu.CustomerID = COALESCE(a.BillToID, c.CustomerID, a.CustomerID)
        WHERE a.ShippedTime >= DATEADD(day, -@days, CAST(SYSDATETIME() AS date))
          AND gs.Shipped = 1
          AND COALESCE(ot.Credit, 0) = 0
          AND ot.OrderType IN (1, 3, 12)
          AND COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) > 0
          AND d.CategoryType IN (1, 16, 4, 6, 7, 10, 11, 13)
          AND COALESCE(d.CostPrice, 0) = 0
        ORDER BY lineRevenue DESC, cu.AccountNumber, a.ShippedTime DESC;
      `);

    const rows = result.recordset.map((r) => ({
      invoiceId: r.invoiceId,
      accountNumber: r.accountNumber,
      customerName: trim(r.customerName),
      rxNumber: trim(r.rxNumber),
      lineKind: r.lineKind,
      description: trim(r.description) || trim(r.sku),
      shippedAt: r.shippedAt,
      quantity: n(r.quantity),
      unitPrice: n(r.unitPrice),
      lineRevenue: n(r.lineRevenue)
    }));

    const invoices = new Set(rows.map((r) => r.invoiceId));

    return {
      title: "Zero-cost lens and add-on lines",
      subtitle: `Shipped in the last ${ZERO_COST_LOOKBACK_DAYS} days · target is zero`,
      summary: [
        { label: "Invoices", value: invoices.size, format: "int" },
        { label: "Lines", value: rows.length, format: "int" },
        { label: "Revenue exposed", value: sum(rows, "lineRevenue"), format: "money" }
      ],
      columns: [
        COLS.account, COLS.customer, COLS.rx,
        { key: "lineKind", label: "Kind", format: "text" },
        { key: "description", label: "Description", format: "text" },
        { key: "shippedAt", label: "Shipped", format: "date" },
        { key: "quantity", label: "Qty", format: "int", align: "right" },
        { key: "unitPrice", label: "Unit price", format: "money", align: "right" },
        { key: "lineRevenue", label: "Line revenue", format: "money", align: "right" }
      ],
      rows
    };
  },

  /** Shipped invoices in one of the two threshold bands (Invoices tab). */
  async "invoice-threshold"(pool, params) {
    const band = params.band === "over180" ? "over180" : "under199";
    // The computed total has no alias available in WHERE, so the comparison is
    // appended to the expression itself.
    const comparison = band === "over180" ? "> 180.00" : "< 199.00";

    const result = await pool.request().query(`
      SELECT TOP (${ROW_LIMIT})
        b.InvoiceID AS invoiceId,
        CAST(b.Total * COALESCE(d.OrderSign, 1) AS decimal(18, 2)) AS total,
        b.SubTotal AS subtotal, d.OrderTypeName AS invTypeName,
        a.CustomerOrdReference AS rxNum, a.CustomerAccount AS account,
        a.ShippedTime AS shipDate, a.PatientID AS patient, c.CustomerName AS customerName
      FROM dbo.Orders a
      INNER JOIN dbo.Invoices b ON a.OrderID = b.OrderID
      INNER JOIN dbo.Customers c ON c.CustomerID = a.CustomerID
      LEFT JOIN dbo.OrderTypes d ON a.OrderType = d.OrderType
      WHERE a.ShippedTime >= DATEADD(day, -7, CAST(SYSDATETIME() AS date))
        AND a.GenStatus = 6
        AND a.OrderType IN (1, 3, 4, 5, 8, 9, 10, 11, 12)
        AND CAST(b.Total * COALESCE(d.OrderSign, 1) AS decimal(18, 2)) ${comparison}
      ORDER BY a.CustomerAccount, a.ShippedTime;
    `);

    const rows = result.recordset.map((r) => ({
      invoiceId: r.invoiceId,
      account: r.account,
      customerName: trim(r.customerName),
      rxNum: trim(r.rxNum),
      patient: trim(r.patient),
      invTypeName: trim(r.invTypeName),
      shipDate: r.shipDate,
      subtotal: n(r.subtotal),
      total: n(r.total)
    }));

    return {
      title: band === "over180" ? "Shipped invoices over 180.00" : "Shipped invoices under 199.00",
      subtitle: "Last 7 days",
      emptyText: "No shipped invoices matched this threshold in the last 7 days.",
      summary: [
        { label: "Invoices", value: rows.length, format: "int" },
        { label: "Total", value: sum(rows, "total"), format: "money" }
      ],
      columns: [
        { key: "account", label: "Account", format: "text" },
        COLS.customer,
        { key: "rxNum", label: "Rx", format: "text" },
        COLS.patient,
        { key: "invTypeName", label: "Type", format: "text" },
        COLS.invoice,
        { key: "shipDate", label: "Shipped", format: "date" },
        { key: "total", label: "Total", format: "money", align: "right" }
      ],
      rows
    };
  },

  /** Worst-margin costed lines over the profitability window (Profitability tab). */
  async "low-margin-lines"(pool) {
    const result = await pool.request().query(`
      SELECT TOP (${ROW_LIMIT})
        c.InvoiceID AS invoiceId, a.CustomerOrdReference AS rxNumber,
        origin.AccountNumber AS accountNumber, origin.CustomerName AS customerName,
        ot.OrderTypeName AS orderTypeName, d.Description AS description, d.SKU AS sku,
        a.ShippedTime AS shippedAt,
        CAST(COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) AS decimal(18, 2)) AS lineRevenue,
        CAST(COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0) AS decimal(18, 2)) AS lineCost,
        CAST((COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0))
           - (COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0)) AS decimal(18, 2)) AS marginAmount,
        CAST((((COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0))
           - (COALESCE(d.CostPrice, 0) * COALESCE(d.Quantity, 0)))
           / NULLIF(COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0), 0)) * 100 AS decimal(18, 2)) AS marginPct
      FROM dbo.Orders a
      INNER JOIN dbo.GenStatus gs ON gs.GenStatus = a.GenStatus
      INNER JOIN dbo.OrderTypes ot ON ot.OrderType = a.OrderType
      INNER JOIN dbo.Invoices c ON a.OrderID = c.OrderID
      INNER JOIN dbo.InvoiceLines d ON c.InvoiceID = d.InvoiceID
      INNER JOIN dbo.Customers origin ON origin.CustomerID = COALESCE(a.BillToID, c.CustomerID, a.CustomerID)
      WHERE a.ShippedTime >= DATEADD(day, -30, CAST(SYSDATETIME() AS date))
        AND gs.Shipped = 1
        AND COALESCE(ot.Credit, 0) = 0
        AND ot.OrderType IN (1, 3, 12)
        AND COALESCE(d.InvoicePrice, 0) * COALESCE(d.Quantity, 0) > 0
      ORDER BY marginPct ASC, marginAmount ASC;
    `);

    const rows = result.recordset.map((r) => ({
      invoiceId: r.invoiceId,
      accountNumber: r.accountNumber,
      customerName: trim(r.customerName),
      rxNumber: trim(r.rxNumber),
      description: trim(r.description) || trim(r.sku),
      orderTypeName: trim(r.orderTypeName),
      shippedAt: r.shippedAt,
      lineRevenue: n(r.lineRevenue),
      lineCost: n(r.lineCost),
      marginAmount: n(r.marginAmount),
      marginPct: r.marginPct == null ? null : n(r.marginPct)
    }));

    return {
      title: "Lowest-margin lines",
      subtitle: "Costed lines shipped in the last 30 days, worst margin first",
      summary: [
        { label: "Lines", value: rows.length, format: "int" },
        { label: "Revenue", value: sum(rows, "lineRevenue"), format: "money" },
        { label: "Margin", value: sum(rows, "marginAmount"), format: "money" }
      ],
      columns: [
        COLS.account, COLS.customer, COLS.rx,
        { key: "description", label: "Description", format: "text" },
        { key: "orderTypeName", label: "Type", format: "text" },
        { key: "shippedAt", label: "Shipped", format: "date" },
        { key: "lineRevenue", label: "Revenue", format: "money", align: "right" },
        { key: "lineCost", label: "Cost", format: "money", align: "right" },
        { key: "marginAmount", label: "Margin", format: "money", align: "right" },
        { key: "marginPct", label: "Margin %", format: "pct", align: "right" }
      ],
      rows
    };
  },

  /** Invoices posted in one calendar month — the trend chart's drill. */
  async "month-invoices"(pool, params) {
    const month = monthParam(params.month);
    const start = new Date(`${month}-01T00:00:00`);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);

    const result = await pool.request()
      .input("start", sql.DateTime2, start)
      .input("end", sql.DateTime2, end)
      .query(`
        SELECT TOP (${ROW_LIMIT})
          j.InvoiceID AS invoiceId, j.RxNumber AS rxNumber, j.Patient AS patient,
          j.InvoiceTime AS invoiceTime, j.SubTotal AS subtotal, j.TaxAmount AS taxAmount,
          j.Total AS total, j.AmountDue AS amountDue,
          c.AccountNumber AS accountNumber, c.CustomerName AS customerName
        FROM dbo.FinARSalesJournal j
        INNER JOIN dbo.Customers c ON c.CustomerID = j.CustomerID
        WHERE j.InvoiceTime >= @start AND j.InvoiceTime < @end
        ORDER BY j.SubTotal DESC;
      `);

    const totals = await pool.request()
      .input("start", sql.DateTime2, start)
      .input("end", sql.DateTime2, end)
      .query(`
        SELECT COUNT(DISTINCT InvoiceID) AS invoices, ISNULL(SUM(SubTotal), 0) AS net
        FROM dbo.FinARSalesJournal WHERE InvoiceTime >= @start AND InvoiceTime < @end;
      `);
    const t = totals.recordset[0] || {};

    const rows = result.recordset.map((r) => ({
      invoiceId: r.invoiceId,
      accountNumber: r.accountNumber,
      customerName: trim(r.customerName),
      rxNumber: trim(r.rxNumber),
      patient: trim(r.patient),
      invoiceTime: r.invoiceTime,
      subtotal: n(r.subtotal),
      total: n(r.total),
      amountDue: n(r.amountDue)
    }));

    return {
      title: monthLabel(month),
      subtitle: rows.length < n(t.invoices)
        ? `Top ${rows.length} of ${n(t.invoices).toLocaleString("en-US")} invoices by value`
        : "All invoices posted this month",
      summary: [
        { label: "Invoices", value: n(t.invoices), format: "int" },
        { label: "Net sales", value: n(t.net), format: "money" }
      ],
      columns: [
        COLS.invoice, COLS.account, COLS.customer, COLS.rx, COLS.patient,
        { key: "invoiceTime", label: "Invoiced", format: "date" },
        { key: "subtotal", label: "Net", format: "money", align: "right" },
        { key: "total", label: "Total", format: "money", align: "right" }
      ],
      rows
    };
  },

  /** One customer: roll-up figures plus their recent invoices. */
  async customer(pool, params) {
    const customerId = intParam(params.customerId, "customerId");
    const result = await pool.request()
      .input("customerId", sql.Int, customerId)
      .query(`
        SELECT TOP (1)
          c.CustomerName AS customerName, c.AccountNumber AS accountNumber,
          ISNULL(b.SalesValueYTD, 0) AS salesYTD, ISNULL(b.CurrentBalance, 0) AS balance,
          ISNULL(b.CurrentWIPValue, 0) AS wip, ISNULL(b.CreditLimit, 0) AS creditLimit,
          b.LastPaymentDate AS lastPaymentDate, ISNULL(b.LastPaymentAmount, 0) AS lastPaymentAmount
        FROM dbo.Customers c
        LEFT JOIN dbo.CustomerBalances b ON b.CustomerID = c.CustomerID
        WHERE c.CustomerID = @customerId;

        SELECT TOP (100)
          j.InvoiceID AS invoiceId, j.RxNumber AS rxNumber, j.Patient AS patient,
          j.InvoiceTime AS invoiceTime, j.SubTotal AS subtotal, j.Total AS total,
          j.AmountDue AS amountDue
        FROM dbo.FinARSalesJournal j
        WHERE j.CustomerID = @customerId
        ORDER BY j.InvoiceTime DESC;
      `);

    const who = result.recordsets[0][0] || {};
    const rows = result.recordsets[1].map((r) => ({
      invoiceId: r.invoiceId,
      rxNumber: trim(r.rxNumber),
      patient: trim(r.patient),
      invoiceTime: r.invoiceTime,
      subtotal: n(r.subtotal),
      total: n(r.total),
      amountDue: n(r.amountDue)
    }));

    return {
      title: trim(who.customerName) || `Customer ${customerId}`,
      subtitle: who.accountNumber || "",
      summary: [
        { label: "Sales YTD", value: n(who.salesYTD), format: "money" },
        { label: "Balance", value: n(who.balance), format: "money" },
        { label: "WIP", value: n(who.wip), format: "money" },
        { label: "Last payment", value: who.lastPaymentDate, format: "date" }
      ],
      columns: [
        COLS.invoice, COLS.rx, COLS.patient,
        { key: "invoiceTime", label: "Invoiced", format: "date" },
        { key: "subtotal", label: "Net", format: "money", align: "right" },
        { key: "total", label: "Total", format: "money", align: "right" },
        { key: "amountDue", label: "Due", format: "money", align: "right" }
      ],
      rows
    };
  }
};

function wipColumns() {
  return [
    { key: "orderId", label: "Order", format: "text", align: "right" },
    { key: "rxNumber", label: "Rx", format: "text" },
    { key: "orderType", label: "Type", format: "text" },
    { key: "status", label: "Status", format: "text" },
    { key: "receivedTime", label: "Received", format: "date" },
    { key: "promisedTime", label: "Promised", format: "date" },
    { key: "ageDays", label: "Age", format: "days", align: "right" }
  ];
}

function wipOrderRow(r) {
  return {
    orderId: r.orderId,
    accountNumber: r.accountNumber,
    customerName: trim(r.customerName),
    rxNumber: trim(r.rxNumber),
    orderType: trim(r.orderType),
    status: trim(r.status),
    receivedTime: r.receivedTime,
    promisedTime: r.promisedTime,
    ageDays: n(r.ageDays)
  };
}

function intParam(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    const error = new Error(`Drill parameter "${name}" must be a number.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function monthParam(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ""))) {
    const error = new Error('Drill parameter "month" must look like YYYY-MM.');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function monthLabel(month) {
  const [y, m] = month.split("-");
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleString("en-US", { month: "long", year: "numeric" });
}

function trim(value) {
  return value == null ? null : String(value).trim() || null;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = { getDrill, DRILL_KINDS: Object.keys(HANDLERS) };
