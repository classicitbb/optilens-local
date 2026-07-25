const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TABLES,
  buildCreateTableSql,
  buildDeleteMissingSql,
  buildMirrorRetentionDeleteSql,
  buildMergeSql,
  buildRetentionPredicate,
  buildZenSelectList,
  buildZenSelectQuery,
  coerceValue,
  formatZenTimestamp,
  mapZenTypeToSqlDecl,
} = require('../lib/zen-mirror-sync');
const { parityIssues } = require('../lib/source-backend');

test('mirror sync includes source tables needed by live customer reads', () => {
  const mirrored = new Set(TABLES.map((table) => table.name));
  for (const table of [
    'Customers',
    'CustomerBalances',
    'FinARPeriods',
    'FinARStatements',
    'FinARStatementItems',
    'OrderTypes',
    'Orders',
    'GenStatus',
    'RxArchive',
    'StatusItems',
  ]) {
    assert.equal(mirrored.has(table), true, `${table} must be mirrored`);
  }
});

test('mirror DDL preserves source names and creates primary keys when catalog exposes them', () => {
  const sql = buildCreateTableSql('Orders', [
    { name: 'OrderID', type: 'INTEGER' },
    { name: 'CustomerAccount', type: 'VARCHAR', size: 20 },
    { name: 'LastUpdated', type: 'TIMESTAMP' },
  ], ['OrderID']);

  assert.match(sql, /CREATE TABLE dbo\.\[Orders\]/);
  assert.match(sql, /\[OrderID\] int NOT NULL/);
  assert.match(sql, /\[CustomerAccount\] nvarchar\(20\) NULL/);
  assert.match(sql, /CONSTRAINT \[PK_Orders\] PRIMARY KEY \(\[OrderID\]\)/);
});

test('mirror merge and delete reconciliation use primary keys only for identity matching', () => {
  const columns = [
    { name: 'OrderID' },
    { name: 'StatusName' },
    { name: 'LastUpdated' },
  ];

  const merge = buildMergeSql('Orders', columns, ['OrderID']);
  assert.match(merge, /MERGE dbo\.\[Orders\] AS target/);
  assert.match(merge, /ON target\.\[OrderID\] = source\.\[OrderID\]/);
  assert.doesNotMatch(merge, /target\.\[OrderID\] = source\.\[OrderID\].*UPDATE SET.*target\.\[OrderID\]/s);

  const deleteMissing = buildDeleteMissingSql('Orders', ['OrderID']);
  assert.match(deleteMissing, /DELETE target FROM dbo\.\[Orders\]/);
  assert.match(deleteMissing, /stage\.\[OrderID\] = target\.\[OrderID\]/);
});

test('Zen type mapping and value coercion are conservative for mirror writes', () => {
  assert.equal(mapZenTypeToSqlDecl({ type: 'VARCHAR', size: 120 }), 'nvarchar(120)');
  assert.equal(mapZenTypeToSqlDecl({ type: 'LONGVARCHAR' }), 'nvarchar(max)');
  assert.equal(mapZenTypeToSqlDecl({ type: 'CURRENCY' }), 'money');
  assert.equal(mapZenTypeToSqlDecl({ type: 'DECIMAL', size: 10, decimalDigits: 2 }), 'decimal(10,2)');

  assert.equal(coerceValue({ type: 'INTEGER' }, '42'), 42);
  assert.equal(coerceValue({ type: 'INTEGER' }, 'not-number'), null);
  assert.equal(coerceValue({ type: 'BIT' }, '1'), true);
  assert.equal(coerceValue({ type: 'TIMESTAMP' }, 'bad-date'), null);
});

test('source backend parity flags only material row-count drift', () => {
  assert.deepEqual(parityIssues(
    { profile: 'live', counts: { customers: 1000, shipments: 1000, orders: 1000 } },
    { profile: 'mirror', counts: { customers: 990, shipments: 1000, orders: 982 } },
  ), []);

  assert.deepEqual(parityIssues(
    { profile: 'live', counts: { customers: 1000, shipments: 1000, orders: 1000 } },
    { profile: 'mirror', counts: { customers: 900, shipments: 1000, orders: 970 } },
  ), [
    'customers: live=1,000 vs mirror=900',
    'orders: live=1,000 vs mirror=970',
  ]);
});

test('Zen timestamp literals are ODBC timestamp literals', () => {
  const text = formatZenTimestamp(new Date(2026, 6, 16, 9, 5, 7));
  assert.match(text, /^\{ts '2026-07-16 09:05:07'\}$/);
});

