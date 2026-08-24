// Harness for js/history.js — run with `node test/history.test.js`.
//
// The play log used to be a section of the front page and was tested
// through the app harness. It is its own page and its own script now,
// which is exactly why it gets its own harness: history.js loads no
// app.js, so a test that needed the whole radio booted to check a list
// would be testing the wrong thing.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'history.js'), 'utf8');

// The page has exactly one element the script touches.
function makeEl() {
  return {
    innerHTML: '',
    handlers: {},
    addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); },
    click(target) { (this.handlers.click || []).forEach((fn) => fn({ target })); },
  };
}

// A stand-in for a clicked <button>: `closest` walks nothing, because
// the buttons the page renders are never nested.
const button = (cls, sid) => ({
  classList: { contains: (c) => c === cls },
  dataset: sid === undefined ? {} : { sid },
  closest: (sel) => (sel === 'button' ? button(cls, sid) : null),
});

function boot(fetchImpl) {
  const el = makeEl();
  const calls = [];
  const sandbox = {
    console,
    URLSearchParams,
    Intl,
    Date,
    document: { getElementById: (id) => (id === 'history' ? el : null) },
    fetch: async (url, opts) => { calls.push(String(url)); return fetchImpl(String(url), opts); },
  };
  sandbox.window = {
    location: {
      search: '', hostname: 'ratbat.example.com',
      protocol: 'https:', origin: 'https://ratbat.example.com',
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(source, ctx);
  vm.runInContext(';globalThis.__test = { loadHistory, render, get rows() { return rows; } };', ctx);
  return { t: ctx.__test, el, calls };
}

const settle = () => new Promise((r) => setImmediate(r));

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

const entry = (i, over = {}) => ({
  playedAt: 1755856800 + i, artist: `A${i}`, title: `T${i}`, saved: false,
  sourceURL: null, youtubeURL: null, stationID: 's1', station: 'One', ...over,
});

test('the API base follows the site host, radio. for ratbat.', async () => {
  const { calls } = boot(async () => ({ ok: true, json: async () => ({ entries: [] }) }));
  await settle();
  assert.ok(calls[0].startsWith('https://radio.example.com/history?'),
    `talks to the broadcaster, not the page host (${calls[0]})`);
});

test('paging: offsets accumulate and a short page ends the log', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => entry(i));
  const page2 = Array.from({ length: 40 }, (_, i) => entry(100 + i));
  const { t, el, calls } = boot(async (url) => ({
    ok: true, json: async () => ({ entries: url.includes('offset=0') ? page1 : page2 }),
  }));
  await settle();
  assert.strictEqual(t.rows.length, 100);
  assert.ok(el.innerHTML.includes('h-more'), 'More offered while the log continues');

  await t.loadHistory(true);
  assert.strictEqual(t.rows.length, 140, 'pages accumulate');
  assert.ok(calls[1].includes('offset=100'), `second page asks for the next offset (${calls[1]})`);
  assert.ok(!el.innerHTML.includes('h-more'), 'and More goes away at the end');
});

test('a failed fetch ends the log rather than spinning', async () => {
  const { t, el } = boot(async () => { throw new Error('offline'); });
  await settle();
  assert.strictEqual(t.rows.length, 0);
  assert.ok(!el.innerHTML.includes('h-more'), 'no More to press against a dead server');
  assert.ok(el.innerHTML.includes('Nothing played yet'), 'and it stops saying Loading');
});

test('filter: client-side over accumulated rows, and it names deleted stations', async () => {
  const rows = [
    entry(0),
    entry(1, { stationID: 's2', station: null }),
    entry(2),
  ];
  const { el } = boot(async () => ({ ok: true, json: async () => ({ entries: rows }) }));
  await settle();
  const shown = () => (el.innerHTML.match(/class="htrack"/g) || []).length;
  assert.ok(el.innerHTML.includes('(deleted station)'),
    'a station that no longer exists still labels its rows');
  assert.strictEqual(shown(), 3);

  el.click(button('h-filter', 's2'));
  assert.strictEqual(shown(), 1, 'filter narrows without re-fetching');
  el.click(button('h-filter', ''));
  assert.strictEqual(shown(), 3, 'and All restores');
});

test('rows escape what the broadcaster sent', async () => {
  const rows = [entry(0, { artist: '<img src=x onerror=alert(1)>', title: 'T&T' })];
  const { el } = boot(async () => ({ ok: true, json: async () => ({ entries: rows }) }));
  await settle();
  assert.ok(!el.innerHTML.includes('<img'), 'no live markup from the wire');
  assert.ok(el.innerHTML.includes('&lt;img'), 'escaped instead');
  assert.ok(el.innerHTML.includes('T&amp;T'), 'and ampersands survive as text');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); console.log(`ok - ${name}`); passed += 1; } catch (e) {
      console.log(`FAIL - ${name}\n    ${e.message}`); failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
