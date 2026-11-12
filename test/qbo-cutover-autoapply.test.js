const test = require('node:test');
const assert = require('node:assert/strict');

const { cutoverDate, effectiveFromDate, productionAutoApplyEnabled } = require('../lib/qbo-invoice-sync');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const production = { environment: 'production' };
const sandbox = { environment: 'sandbox' };

test('production sync refuses to run without a cutover date', () => {
  withEnv({ OPTILENS_QBO_CUTOVER_DATE: undefined }, () => {
    assert.throws(() => effectiveFromDate(production, '2026-08-01'), /OPTILENS_QBO_CUTOVER_DATE/);
    assert.equal(effectiveFromDate(sandbox, '2026-08-01'), '2026-08-01');
  });
});

test('invoices before the cutover are never discovered', () => {
  withEnv({ OPTILENS_QBO_CUTOVER_DATE: '2026-12-01' }, () => {
    assert.equal(effectiveFromDate(production, '2026-08-01'), '2026-12-01');
    assert.equal(effectiveFromDate(production, null), '2026-12-01');
    assert.equal(effectiveFromDate(production, '2026-12-15'), '2026-12-15');
  });
});

test('a malformed cutover date fails closed', () => {
  withEnv({ OPTILENS_QBO_CUTOVER_DATE: '12/01/2026' }, () => {
    assert.throws(() => cutoverDate(), /YYYY-MM-DD/);
  });
});

test('automatic apply needs both the apply gate and the auto-apply setting', () => {
  withEnv({ OPTILENS_QBO_PRODUCTION_APPLY_ENABLED: undefined, OPTILENS_QBO_PRODUCTION_AUTO_APPLY: 'true' }, () => assert.equal(productionAutoApplyEnabled(), false));
  withEnv({ OPTILENS_QBO_PRODUCTION_APPLY_ENABLED: 'true', OPTILENS_QBO_PRODUCTION_AUTO_APPLY: undefined }, () => assert.equal(productionAutoApplyEnabled(), false));
  withEnv({ OPTILENS_QBO_PRODUCTION_APPLY_ENABLED: 'true', OPTILENS_QBO_PRODUCTION_AUTO_APPLY: 'true' }, () => assert.equal(productionAutoApplyEnabled(), true));
});
