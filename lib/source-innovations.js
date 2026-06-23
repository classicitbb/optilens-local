const { getSourcePool } = require("./db");

async function listDispatchers() {
  const pool = await getSourcePool();
  const result = await pool.request().query(`
    SELECT
      UserAccountID AS dispatcherId,
      COALESCE(NULLIF(DisplayName, N''), NULLIF(UserName, ''), CONCAT(FirstName, N' ', LastName)) AS dispatcherName,
      UserName AS userName,
      JobTitle AS jobTitle
    FROM dbo.UserAccounts
    WHERE Active = 1
      AND (
        JobTitle LIKE N'%Shipping%'
        OR JobTitle LIKE N'%Courier%'
        OR JobTitle LIKE N'%Inventory%'
        OR UserName LIKE '%SHIPPING%'
        OR DisplayName LIKE N'%Shipping%'
      )
    ORDER BY dispatcherName
  `);

  return result.recordset;
}

async function listExportCustomers(search = "") {
  const pool = await getSourcePool();
  const request = pool.request()
    .input("search", `%${String(search || "").trim()}%`);

  const result = await request.query(`
    SELECT TOP (100)
      CustomerID AS customerId,
      AccountNumber AS customerAccount,
      CustomerName AS customerName,
      ShippingMethodID AS shippingMethodId,
      CAST(1 AS bit) AS isExportCustomer,
      IsActive AS isActive
    FROM dbo.Customers
    WHERE ShippingMethodID = 16
      AND IsActive = 1
      AND (
        @search = '%%'
        OR AccountNumber LIKE @search
        OR CustomerName LIKE @search
      )
    ORDER BY CustomerName
  `);

  return result.recordset;
}

async function listCustomers(search = "") {
  const pool = await getSourcePool();
  const request = pool.request()
    .input("search", `%${String(search || "").trim()}%`);

  const result = await request.query(`
    SELECT TOP (500)
      CustomerID AS customerId,
      AccountNumber AS customerAccount,
      CustomerName AS customerName,
      ShippingMethodID AS shippingMethodId,
      CAST(CASE WHEN ShippingMethodID = 16 THEN 1 ELSE 0 END AS bit) AS isExportCustomer,
      IsActive AS isActive
    FROM dbo.Customers
    WHERE IsActive = 1
      AND (
        @search = '%%'
        OR AccountNumber LIKE @search
        OR CustomerName LIKE @search
      )
    ORDER BY CustomerName
  `);

  return result.recordset;
}

async function listShipmentItems({ customerAccount, shipmentId }) {
  const pool = await getSourcePool();
  const request = pool.request()
    .input("customerAccount", customerAccount || null)
    .input("shipmentId", shipmentId || null);

  const result = await request.query(`
    SELECT TOP (250)
      si.ShipmentItemID AS shipmentItemId,
      si.ShipmentID AS shipmentId,
      si.OrderID AS orderId,
      o.CustomerAccount AS customerAccount,
      o.PatientID AS patientName,
      i.InvoiceID AS invoiceNumber,
      i.Total AS price,
      s.Shipped AS sourceShipped,
      s.ShippedTime AS sourceShippedTime
    FROM dbo.ShipmentItems si
    INNER JOIN dbo.Shipments s
      ON s.ShipmentID = si.ShipmentID
    LEFT JOIN dbo.Orders o
      ON o.OrderID = si.OrderID
    LEFT JOIN dbo.Invoices i
      ON i.OrderID = si.OrderID
    WHERE (@shipmentId IS NULL OR si.ShipmentID = TRY_CONVERT(int, @shipmentId))
      AND (@customerAccount IS NULL OR o.CustomerAccount = @customerAccount)
    ORDER BY si.ShipmentItemID
  `);

  return result.recordset;
}

async function findInvoiceItem(invoiceNumber) {
  const pool = await getSourcePool();
  const request = pool.request()
    .input("invoiceNumber", String(invoiceNumber || "").trim());

  const result = await request.query(`
    SELECT TOP (1)
      si.ShipmentItemID AS shipmentItemId,
      si.ShipmentID AS shipmentId,
      si.OrderID AS orderId,
      o.CustomerAccount AS customerAccount,
      o.PatientID AS patientName,
      i.InvoiceID AS invoiceNumber,
      i.Total AS price,
      s.Shipped AS sourceShipped,
      s.ShippedTime AS sourceShippedTime
    FROM dbo.Invoices i
    INNER JOIN dbo.Orders o
      ON o.OrderID = i.OrderID
    LEFT JOIN dbo.ShipmentItems si
      ON si.OrderID = o.OrderID
    LEFT JOIN dbo.Shipments s
      ON s.ShipmentID = si.ShipmentID
    WHERE TRY_CONVERT(nvarchar(120), i.InvoiceID) = @invoiceNumber
    ORDER BY si.ShipmentItemID DESC
  `);

  return result.recordset[0] || null;
}

