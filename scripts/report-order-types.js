// Read-only discovery: what order types exist in the Innovations mirror, so we
// can identify which one(s) represent bulk/finished "stock" lens sales as
// opposed to per-patient Rx lab jobs. Safe to re-run any time.
const { getSourcePool } = require('../lib/db');

async function main() {
  const pool = await getSourcePool();
  try {
    const types = await pool.request().query(`
      SELECT OrderTypeID, OrderType, OrderTypeName, Credit, OrderSign
      FROM dbo.OrderTypes
      ORDER BY OrderTypeID
    `);
    console.log('OrderTypes:');
    for (const r of types.recordset) {
      console.log(`  [${r.OrderTypeID}] OrderType=${r.OrderType} name="${r.OrderTypeName}" credit=${r.Credit} sign=${r.OrderSign}`);
    }

    const volumeByType = await pool.request().query(`
      SELECT o.OrderType, COUNT(*) AS orderCount, MAX(o.RecordCreated) AS lastOrder
      FROM dbo.Orders o
      GROUP BY o.OrderType
      ORDER BY orderCount DESC
    `);
    console.log('\nOrder volume by OrderType value:');
    for (const r of volumeByType.recordset) {
      console.log(`  OrderType=${r.OrderType} count=${r.orderCount} lastOrder=${r.lastOrder}`);
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
