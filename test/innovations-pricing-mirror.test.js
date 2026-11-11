const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mirror = require('../lib/innovations-pricing-mirror');
const { normalizeEntitySelection, ENTITIES, entityFetchOptions } = require('../lib/innovations-sync');

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|EXEC|EXECUTE)\b/i;

test('pricing mirror entities are opt-in: the scheduled default selection never includes them', () => {
  const defaults = normalizeEntitySelection();
  assert.equal(defaults.filter((e) => e.startsWith('inn_')).length, 0);
  assert.deepEqual(normalizeEntitySelection(['inn_lens_items', 'inn_price_lists', 'customers']), ['customers', 'inn_price_lists', 'inn_lens_items']);
});

test('every mirror entity is registered with the 1000-row receiver batch and live pool', () => {
  assert.equal(mirror.SPECS.length, 25);
  for (const name of mirror.MIRROR_ENTITY_NAMES) {
    assert.equal(ENTITIES[name].mirror, true);
    assert.equal(ENTITIES[name].batchSize, 1000);
    assert.equal(ENTITIES[name].usesLivePool, true);
    assert.equal(typeof ENTITIES[name].read, 'function');
    assert.equal(typeof ENTITIES[name].commitSnapshot, 'function');
    assert.ok(entityFetchOptions(name).timeoutMs >= 60000);
  }
});

test('source queries are SELECT-only for every entity, full and incremental', () => {
  for (const spec of mirror.SPECS) {
    for (const since of [null, '2026-11-01T00:00:00.000Z']) {
      for (const countOnly of [false, true]) {
        const sql = mirror.buildSelect(spec, { since, countOnly });
        assert.match(sql, /^SELECT /);
        assert.doesNotMatch(sql, WRITE_WORDS, `${spec.name}: ${sql}`);
      }
    }
  }
});

test('incremental reads filter on LastUpdated; full reads do not', () => {
  const spec = mirror.SPEC_BY_NAME.inn_rx_pos_items;
  assert.doesNotMatch(mirror.buildSelect(spec, {}), /LastUpdated >/);
  assert.match(mirror.buildSelect(spec, { since: '2026-11-01T00:00:00.000Z' }), /t\.LastUpdated > CONVERT\(datetimeoffset, '2026-11-01T00:00:00.000Z', 127\)/);
  assert.throws(() => mirror.buildSelect(spec, { since: 'x; DROP TABLE dbo.Customers' }));
});

test('lens items: full run is active path only; incremental also sees ancestors and reports on_active_path', () => {
  const spec = mirror.SPEC_BY_NAME.inn_lens_items;
  const full = mirror.buildSelect(spec, {});
  assert.match(full, /INNER JOIN dbo\.LensOptions/);
  assert.match(full, /\(ISNULL\(mg\.Flags,0\) & 2\) = 0/);
  const inc = mirror.buildSelect(spec, { since: '2026-11-01T00:00:00.000Z' });
  assert.match(inc, /LEFT JOIN dbo\.MaterialGroup/);
  for (const alias of ['t', 'lo', 'lt', 'mt', 'ma', 'mg']) assert.match(inc, new RegExp(`${alias}\\.LastUpdated >`));
  assert.match(inc, /AS \[on_active_path\]/);
  assert.match(inc, /AS \[watermark_at\]/);
});

test('inn_lab_extras never selects the credential columns that live on dbo.LabExtras', () => {
  const columns = mirror.allowlist(mirror.SPEC_BY_NAME.inn_lab_extras).join(' ') + ' ' + mirror.buildSelect(mirror.SPEC_BY_NAME.inn_lab_extras, {});
  assert.doesNotMatch(columns, /AWS|GAT|Secret|JWT|PinCode|APIKey/i);
});

test('mapRow converts types, hashes content only, and the hash ignores volatile columns', () => {
  const spec = mirror.SPEC_BY_NAME.inn_price_lists;
  const row = { price_list_id: '109', parent_price_list_id: null, price_list_name: ' Wholesale ', is_active: 1, cost_plus_percent: '12.5', active_start_date: new Date('2026-01-01T00:00:00Z'), source_updated_at: new Date('2026-11-04T13:14:07Z') };
  const a = mirror.mapRow(spec, row, '2026-11-10T00:00:00.000Z');
  assert.equal(a.price_list_id, 109);
  assert.equal(a.price_list_name, 'Wholesale');
  assert.equal(a.is_active, true);
  assert.equal(a.parent_price_list_id, null);
  assert.equal(a.cost_plus_percent, 12.5);
  assert.equal(a.active_start_date, '2026-01-01T00:00:00.000Z');
  assert.match(a.source_hash, /^[0-9a-f]{64}$/);
  const b = mirror.mapRow(spec, { ...row, source_updated_at: new Date('2027-01-01T00:00:00Z') }, '2027-01-01T00:00:00.000Z');
  assert.equal(b.source_hash, a.source_hash);
  assert.notEqual(mirror.mapRow(spec, { ...row, price_list_name: 'Retail' }).source_hash, a.source_hash);
  assert.throws(() => mirror.mapRow(spec, { ...row, price_list_id: 'abc' }));
});

test('every mapped record carries exactly its receiver allowlist columns', () => {
  for (const spec of mirror.SPECS) {
    const row = {};
    for (const col of spec.cols) { const x = mirror.colSrc(col); row[x.dest] = x.type === 't' ? 'x' : x.type === 'b' ? 1 : x.type === 'd' ? new Date('2026-01-01') : 1; }
    row.source_updated_at = new Date('2026-01-01');
    assert.deepEqual(Object.keys(mirror.mapRow(spec, row)).sort(), mirror.allowlist(spec).slice().sort(), spec.name);
  }
});

test('watermark: first run is full, later runs overlap the stored watermark, --full ignores it, commit advances it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const stateFile = path.join(dir, 'state.json');
  try {
    assert.equal(mirror.sinceFor('inn_labs', { stateFile }), null);
    mirror.writeWatermark('inn_labs', '2026-11-10T20:00:00.000Z', stateFile);
    const since = mirror.sinceFor('inn_labs', { stateFile });
    assert.ok(new Date(since) < new Date('2026-11-10T20:00:00.000Z'));
    assert.equal(mirror.sinceFor('inn_labs', { stateFile, full: true }), null);
    assert.equal(mirror.sinceFor('inn_currencies', { stateFile }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reading a mirror entity (dry run) never advances the stored watermark', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const stateFile = path.join(dir, 'state.json');
  const queries = [];
  const getPool = async () => ({ request: () => ({ query: async (q) => { queries.push(q); return { recordset: [{ currency_id: 1, currency_name: 'BB$', symbol: '$', current_exchange_rate: 1, decimal_places: 2, source_updated_at: new Date('2026-05-05T10:00:00Z') }] }; } }) });
  try {
    const records = await mirror.readMirror(mirror.SPEC_BY_NAME.inn_currencies, { stateFile, getPool });
    assert.equal(records.length, 1);
    assert.match(queries[0], /^SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SELECT /);
    assert.equal(mirror.readState(stateFile).watermarks.inn_currencies, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