/**
 * All active customers for the Pricelist Builder.
 * No ShippingMethodID filter — we want every active account.
 * Extra columns (BuyingGroup, Country, City, Phone) are standard
 * Innovations fields; if any are absent the server falls back to
 * the static customers.json.
 */
async function listPricelistCustomers() {
  const pool = await getSourcePool();
  const colResult = await pool.request().query(`
    SELECT c.name
    FROM sys.columns c
    INNER JOIN sys.objects o ON o.object_id = c.object_id
    INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = N'dbo'
      AND o.name = N'CustomerAddresses'
  `);
  const addressCols = new Set((colResult.recordset || []).map((row) => String(row.name || "").toLowerCase()));
  const pick = (alias, candidates, outAlias, size = 200) => {
    const hit = candidates.find((name) => addressCols.has(name.toLowerCase()));
    return hit
      ? `ISNULL(CAST(${alias}.${hit} AS nvarchar(${size})), '') AS ${outAlias}`
      : `CAST('' AS nvarchar(${size})) AS ${outAlias}`;
  };

  const result = await pool.request().query(`
    SELECT
      c.AccountNumber                                  AS account,
      c.CustomerName                                   AS name,
      ISNULL(CAST(bg.BuyinGroupName AS nvarchar(100)), '') AS buyingGroup,
      ISNULL(CAST(co.CountryName AS nvarchar(100)), '') AS country,
      ISNULL(CAST(a.Locality     AS nvarchar(100)), '') AS city,
      ISNULL(CAST(c.PhoneNumber  AS nvarchar(50)),  '') AS phone,
      ${pick("a", ["Address1", "AddressLine1", "Line1", "Street1", "Street"], "address1")},
      ${pick("a", ["Address2", "AddressLine2", "Line2", "Street2"], "address2")},
      ${pick("a", ["Address3", "AddressLine3", "Line3"], "address3")},
      ${pick("a", ["Region", "Province", "State"], "region", 100)},
      ${pick("a", ["PostalCode", "PostCode", "ZipCode", "Zip"], "postalCode", 40)}
    FROM dbo.Customers c
    LEFT JOIN dbo.BuyinGroups bg
      ON bg.BuyinGroupID = c.BuyinGroupID
    LEFT JOIN dbo.CustomerAddresses a
      ON a.CustomerID = c.CustomerID
      AND a.AddressType = 7
    LEFT JOIN dbo.Countries co
      ON co.CountryID = a.CountryID
    WHERE c.IsActive = 1
    ORDER BY c.CustomerName
  `);
  return result.recordset;
}

