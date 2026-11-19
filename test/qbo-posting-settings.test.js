'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPostingSettings, savePostingSettings } = require('../lib/qbo-posting-settings');
const { holdReasons } = require('../lib/qbo-invoice-review');

const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qbo-posting-')), 'nested', 'qbo-posting.json');

test('auto-post is off when nothing has been saved or the file is unreadable', () => {
  const file = temp();
  assert.equal(readPostingSettings(file).autoPost, false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.equal(readPostingSettings(file).autoPost, false);
});

test('saving turns auto-post on and off and records who changed it', () => {
  const file = temp();
  const on = savePostingSettings({ autoPost: true, changedBy: 7 }, file);
  assert.equal(on.autoPost, true);
  assert.deepEqual({ ...readPostingSettings(file), changedAt: null }, { autoPost: true, changedAt: null, changedBy: 7 });
  assert.equal(savePostingSettings({ autoPost: false }, file).autoPost, false);
  assert.equal(readPostingSettings(file).autoPost, false);
});

test('only a literal true counts as on', () => {
  const file = temp();
  assert.equal(savePostingSettings({ autoPost: 'true' }, file).autoPost, false);
});

test('auto-post candidates are exactly the invoices with no review holds', () => {
  assert.deepEqual(holdReasons({ taxAmount: 0, isCredit: false, total: 120 }), []);
  assert.ok(holdReasons({ taxAmount: 17.5, isCredit: false, total: 120 }).length > 0);
  assert.ok(holdReasons({ taxAmount: 0, isCredit: true, total: -120 }).length > 0);
  assert.ok(holdReasons({ taxAmount: 0, isCredit: false, total: 90000 }).length > 0);
});
