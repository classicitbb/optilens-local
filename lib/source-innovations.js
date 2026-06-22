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

/**
 * All active customers for the Pricelist Builder.
 * No ShippingMethodID filter — we want every active account.
 * Extra columns (BuyingGroup, Country, City, Phone) are standard
 * Innovations fields; if any are absent the server falls back to
 * the static customers.json.
 */
async function listPricelistCustomers() {
  const pool = await getSourcePool();
  const result = await pool.request().query(`
    SELECT
      AccountNumber                             AS account,
      CustomerName                              AS name,
      ISNULL(CAST(BuyingGroup  AS nvarchar(100)), '') AS buyingGroup,
      ISNULL(CAST(Country      AS nvarchar(100)), '') AS country,
      ISNULL(CAST(City         AS nvarchar(100)), '') AS city,
      ISNULL(CAST(Phone        AS nvarchar(50)),  '') AS phone
    FROM dbo.Customers
    WHERE IsActive = 1
    ORDER BY CustomerName
  `);
  return result.recordset;
}

module.exports = {
  listDispatchers,
  listExportCustomers,
  listPricelistCustomers,
  listShipmentItems
};