async function getStatement(statementId) {
  const pool = await getSourcePool();
  const id = parseInt(statementId, 10);
  if (!id || isNaN(id)) throw Object.assign(new Error('Invalid statement ID'), { statusCode: 400 });

  const req = () => pool.request().input('ppStatementID', id);

  // Run all queries in parallel
  const [headerRes, itemsRes, agingRes, orderSummaryRes, invoiceSummaryRes, customerAddrRes] = await Promise.all([
    req().query(`
      SELECT s.FinARStatementID, s.OpeningBalance, s.Transactions, s.FinanceCharges,
             s.Payments, s.ClosingBalance, s.FromDate, s.ToDate,
             s.AgingAmount1, s.AgingAmount2, s.AgingAmount3, s.AgingAmount4,
             s.Allowance, s.Discount, s.EligibleDiscount,
             CAST(s.DueDate AS Date) AS DueDate,
             c.CustomerName, c.AccountNumber
      FROM   FinARStatements s
             INNER JOIN Customers c ON s.CustomerID = c.CustomerID
      WHERE  s.FinARStatementID = @ppStatementID
    `),
    req().query(`
      SELECT a.OrderType, c.RxNumber, a.InvoiceID, a.Reference, a.Patient,
             CAST(a.PostDate AS Date) AS TransactionDate, a.Amount,
             ISNULL(b.OrderTypeName, 'Unknown') AS TypeName,
             a.FinARStatementID
      FROM   FinARStatementItems a
             LEFT OUTER JOIN OrderTypes b ON b.OrderType = a.OrderType
             LEFT OUTER JOIN FinARSalesJournal c ON a.FinARSalesJournalID = c.FinARSalesJournalID
      WHERE  a.FinARStatementID = @ppStatementID
        AND  a.HideFromStatement = 0
      ORDER BY TransactionDate
    `),
    pool.request().query(`
      SELECT AgingDays1, AgingDays2, AgingDays3, AgingDays4,
             AgingDesc1, AgingDesc2, AgingDesc3, AgingDesc4
      FROM   FinARAgingPeriods
      WHERE  FinARAgingPeriodID = 1
    `),
    req().query(`
      SELECT SUM(TotalInvoices) AS TotalInvoices,
             SUM(TotalCredits)  AS TotalCredits,
             SUM(TotalDebits)   AS TotalDebits,
             SUM(TotalRx)       AS TotalRx,
             SUM(TotalStock)    AS TotalStock,
             SUM(TotalPayments) AS TotalPayments,
             SUM(TotalDiscount) AS TotalDiscount,
             SUM(NumInvoices)   AS NumInvoices,
             SUM(NumCredits)    AS NumCredits,
             SUM(NumDebits)     AS NumDebits,
             SUM(NumRx)         AS NumRx,
             SUM(NumStock)      AS NumStock,
             SUM(NumPayments)   AS NumPayments,
             SUM(NumDiscount)   AS NumDiscount
      FROM (
        SELECT SUM(Amount) AS TotalInvoices, 0 AS TotalCredits, 0 AS TotalDebits, 0 AS TotalRx, 0 AS TotalStock, 0 AS TotalPayments, 0 AS TotalDiscount,
               COUNT(Amount) AS NumInvoices, 0 AS NumCredits, 0 AS NumDebits, 0 AS NumRx, 0 AS NumStock, 0 AS NumPayments, 0 AS NumDiscount
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType IN (1,2,3,4,24)
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
        UNION ALL
        SELECT 0, SUM(Amount), 0,0,0,0,0, 0, COUNT(Amount), 0,0,0,0,0
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType IN (5,8,11)
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
        UNION ALL
        SELECT 0,0, SUM(Amount), 0,0,0,0, 0,0, COUNT(Amount), 0,0,0,0
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType IN (9,10,12)
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
        UNION ALL
        SELECT 0,0,0, SUM(Amount), 0,0,0, 0,0,0, COUNT(Amount), 0,0,0
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType IN (1,8,10)
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
        UNION ALL
        SELECT 0,0,0,0, SUM(Amount), 0,0, 0,0,0,0, COUNT(Amount), 0,0
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType IN (3,5,9)
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
        UNION ALL
        SELECT 0,0,0,0,0, SUM(Amount), 0, 0,0,0,0,0, COUNT(Amount), 0
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType = 25
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
        UNION ALL
        SELECT 0,0,0,0,0,0, SUM(Amount), 0,0,0,0,0,0, COUNT(Amount)
        FROM  FinARStatementItems a INNER JOIN FinARStatements b ON a.FinARStatementID = b.FinARStatementID
        WHERE a.FinARStatementID = @ppStatementID AND HideFromStatement = 0 AND OrderType IN (26,27)
          AND a.PostDate BETWEEN b.FromDate AND DATEADD(DAY,1,b.ToDate)
      ) DRV
    `),
    req().query(`
      SELECT MAX(SalesRegular) AS TotalRegular, COUNT(DISTINCT regular.InvoiceID) AS NumRegular,
             MAX(SalesNet)     AS TotalNet,     COUNT(DISTINCT net.InvoiceID)     AS NumNet,
             MAX(SalesSuperNet) AS TotalSuperNet, COUNT(DISTINCT supernet.InvoiceID) AS NumSuperNet
      FROM   FinARStatements stat
             INNER JOIN FinARStatementItems items ON stat.FinARStatementID = items.FinARStatementID
             LEFT JOIN  InvoiceLines regular  ON regular.InvoiceID  = items.InvoiceID AND regular.PriceListType  = 1
             LEFT JOIN  InvoiceLines net      ON net.InvoiceID      = items.InvoiceID AND net.PriceListType      = 2
             LEFT JOIN  InvoiceLines supernet ON supernet.InvoiceID = items.InvoiceID AND supernet.PriceListType = 3
      WHERE  stat.FinARStatementID = @ppStatementID
        AND  items.HideFromStatement = 0
        AND  items.InvoiceID > 0
        AND  items.PostDate BETWEEN stat.FromDate AND DATEADD(DAY,1,stat.ToDate)
      GROUP BY stat.FinARStatementID, stat.CustomerID
    `),
    req().query(`
      SELECT ca.Line1, ca.Line2, ca.Locality, ca.PostCode,
             co.CountyName, r.RegionName, ct.CountryName
      FROM   FinARStatements a
             INNER JOIN Customers cust ON a.CustomerID = cust.CustomerID
             INNER JOIN CustomerAddresses ca ON ISNULL(cust.BillToID, a.CustomerID) = ca.CustomerID AND (ca.AddressType & 2) = 2
             LEFT  JOIN Counties co  ON co.CountyID   = ca.CountyID
             LEFT  JOIN Regions  r   ON r.RegionID    = ca.RegionID
             LEFT  JOIN Countries ct ON ct.CountryID  = ca.CountryID
      WHERE  a.FinARStatementID = @ppStatementID
    `)
  ]);

  if (!headerRes.recordset.length) {
    throw Object.assign(new Error('Statement not found'), { statusCode: 404 });
  }

  const h = headerRes.recordset[0];
  const aging = agingRes.recordset[0] || {};
  const os = orderSummaryRes.recordset[0] || {};
  const inv = invoiceSummaryRes.recordset[0] || {};
  const addr = customerAddrRes.recordset[0] || {};

  // Compute current-due = closing balance minus all aged amounts
  const aged = (h.AgingAmount1 || 0) + (h.AgingAmount2 || 0) + (h.AgingAmount3 || 0) + (h.AgingAmount4 || 0);
  const currentDue = Math.max(0, (h.ClosingBalance || 0) - aged);

  // Format address lines
  const addrLines = [
    addr.Line1, addr.Line2,
    [addr.Locality, addr.PostCode].filter(Boolean).join(' '),
    addr.CountyName, addr.RegionName, addr.CountryName
  ].filter(Boolean);

  // Format a date value as a display string
  const fmtDate = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return isNaN(dt) ? String(d) : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  // Map transaction items: positive Amount = debit, negative = credit
  const transactions = itemsRes.recordset.map(t => {
    const amt = parseFloat(t.Amount) || 0;
    const ref = [t.TypeName, t.Reference, t.RxNumber ? 'Rx#' + t.RxNumber : ''].filter(Boolean).join(' — ');
    return {
      date: fmtDate(t.TransactionDate),
      patient: t.Patient || '',
      desc: ref,
      debit: amt > 0 ? String(amt.toFixed(2)) : '',
      credit: amt < 0 ? String(Math.abs(amt).toFixed(2)) : ''
    };
  });

  return {
    statementId: h.FinARStatementID,
    customerName: h.CustomerName,
    accountNumber: h.AccountNumber,
    address: addrLines.join('\n'),
    periodFrom: fmtDate(h.FromDate),
    periodTo: fmtDate(h.ToDate),
    dueDate: fmtDate(h.DueDate),
    openingBalance: h.OpeningBalance,
    closingBalance: h.ClosingBalance,
    currentDue,
    agingAmount1: h.AgingAmount1 || 0,
    agingAmount2: h.AgingAmount2 || 0,
    agingAmount3: h.AgingAmount3 || 0,
    agingAmount4: h.AgingAmount4 || 0,
    agingDesc1: aging.AgingDesc1 || '30 Days',
    agingDesc2: aging.AgingDesc2 || '60 Days',
    agingDesc3: aging.AgingDesc3 || '90 Days',
    agingDesc4: aging.AgingDesc4 || '120+ Days',
    invoiceTotal: os.TotalInvoices || 0,
    creditTotal: os.TotalCredits || 0,
    debitTotal: os.TotalDebits || 0,
    rxAmount: os.TotalRx || 0,
    stockAmount: os.TotalStock || 0,
    totalPayments: os.TotalPayments || 0,
    regularBalance: inv.TotalRegular || 0,
    netAmount: inv.TotalNet || 0,
    superNetAmount: inv.TotalSuperNet || 0,
    allowance: h.Allowance || 0,
    discount: h.Discount || 0,
    eligibleDiscount: h.EligibleDiscount || 0,
    transactions
  };
}

module.exports = {
  findInvoiceItem,
  getStatement,
  listCustomers,
  listDispatchers,
  listExportCustomers,
  listPricelistCustomers,
  listShipmentItems
};
