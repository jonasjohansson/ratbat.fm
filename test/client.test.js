// Zero-dependency test harness for js/app.js — run with `node test/client.test.js`.
// app.js is a classic browser script, so we evaluate it inside a `vm`
// context with just enough DOM stubbed to boot, then poke the top-level
// functions through an appended __test expose (function/var declarations
// land on the vm's globalThis; let/const don't, hence the explicit list).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

// --- Browser stubs ----------------------------------------------------

function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    // <audio> surface
    paused: true,
    readyState: 0,
    src: '',
    play: async () => {},
    pause() {},
    load() {},
  };
}

class FakeEventSource {
  constructor(url) {
    FakeEventSource.instances.push(this);
    this.url = url;
    this.listeners = {};
    this.closed = false;
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
  }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  close() { this.closed = true; }
  emit(name, data) {
    const e = { data };
    if (name === 'message' && this.onmessage) this.onmessage(e);
    (this.listeners[name] || []).forEach((fn) => fn(e));
  }
  open() { if (this.onopen) this.onopen(); }
  fail() { if (this.onerror) this.onerror(); }
}

// Build a fresh vm context, evaluate app.js in it, and hand back handles.
function boot(opts = {}) {
  FakeEventSource.instances = [];
  const els = { stations: makeEl(), audio: makeEl(), lock: makeEl(), history: makeEl() };
  const state = {
    nowMs: 0,
    timers: [],     // recorded setTimeout calls: {fn, ms}
    intervals: [],  // recorded setInterval calls: {fn, ms}
    store: new Map(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stations: [] }) }),
    fetchCalls: [],
  };
  if (opts.storedKey) state.store.set('ratbat_key', opts.storedKey);
  if (opts.fetchImpl) state.fetchImpl = opts.fetchImpl;

  const location = {
    search: '', hash: '', pathname: '/',
    hostname: 'ratbat.example.com', protocol: 'https:', origin: 'https://ratbat.example.com',
  };
  const sandbox = {
    console,
    URLSearchParams,
    performance: { now: () => state.nowMs },
    setTimeout: (fn, ms) => state.timers.push({ fn, ms }),
    clearTimeout: () => {},
    setInterval: (fn, ms) => state.intervals.push({ fn, ms }),
    clearInterval: () => {},
    localStorage: {
      getItem: (k) => (state.store.has(k) ? state.store.get(k) : null),
      setItem: (k, v) => state.store.set(k, String(v)),
      removeItem: (k) => state.store.delete(k),
    },
    fetch: (...args) => { state.fetchCalls.push(args); return state.fetchImpl(...args); },
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener() {},
      querySelectorAll: () => [],
      visibilityState: 'visible',
      hidden: false,
      title: '',
    },
    history: { replaceState() {} },
    EventSource: FakeEventSource,
  };
  sandbox.window = { location, EventSource: FakeEventSource, open() {} };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(source + `
;globalThis.__test = {
  fmtClock, fmtTime, progressText, friendlyError, apiPost, adoptNow,
  checkOwnerKey, validateStoredKey, sendAction, render, schedulePoll,
  connectEvents, refresh,
  displayDelayFor: displayDelayFor,
  get stations() { return stations; },
  get sseAlive() { return sseAlive; },
  set sseAlive(v) { sseAlive = v; },
  get pollFailures() { return pollFailures; },
  set activeId(id) { activeId = id; },
};`, ctx);
  return { t: ctx.__test, els, state, ctx };
}

const settle = () => new Promise((r) => setImmediate(r));

// --- Runner -----------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- Tests ------------------------------------------------------------

test('fmtClock renders m:ss', ({ t }) => {
  assert.strictEqual(t.fmtClock(0), '0:00');
  assert.strictEqual(t.fmtClock(65), '1:05');
  assert.strictEqual(t.fmtClock(365), '6:05');
  assert.strictEqual(t.fmtClock(-3), '0:00');
});

test('displayDelayFor: 10s ceiling, third-of-runtime for short tracks, 2s floor', ({ t }) => {
  assert.strictEqual(t.displayDelayFor(null), 10000);
  assert.strictEqual(t.displayDelayFor({ durationSeconds: null }), 10000);
  assert.strictEqual(t.displayDelayFor({ durationSeconds: 600 }), 10000);
  assert.strictEqual(t.displayDelayFor({ durationSeconds: 15 }), 5000);
  assert.strictEqual(t.displayDelayFor({ durationSeconds: 3 }), 2000);
});

