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

module.exports = {
  findInvoiceItem,
  listCustomers,
  listDispatchers,
  listExportCustomers,
  listPricelistCustomers,
  listShipmentItems
};
