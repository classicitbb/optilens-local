'use strict';

/**
 * innovations-console-db.js — read-only Innovations source-database backend for
 * the Innovations Console. It answers the same questions the vendor REST client
 * asks (tracking, status list, Rx details, stock description) straight from the
 * source SQL Server, and returns the vendor's response shapes so the page does
 * not change. Nothing here writes.
 *
 * The data access is a seam: `query(text, params)` runs one parameterised
 * statement. Production wires it to the shared source pool (db.getSourcePool);
 * tests supply a recording fake.
 */
const sql = require('mssql');
const db = require('./db');
const { getConfig } = require('./config');

class DbError extends Error {
  constructor(message, statusCode = 400, code = 'invalid_input') {
    super(message);
    this.name = 'ConsoleError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';

async function defaultQuery(text, params = {}) {
  const pool = await db.getSourcePool();
  const request = pool.request();
  for (const [key, { type, value }] of Object.entries(params)) request.input(key, type, value);
  const result = await request.query(text);
  return result.recordset ?? [];
}

const defaultDeps = { query: defaultQuery };

const str = (value, length = 100) => ({ type: sql.NVarChar(length), value: String(value).trim() });
const int = (value) => ({ type: sql.Int, value });

function sourceHost() {
  try { return String(getConfig().sourceMssql?.server || '') || null; } catch { return null; }
}

function status() {
  return { configured: true, configSource: 'source database', host: sourceHost() };
}

// ---- tracking ------------------------------------------------------------

const ORDER_SELECT = `
  o.OrderID AS orderID, o.JobID AS trayID, o.PatientID AS patientName, o.CustomerPOReference AS poNumber,
  o.ReceivedTime AS startDate, o.CurrentStatusDate AS statusDate, si.StatusItemName AS statusName,
  o.CustomerAccount AS accountID, bt.AccountNumber AS billToAccount, st.AccountNumber AS shipToID,
  ot.OrderTypeName AS orderType, sm.ShippingMethodName AS shippingMethod,
  inv.InvoiceID AS invoiceID, inv.Iteration AS iteration,
  shp.TrackingNumber AS shippingNumber,
  CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.Farmouts f WHERE f.OrderID = o.OrderID AND f.Active = 1) THEN 1 ELSE 0 END AS bit) AS farmOutJob,
  fo.state AS farmOutState`;

const ORDER_FROM = `
  FROM dbo.Orders o
  LEFT JOIN dbo.StatusItems si ON si.StatusItemID = o.CurrentStatusID
  LEFT JOIN dbo.Customers bt ON bt.CustomerID = o.BillToID
  LEFT JOIN dbo.Customers st ON st.CustomerID = o.ShipToID
  LEFT JOIN dbo.OrderTypes ot ON ot.OrderType = o.OrderType
  LEFT JOIN dbo.ShippingMethods sm ON sm.ShippingMethodID = o.ShipMethodID
  OUTER APPLY (SELECT TOP (1) i.InvoiceID, i.Iteration FROM dbo.Invoices i WHERE i.OrderID = o.OrderID ORDER BY i.InvoiceID DESC) inv
  OUTER APPLY (SELECT TOP (1) s.TrackingNumber FROM dbo.ShipmentItems sit JOIN dbo.Shipments s ON s.ShipmentID = sit.ShipmentID
               WHERE sit.OrderID = o.OrderID AND s.TrackingNumber IS NOT NULL ORDER BY s.ShipmentID DESC) shp
  OUTER APPLY (SELECT TOP (1) CAST(f.FarmoutStatusID AS varchar(20)) AS state FROM dbo.Farmouts f WHERE f.OrderID = o.OrderID AND f.Active = 1 ORDER BY f.FarmoutID DESC) fo`;

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

function listRow(r) {
  return {
    orderType: r.orderType ?? '', invoiceID: r.invoiceID ?? null, trayID: r.trayID ?? '', orderID: r.orderID,
    poNumber: r.poNumber ?? '', patientName: r.patientName ?? '', startDate: iso(r.startDate), statusDate: iso(r.statusDate),
    statusName: r.statusName ?? '', accountID: r.accountID ?? '', billToAccount: r.billToAccount ?? '', shipToID: r.shipToID ?? '',
    iteration: r.iteration ?? 0, shippingMethod: r.shippingMethod ?? '', shippingNumber: r.shippingNumber ?? '',
    farmOutJob: Boolean(r.farmOutJob), farmOutState: r.farmOutState ?? '',
  };
}

const SEARCHES = {
  TrayID: { shape: 'single', where: '(o.JobID = @v OR o.CustomerTrayID = @v)', param: (v) => str(v, 50) },
  OrderID: {
    shape: 'single', where: 'o.OrderID = @v',
    param: (v) => {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n <= 0) throw new DbError('Order ID must be a whole number.');
      return int(n);
    },
  },
  RxID: {
    shape: 'single',
    where: 'o.JobID IN (SELECT CAST(r.Traynum AS nvarchar(50)) FROM dbo.RxJobs r WHERE CAST(r.RxNum AS nvarchar(50)) = @v)',
    param: (v) => str(v, 50),
  },
  PatientID: { shape: 'list', where: 'o.PatientID LIKE @v', param: (v) => str(`${String(v).trim()}%`, 120) },
  AccountID: { shape: 'list', where: 'o.CustomerAccount = @v', param: (v) => str(v, 50) },
};

async function getTracking({ searchType, value }, deps = defaultDeps) {
  const search = SEARCHES[searchType];
  if (!search) throw new DbError('Search type must be AccountID, TrayID, OrderID, RxID or PatientID.');
  if (!present(value)) throw new DbError('Enter a value to search for.');
  const params = { v: search.param(value) };

  const rows = await deps.query(
    `SELECT TOP (${search.shape === 'list' ? 500 : 1}) ${ORDER_SELECT} ${ORDER_FROM} WHERE ${search.where} ORDER BY o.OrderID DESC;`, params);
  if (!rows.length) return { Errors: [{ Code: 404, Message: 'No tracking records found.' }] };

  if (search.shape === 'list') {
    return { Parameters: { [searchType]: String(value).trim() }, list: rows.map(listRow) };
  }

  const order = listRow(rows[0]);
  const history = await deps.query(
    `SELECT os.StatusDate AS statusDate, si.StatusItemName AS statusName, os.Iteration AS iteration,
            COALESCE(NULLIF(u.DisplayName, N''), u.UserName) AS statusUserName,
            (SELECT TOP (1) i.InvoiceID FROM dbo.Invoices i WHERE i.OrderID = os.OrderID AND i.Iteration = os.Iteration ORDER BY i.InvoiceID DESC) AS invoiceID
     FROM dbo.OrderStatuses os
     JOIN dbo.StatusItems si ON si.StatusItemID = os.StatusItemID
     LEFT JOIN dbo.UserAccounts u ON u.UserAccountID = os.UserAccountID
     WHERE os.OrderID = @orderId AND os.StatusItemID <> -5
     ORDER BY os.StatusDate, os.OrderStatusID;`, { orderId: int(order.orderID) });

  return {
    TrayID: order.trayID, OrderID: order.orderID, PatientID: order.patientName, account: order.accountID,
    billToAccount: order.billToAccount, shipToAccount: order.shipToID, invoiceID: order.invoiceID,
    detail: history.map((h) => ({
      statusDate: iso(h.statusDate), statusName: h.statusName, scheduled: 'No',
      invoiceID: h.invoiceID ?? order.invoiceID, statusUserName: h.statusUserName ?? '',
    })),
  };
}

// ---- status list ---------------------------------------------------------

async function listStatusItems(deps = defaultDeps) {
  const rows = await deps.query(
    `SELECT StatusItemID AS ID, StatusItemName AS Name, StatusItemGroupID AS StatusGroupID
     FROM dbo.StatusItems WHERE Inactive = 0 AND ShowInMobileApp = 1
     ORDER BY StatusItemGroupID, StatusItemName;`);
  return { StatusList: rows.map((r) => ({ ID: r.ID, Name: String(r.Name).trim(), StatusGroupID: r.StatusGroupID ?? 0 })) };
}

// ---- Rx details ----------------------------------------------------------

const num = (v) => (v === null || v === undefined ? null : Number(v));

function eye(r, p) {
  const f = (name) => r[`${p}${name}`];
  return {
    Sphere: num(f('Sphere')), Cyl: num(f('Cyl')), Axis: num(f('Axis')), Base: num(f('RecBase')), CenterThick: num(f('CenterThk')),
    FPD: num(f('FarPD')), NPD: num(f('NearPD')), Add: num(f('Add')), PrismIN: num(f('PrismIn')), PrismUP: num(f('PrismUp')),
    RefractiveIndex: num(f('Index')), SegHgt: num(f('SegHeight')),
    MultiFocalType: f('LensMF') ?? null, Material: f('LensMatl') ?? null, LensType: f('LensType') ?? null, LensOption: f('LensOption') ?? null,
  };
}

async function getRxDetails({ trayId }, deps = defaultDeps) {
  if (!present(trayId)) throw new DbError('Enter a tray ID.');
  const rows = await deps.query(
    `SELECT TOP (1) r.*,
            (SELECT TOP (1) m.Name FROM dbo.Materials m WHERE m.MtrlNum = r.RLensMatl) AS RMaterialName,
            (SELECT TOP (1) m.Name FROM dbo.Materials m WHERE m.MtrlNum = r.LLensMatl) AS LMaterialName,
            (SELECT TOP (1) t.Name FROM dbo.LensType t WHERE t.Lnum = r.RLensType) AS RTypeName,
            (SELECT TOP (1) t.Name FROM dbo.LensType t WHERE t.Lnum = r.LLensType) AS LTypeName
     FROM dbo.RxJobs r
     WHERE CAST(r.Traynum AS nvarchar(50)) = @tray
     ORDER BY r.UpdateDate DESC;`, { tray: str(trayId, 50) });
  return {
    orderDetails: rows.map((r) => {
      const R = eye(r, 'R');
      const L = eye(r, 'L');
      R.Material = r.RMaterialName?.trim() ?? R.Material; L.Material = r.LMaterialName?.trim() ?? L.Material;
      R.LensType = r.RTypeName?.trim() ?? R.LensType; L.LensType = r.LTypeName?.trim() ?? L.LensType;
      return {
        PatientID: r.Patient ?? '', rxDate: iso(r.RxDate), shipByDate: iso(r.ShipByDate), iteration: r.Iteration ?? 0,
        Rx: { R, L },
      };
    }),
  };
}

// ---- stock ---------------------------------------------------------------

async function getStockDescription({ opc }, deps = defaultDeps) {
  if (!present(opc)) throw new DbError('Enter an OPC.');
  const rows = await deps.query(
    `SELECT TOP (1) li.Name, li.Fin_Semi, li.Base_Sphere, li.Add_Cyl, li.Diameter,
            li.OPC_R, li.OPC_L, li.OPC_P, li.OnHand_R, li.OnHand_L, li.OnHand_P,
            mf.Name AS ManufacturerName, mt.Name AS MaterialName
     FROM dbo.LensItem li
     LEFT JOIN dbo.LensMfgr mf ON mf.num = li.Manufacturer
     LEFT JOIN dbo.Materials mt ON mt.MtrlNum = li.Material
     WHERE li.OPC_R = @opc OR li.OPC_L = @opc OR li.OPC_P = @opc;`, { opc: str(opc, 50) });
  if (!rows.length) return { Errors: [{ Code: 404, Message: 'No stock item found for that OPC.' }] };
  const r = rows[0];
  const hundredths = (v) => (v === null || v === undefined ? '' : (Number(v) / 100).toFixed(2));
  return {
    details: {
      LensName: String(r.Name ?? '').trim(), ManufacturerName: String(r.ManufacturerName ?? '').trim(),
      FinishedOrSemiName: Number(r.Fin_Semi) === 1 ? 'Finished' : 'Semi-finished', MaterialName: String(r.MaterialName ?? '').trim(),
      LensBaseName: hundredths(r.Base_Sphere), LensAdd: hundredths(r.Add_Cyl),
      LensSizeName: r.Diameter == null ? '' : String(Number(r.Diameter) / 100),
      LensOnHand: [r.OnHand_R, r.OnHand_L, r.OnHand_P].map((v) => (v ?? 0)).join(';'),
      RightOPC: r.OPC_R ?? '', LeftOPC: r.OPC_L ?? '', PairOPC: r.OPC_P ?? '',
    },
  };
}

module.exports = { DbError, status, getTracking, listStatusItems, getRxDetails, getStockDescription };