test('friendlyError maps statuses, prefers short server messages otherwise', ({ t }) => {
  assert.strictEqual(t.friendlyError(403, { message: 'ignored' }), 'Passcode no longer valid');
  assert.strictEqual(t.friendlyError(410, {}), 'Station no longer exists');
  assert.strictEqual(t.friendlyError(422, {}), 'Check the form');
  assert.strictEqual(t.friendlyError(503, {}), 'Broadcaster hiccup — try again');
  assert.strictEqual(t.friendlyError(500, {}), 'Broadcaster hiccup — try again');
  assert.strictEqual(t.friendlyError(400, { message: 'nope' }), 'nope');
  assert.strictEqual(t.friendlyError(400, {}), 'Broadcaster hiccup — try again');
});

test('apiPost: 403 drops the stored key centrally', async () => {
  const { t, state } = boot({
    storedKey: 'stale',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  await settle();
  const res = await t.apiPost('/like', { station: 'x', token: 'stale' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(state.store.has('ratbat_key'), false);
});

test('apiPost: network failure throws (callers distinguish no from unreachable)', async () => {
  const { t } = boot({ fetchImpl: async () => { throw new Error('down'); } });
  await settle();
  await assert.rejects(() => t.apiPost('/auth', { token: 'k' }));
  assert.strictEqual(await t.checkOwnerKey('k'), null);
});

test('validateStoredKey: 403 clears, network error keeps the key', async () => {
  const bad = boot({
    storedKey: 'rotated',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  await settle();
  await bad.t.validateStoredKey();
  assert.strictEqual(bad.state.store.has('ratbat_key'), false);

  const offline = boot({ storedKey: 'kept', fetchImpl: async () => { throw new Error('down'); } });
  await settle();
  await offline.t.validateStoredKey();
  assert.strictEqual(offline.state.store.get('ratbat_key'), 'kept');
});

const payload = (track) => ({
  stations: [{
    id: 'S1', slug: 's1', name: 'One', streamURL: '/streams/s1', listeners: 1,
    currentTrack: track, recent: [
      { artist: 'Old', title: 'Row', playedAt: 1755856800, entryID: 'e1' },
    ],
  }],
});
const trackA = {
  title: 'Alpha', artist: 'Artist A', album: 'LP One',
  durationSeconds: 365, origin: 'lastFM', sourceURL: null, youtubeURL: null,
};

test('adoptNow absolutizes streamURL and renders album / origin / progress / playedAt', async () => {
  const { t, els } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload(trackA));
  assert.strictEqual(t.stations[0].streamURL, 'https://radio.example.com/streams/s1');
  const html = els.stations.innerHTML;
  assert.ok(html.includes('class="album"') && html.includes('LP One'), 'album line');
  assert.ok(html.includes('>Last.fm<'), 'origin badge mapped');
  assert.ok(html.includes('0:00 / 6:05'), 'textual progress');
  assert.ok(html.includes('class="ttime"'), 'recent playedAt time');
});

test('progressText ticks with the clock and clamps to duration', async () => {
  const { t, state } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload(trackA));
  state.nowMs = 65_000;
  assert.strictEqual(t.progressText('S1'), '1:05 / 6:05');
  state.nowMs = 999_000;
  assert.strictEqual(t.progressText('S1'), '6:05 / 6:05');
});

test('display lag: new track held displayDelayFor(pending), then settles', async () => {
  const { t, els, state } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload(trackA));
  t.render();
  const trackB = { ...trackA, title: 'Beta', album: null, durationSeconds: 15 };
  t.adoptNow(payload(trackB));
  assert.ok(els.stations.innerHTML.includes('Alpha'), 'old title held during lag');
  state.nowMs = 5_100; // > displayDelayFor(B) = 5000
  t.render();
  assert.ok(els.stations.innerHTML.includes('Beta'), 'settles after the derived delay');
});

test('SSE: boot connects, open silences polling, frames adopt on both paths', async () => {
  const { t, els, state } = boot();
  await settle(); // refresh().then(connectEvents + schedulePoll)
  assert.strictEqual(FakeEventSource.instances.length, 1);
  const es = FakeEventSource.instances[0];
  assert.strictEqual(es.url, 'https://radio.example.com/events');
  es.open();
  assert.strictEqual(t.sseAlive, true);
  es.emit('message', JSON.stringify(payload(trackA))); // today's unnamed frames
  assert.ok(els.stations.innerHTML.includes('Alpha'));
  es.emit('now', JSON.stringify(payload({ ...trackA, title: 'Named' }))); // future named
  assert.ok(els.stations.innerHTML.includes('Named'));
  const before = state.fetchCalls.length;
  es.emit('stations', '{}'); // notification only — must re-fetch, never trust the body
  await settle();
  assert.strictEqual(state.fetchCalls.length, before + 1);
});

test('SSE: error backs off with a reconnect timer and resumes polling', async () => {
  const { t, state } = boot();
  await settle();
  const es = FakeEventSource.instances[0];
  es.open();
  state.timers.length = 0;
  es.fail();
  assert.strictEqual(t.sseAlive, false);
  assert.ok(es.closed, 'errored source closed');
  // Two timers land: the reconnect (~1s + jitter) and the fallback poll.
  assert.strictEqual(state.timers.length, 2);
  assert.ok(state.timers[0].ms >= 1000 && state.timers[0].ms <= 1200, `reconnect ${state.timers[0].ms}`);
  state.timers[0].fn(); // run the reconnect
  assert.strictEqual(FakeEventSource.instances.length, 2);
});

test('poll backoff: failures grow the delay, success resets it', async () => {
  const { t, state } = boot();
  await settle();
  state.fetchImpl = async () => { throw new Error('down'); };
  await t.refresh();
  await t.refresh();
  assert.strictEqual(t.pollFailures, 2);
  state.timers.length = 0;
  t.schedulePoll();
  assert.strictEqual(state.timers[0].ms, 6000); // POLL_FAST * 2^2
  state.fetchImpl = async () => ({ ok: true, status: 200, json: async () => payload(trackA) });
  await t.refresh();
  assert.strictEqual(t.pollFailures, 0);
});

test('apiPost: 403 on a candidate key leaves the stored key alone', async () => {
  // /auth accepts only the stored key; anything else is a wrong guess.
  const { t, state } = boot({
    storedKey: 'valid',
    fetchImpl: async (url, opts) => {
      if (String(url).endsWith('/auth')) {
        const ok = JSON.parse(opts.body).token === 'valid';
        return { ok, status: ok ? 200 : 403, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ stations: [] }) };
    },
  });
  await settle();
  // Legacy #key= links probe arbitrary passcodes — a wrong guess must
  // not log out the session that was fine the whole time.
  assert.strictEqual(await t.checkOwnerKey('stale-bookmark'), false);
  assert.strictEqual(state.store.get('ratbat_key'), 'valid');
});

test('SSE: repeated reconnect failures do not reset the pending poll timer', async () => {
  const { state } = boot();
  await settle();
  const es = FakeEventSource.instances[0];
  es.open(); // clears the boot poll timer — SSE owns freshness
  state.timers.length = 0;
  es.fail(); // schedules the reconnect + the fallback poll
  assert.strictEqual(state.timers.length, 2);
  state.timers[0].fn(); // run the reconnect; the replacement fails too
  const es2 = FakeEventSource.instances[1];
  state.timers.length = 0;
  es2.fail();
  // Only the next reconnect may land — the pending poll keeps its slot,
  // or a fast retry cadence would keep pushing the next poll out forever.
  assert.strictEqual(state.timers.length, 1);
});

test('SSE open resets the poll backoff (the stream proves reachability)', async () => {
  const { t, state } = boot();
  await settle();
  state.fetchImpl = async () => { throw new Error('down'); };
  await t.refresh();
  assert.strictEqual(t.pollFailures, 1);
  FakeEventSource.instances[0].open();
  assert.strictEqual(t.pollFailures, 0);
});

test('schedulePoll is a no-op while SSE is alive', async () => {
  const { t, state } = boot();
  await settle();
  t.sseAlive = true;
  state.timers.length = 0;
  t.schedulePoll();
  assert.strictEqual(state.timers.length, 0);
});

// --- Go ---------------------------------------------------------------

(async () => {
  for (const { name, fn } of tests) {
    // Pure-helper tests get a default context lazily.
    try {
      let arg;
      if (fn.length > 0) { arg = boot(); await settle(); }
      await fn(arg);
      console.log(`ok - ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL - ${name}\n    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
