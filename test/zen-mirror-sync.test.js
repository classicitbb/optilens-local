const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCreateTableSql,
  buildDeleteMissingSql,
  buildMergeSql,
  coerceValue,
  formatZenTimestamp,
  mapZenTypeToSqlDecl,
} = require('../lib/zen-mirror-sync');
const { parityIssues } = require('../lib/source-backend');

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
