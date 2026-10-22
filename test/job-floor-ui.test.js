const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createSound } = require('../public/job-floor-sound');

const flush = () => new Promise(setImmediate);
class Element {
  constructor() { this.value = ''; this.children = []; this.events = {}; this.dataset = {}; this.options = [{ text: 'Final PASS' }]; this.selectedIndex = 0; }
  addEventListener(name, handler) { this.events[name] = handler; }
  focus() {}
  get firstElementChild() { return this.children[0]; }
  insertBefore(child) { this.children.unshift(child); }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
}
async function page(post, { loadError = false } = {}) {
  const elements = Object.fromEntries(['StatusForm', 'StatusItem', 'StatusValue', 'Log', 'Icon', 'SoundButton'].map(id => ['jf' + id, new Element()]));
  const events = {}, calls = [], sounds = [];
  const document = {
    hidden: false, getElementById: id => elements[id], createElement: () => new Element(),
    addEventListener: (name, handler) => { events[name] = handler; }
  };
  const window = { JobFloorSound: { createSound: () => ({ unlock: async () => true, play: ok => sounds.push(ok) }) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/job-floor.js'), 'utf8'), {
    window, document, localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url, options) => {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body); calls.push(body);
        return post(body);
      }
      if (loadError) throw Error('Source unavailable');
      return response(url.endsWith('status-items') ? { rows: [{ ID: 27, name: 'Final PASS' }] } : { writesEnabled: true });
    }
  });
  events.DOMContentLoaded();
  await flush();
  return {
    elements, events, calls, sounds,
    scan(value) {
      elements.jfStatusValue.value = value;
      elements.jfStatusValue.events.keydown({ key: 'Enter', preventDefault() {} });
    },
    lines: () => elements.jfLog.children.map(row => row.textContent)
  };
}
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => data });
const success = () => response({ ok: true, dryRun: false, result: { applied: true, verified: true } });

test('confirmed success sounds once; an existing status is an explicit duplicate with an error cue', async () => {
  let duplicate = false;
  const p = await page(() => duplicate ? response({ ok: true, result: { alreadyApplied: true, verified: true } }) : success());
  p.scan('101'); await flush();
  assert.deepEqual(p.sounds, [true]);
  assert.match(p.lines()[0], /^Success:/);
  duplicate = true;
  p.scan('101'); await flush();
  assert.deepEqual(p.sounds, [true, false]);
  assert.match(p.lines()[0], /^Duplicate:.*No change made/);
});

test('pending duplicate sends no second request while distinct trays remain ordered', async () => {
  let release;
  const p = await page(() => new Promise(resolve => { release = resolve; }));
  p.scan('101'); p.scan('101'); p.scan('102');
  await flush();
  assert.deepEqual(p.calls.map(call => call.trayId), ['101']);
  assert.deepEqual(p.sounds, [false]);
  assert.match(p.lines()[0], /Duplicate:.*already queued/);
  release(success()); await flush();
  assert.deepEqual(p.calls.map(call => call.trayId), ['101', '102']);
  release(success()); await flush();
  assert.deepEqual(p.sounds, [false, true, true]);
  p.scan('101'); await flush();
  assert.equal(p.calls.length, 3, 'completed entries are not permanently suppressed');
  release(success()); await flush();
});

test('scan failures and malformed/unverified responses never play a success cue', async () => {
  for (const error of ['Bad scan', 'Tray not found', 'Tray is empty', 'Order not found', 'Order changed', 'Permission denied']) {
    const p = await page(() => response({ error }, false));
    p.scan('101'); await flush();
    assert.deepEqual(p.sounds, [false]);
    assert.ok(p.lines()[0].includes(error));
  }
  for (const result of [{}, { ok: false }, { ok: true, result: { applied: true } }]) {
    const p = await page(() => response(result));
    p.scan('101'); await flush();
    assert.deepEqual(p.sounds, [false]);
  }
  const p = await page(() => { throw Error('Network unavailable'); });
  p.scan('101'); await flush();
  assert.deepEqual(p.sounds, [false]);
  p.scan('101'); await flush();
  assert.equal(p.calls.length, 2, 'failed requests can be retried');
});

test('empty scans, missing status and source-load errors are audible; held Enter is ignored', async () => {
  const p = await page(success);
  p.scan(' ');
  p.elements.jfStatusItem.value = '';
  p.scan('101');
  p.elements.jfStatusValue.events.keydown({ key: 'Enter', repeat: true, preventDefault() {} });
  assert.deepEqual(p.sounds, [false, false]);
  assert.equal(p.calls.length, 0);
  const failed = await page(success, { loadError: true });
  assert.deepEqual(failed.sounds, [false]);
  assert.match(failed.lines()[0], /Source unavailable/);
});

test('preview and preview duplicate keep their true result labels and distinct cues', async () => {
  for (const duplicate of [false, true]) {
    const p = await page(() => response({ ok: true, dryRun: true, plan: { alreadyApplied: duplicate } }));
    p.scan('101'); await flush();
    assert.deepEqual(p.sounds, [!duplicate]);
    assert.match(p.lines()[0], duplicate ? /^Duplicate:/ : /^Preview:/);
  }
});

function audioHarness({ fail = false } = {}) {
  const notes = [], availability = [];
  let context;
  class Context {
    constructor() { context = this; this.state = 'suspended'; this.currentTime = 10; this.destination = {}; }
    async resume() { if (fail) throw Error('Blocked'); this.state = 'running'; }
    createOscillator() {
      const note = { frequency: { setValueAtTime: value => { note.hz = value; } }, connect() {}, disconnect() {}, start: time => { note.at = time; }, stop: time => { note.end = time; } };
      notes.push(note); return note;
    }
    createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }; }
  }
  const sound = createSound({ AudioContext: Context, onReady: (...args) => availability.push(args) });
  return { sound, notes, availability, context: () => context };
}

test('sound unlocks from interaction, uses two high success notes and three descending error notes', async () => {
  const a = audioHarness();
  assert.equal(a.sound.play(true), false);
  assert.equal(a.context(), undefined, 'no AudioContext before a gesture');
  assert.equal(await a.sound.unlock(), true);
  assert.equal(a.sound.play(true), true);
  assert.equal(a.sound.play(false), true);
  assert.deepEqual(a.notes.map(note => note.hz), [988, 1319, 220, 165, 110]);
  assert.ok(a.notes[2].at > a.notes[1].end, 'outcomes do not overlap');
  a.context().state = 'suspended';
  assert.equal(a.sound.play(true), false);
  assert.deepEqual(a.availability.at(-1), [false, true]);
  assert.equal(await a.sound.unlock(), true);
});

test('blocked or unsupported audio stays recoverable without throwing into scan processing', async () => {
  const a = audioHarness({ fail: true });
  assert.equal(await a.sound.unlock(), false);
  assert.equal(a.sound.play(false), false);
  const unsupported = createSound({ onReady() {} });
  assert.equal(await unsupported.unlock(), false);
  assert.equal(unsupported.play(true), false);
});

test('immediate validation feedback waits for the first gesture audio resume', async () => {
  const a = audioHarness();
  await a.sound.unlock();
  a.context().state = 'suspended';
  let resume;
  a.context().resume = () => new Promise(resolve => { resume = () => { a.context().state = 'running'; resolve(); }; });
  const unlocking = a.sound.unlock();
  assert.equal(a.sound.play(false), false);
  assert.equal(a.notes.length, 0);
  resume(); await unlocking; await flush();
  assert.deepEqual(a.notes.map(note => note.hz), [220, 165, 110]);
});
