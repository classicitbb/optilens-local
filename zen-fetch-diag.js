const zen = require("./lib/zen-source");
(async () => {
  const c = await zen.connectZen();
  const cur = await c.query(`SELECT * FROM "FinARSalesJournal"`, { cursor: true, fetchSize: 1000 });
  let n = 0, errors = 0, consecutiveErrors = 0;
  while (!cur.noData && consecutiveErrors < 5) {
    try { const b = await cur.fetch(); n += (b || []).length; consecutiveErrors = 0; }
    catch (e) { errors++; consecutiveErrors++; console.log("fetch error at ~row", n, ":", (e.odbcErrors || [])[0]?.message || e.message); }
  }
  console.log("done: rows", n, "errors", errors, "noData", cur.noData);
  try { await cur.close(); } catch {}
  await c.close();
})().catch((e) => { console.log("fatal:", e.message); process.exit(1); });