test('Orders initial mirror sync uses the mirror retention window instead of full table scan', () => {
  const query = buildZenSelectQuery(
    {
      name: 'Orders',
      initialRangeColumn: 'ReceivedTime',
      initialRangeDaysConfig: 'initialOrderDays',
      retentionDaysConfig: 'retentionDays',
      retentionColumns: ['ReceivedTime', 'CurrentStatusDate', 'LastUpdated'],
    },
    [{ name: 'OrderID' }, { name: 'ReceivedTime' }, { name: 'CurrentStatusDate' }, { name: 'LastUpdated' }],
    { now: new Date(Date.UTC(2026, 6, 16, 12, 0, 0)) },
  );

  assert.equal(query.sourceComplete, true);
  assert.equal(query.boundedInitial, true);
  assert.equal(query.retentionBounded, true);
  assert.equal(query.retentionDays, 92);
  assert.match(query.query, /^SELECT "OrderID", "ReceivedTime", "CurrentStatusDate", "LastUpdated" FROM "Orders" WHERE /);
  assert.match(query.query, /"ReceivedTime" >= \{ts '/);
  assert.match(query.query, /"CurrentStatusDate" >= \{ts '/);
  assert.match(query.query, /"LastUpdated" >= \{ts '/);
});

test('watermarked mirror sync uses LastUpdated and full sync remains retention bounded', () => {
  const watermarked = buildZenSelectQuery(
    {
      name: 'Orders',
      initialRangeColumn: 'ReceivedTime',
      initialRangeDaysConfig: 'initialOrderDays',
      retentionDaysConfig: 'retentionDays',
      retentionColumns: ['ReceivedTime', 'LastUpdated'],
    },
    [{ name: 'ReceivedTime' }, { name: 'LastUpdated' }],
    { watermark: new Date(2026, 6, 16, 12, 0, 0) },
  );
  assert.equal(watermarked.sourceComplete, false);
  assert.equal(watermarked.boundedInitial, false);
  assert.match(watermarked.query, /"LastUpdated" >=/);

  const full = buildZenSelectQuery(
    {
      name: 'Orders',
      initialRangeColumn: 'ReceivedTime',
      initialRangeDaysConfig: 'initialOrderDays',
      retentionDaysConfig: 'retentionDays',
      retentionColumns: ['ReceivedTime', 'LastUpdated'],
    },
    [{ name: 'ReceivedTime' }, { name: 'LastUpdated' }],
    { full: true, now: new Date(Date.UTC(2026, 6, 16, 12, 0, 0)) },
  );
  assert.equal(full.sourceComplete, true);
  assert.equal(full.boundedInitial, false);
  assert.equal(full.retentionBounded, true);
  assert.match(full.query, /^SELECT "ReceivedTime", "LastUpdated" FROM "Orders" WHERE /);
  assert.match(full.query, /"ReceivedTime" >= \{ts '/);
  assert.match(full.query, /"LastUpdated" >= \{ts '/);
});

test('unsigned Zen integer columns are selected via a widening CONVERT', () => {
  // USMALLINT values above 32767 (e.g. RxArchive.RLensItem = 50349) overflow
  // the signed C type the ODBC driver binds, failing every fetch.
  assert.equal(
    buildZenSelectList([
      { name: 'RLensItem', type: 'USMALLINT' },
      { name: 'NewStringRec', type: 'UTINYINT' },
      { name: 'SerialNum', type: 'INTEGER' },
      { name: 'Patient', type: 'VARCHAR' },
    ]),
    'CONVERT("RLensItem", SQL_INTEGER) AS "RLensItem", CONVERT("NewStringRec", SQL_SMALLINT) AS "NewStringRec", "SerialNum", "Patient"',
  );

  const query = buildZenSelectQuery(
    { name: 'RxArchive' },
    [{ name: 'RLensItem', type: 'USMALLINT' }, { name: 'LastUpdated', type: 'TIMESTAMP' }],
    { full: true },
  );
  assert.equal(query.query, 'SELECT CONVERT("RLensItem", SQL_INTEGER) AS "RLensItem", "LastUpdated" FROM "RxArchive"');
});

test('mirror retention predicates keep recent rows and open shipments', () => {
  const table = {
    name: 'Shipments',
    retentionDaysConfig: 'retentionDays',
    retentionColumns: ['ShippedTime', 'RecordCreated', 'LastUpdated'],
    retainOpenShipments: true,
  };
  const columns = [
    { name: 'ShipmentID' },
    { name: 'Shipped' },
    { name: 'ShippedTime' },
    { name: 'RecordCreated' },
    { name: 'LastUpdated' },
  ];

  const sourcePredicate = buildRetentionPredicate(table, columns, (name) => `"${name}"`, "{ts '2026-04-15 00:00:00'}");
  assert.match(sourcePredicate, /"ShippedTime" >= \{ts '2026-04-15 00:00:00'\}/);
  assert.match(sourcePredicate, /"RecordCreated" >= \{ts '2026-04-15 00:00:00'\}/);
  assert.match(sourcePredicate, /"LastUpdated" >= \{ts '2026-04-15 00:00:00'\}/);
  assert.match(sourcePredicate, /\("Shipped" = 0 OR "Shipped" IS NULL\)/);

  const pruneSql = buildMirrorRetentionDeleteSql(table, columns);
  assert.match(pruneSql, /^DELETE FROM dbo\.\[Shipments\] WHERE NOT /);
  assert.match(pruneSql, /\[ShippedTime\] >= @cutoff/);
  assert.match(pruneSql, /\(\[Shipped\] = 0 OR \[Shipped\] IS NULL\)/);
});
