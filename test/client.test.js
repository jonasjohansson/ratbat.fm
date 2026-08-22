// Zero-dependency test harness for js/app.js + js/panels.js — run with
// `node test/client.test.js`. Both are classic browser scripts sharing
// one global lexical scope, so we evaluate them concatenated (app.js
// first, mirroring the defer order) inside a `vm` context with just
// enough DOM stubbed to boot, then poke the top-level functions through
// an appended __test expose (function/var declarations land on the vm's
// globalThis; let/const don't, hence the explicit list).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const panelsSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');

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
    querySelector: () => null,
    hidden: false,
    // <dialog> surface — no showModal on purpose: the delete confirm
    // then takes its native-prompt fallback, which the sandbox `prompt`
    // below can script.
    open: false,
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
  const els = {
    stations: makeEl(), audio: makeEl(), lock: makeEl(),
    panelbar: makeEl(), panel: makeEl(), dlg: makeEl(),
  };
  const state = {
    nowMs: 0,
    timers: [],     // recorded setTimeout calls: {fn, ms}
    intervals: [],  // recorded setInterval calls: {fn, ms}
    store: new Map(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stations: [] }) }),
    fetchCalls: [],
    promptResponse: null,
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
    Intl,
    prompt: () => state.promptResponse,
  };
  sandbox.window = { location, EventSource: FakeEventSource, open() {} };
  const ctx = vm.createContext(sandbox);
  // Two separate scripts, not a concatenation — concatenating would
  // hoist panels.js's function declarations above app.js's boot code,
  // which the browser's two-script defer order never does. Separate
  // runInContext calls share the context's global lexical scope exactly
  // the way sibling <script> tags do.
  vm.runInContext(source, ctx);
  vm.runInContext(panelsSource, ctx);
  vm.runInContext(`
;globalThis.__test = {
  fmtClock, fmtTime, progressText, friendlyError, apiPost, adoptNow,
  checkOwnerKey, validateStoredKey, sendAction, render, schedulePoll,
  connectEvents, refresh, probeHealth,
  displayDelayFor: displayDelayFor,
  get stations() { return stations; },
  get sseAlive() { return sseAlive; },
  set sseAlive(v) { sseAlive = v; },
  get pollFailures() { return pollFailures; },
  set activeId(id) { activeId = id; },
  // panels.js surface
  renderPanelBar, openPanel, closePanel, healthStripHTML, fmtSpan,
  loadOwnerStations, renderStationsPanel, loadHistory, renderHistoryPanel,
  buildStationBody, editorFrom, newEditor, validateEditor, nameMatches,
  deleteStationFlow, submitEditor,
  get capabilities() { return capabilities; },
  get activePanel() { return activePanel; },
  get ownerStations() { return ownerStations; },
  set ownerStations(v) { ownerStations = v; },
  get historyRows() { return historyRows; },
  get historyDone() { return historyDone; },
  set historyFilter(v) { historyFilter = v; },
  get editor() { return editor; },
  set editor(v) { editor = v; },
};`, ctx);
  return { t: ctx.__test, els, state, ctx };
}

const settle = () => new Promise((r) => setImmediate(r));

// Objects built inside the vm have the vm realm's prototypes, which
// deepStrictEqual refuses to match against host literals. JSON
// round-tripping strips the realm — and compares exactly what would go
// on the wire, which is the point of these assertions anyway.
const wire = (o) => JSON.parse(JSON.stringify(o));

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

// --- Panels (W2/W3) ---------------------------------------------------

// Route table for fetch stubs: path → ({body}, url) => {status, body}.
// Unrouted paths answer 200 {stations:[]} — good enough for /now.json
// and /auth in tests that don't care.
const routed = (map) => async (url, opts) => {
  const u = String(url);
  const p = u.replace(/^https:\/\/radio\.example\.com/, '').split('?')[0];
  const handler = map[p];
  if (!handler) return { ok: true, status: 200, json: async () => ({ stations: [] }) };
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  const r = await handler(body, u);
  return { ok: r.status < 300, status: r.status, json: async () => r.body };
};

const HEALTH = {
  status: 'ok', version: '1.0',
  capabilities: ['health', 'stations', 'vocab'],
  uptimeSeconds: 3 * 86400 + 4 * 3600 + 120,
  broadcastingCount: 2,
  stations: [
    { id: 'a', name: 'One', slug: 'one', broadcasting: true,
      liveness: 'onAirAndPlaying',
      lastGap: { start: 1755856800, end: 1755857160 } },
  ],
};

// A /stations/list station in the pinned flat wire shape.
const srvNTS = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'NTS Dub', slug: 'nts-dub', kind: 'nts',
  broadcasting: true, autoStart: false,
  query: {
    genreTags: ['dub', 'roots'], yearMin: null, yearMax: null,
    regions: [], tagMatch: 'any', popularity: 'middle',
    excludeOwnedLibrary: false, excludedArtists: ['Bad Act'],
  },
  exploration: null, sort: null, shufflePool: true, trackCount: null,
};
const srvPlaylist = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Mixtape', slug: 'mixtape', kind: 'playlist',
  broadcasting: false, autoStart: true,
  query: null, exploration: null, sort: null, shufflePool: null,
  trackCount: 12,
};

const ownerBoot = (extraRoutes = {}) => boot({
  storedKey: 'valid',
  fetchImpl: routed({
    '/health': () => ({ status: 200, body: HEALTH }),
    '/auth': (b) => ({ status: b.token === 'valid' ? 200 : 403, body: {} }),
    ...extraRoutes,
  }),
});

test('capabilities: old server (/health 404) shows no owner panels, no strip', async () => {
  const { t, els } = boot({
    storedKey: 'valid',
    fetchImpl: routed({ '/health': () => ({ status: 404, body: {} }) }),
  });
  await settle();
  assert.deepStrictEqual(wire(t.capabilities), []);
  t.renderPanelBar();
  assert.ok(els.panelbar.innerHTML.includes('data-panel="history"'), 'history stays');
  assert.ok(!els.panelbar.innerHTML.includes('data-panel="stations"'), 'no stations button');
  assert.ok(!els.panelbar.innerHTML.includes('class="health"'), 'no strip');
  // openPanel refuses a gated panel outright — no half-open owner UI.
  await t.openPanel('stations');
  assert.strictEqual(t.activePanel, null);
});

test('capabilities: new server + owner key → stations button and health strip', async () => {
  const { t, els } = ownerBoot();
  await settle();
  assert.deepStrictEqual(t.capabilities, ['health', 'stations', 'vocab']);
  t.renderPanelBar();
  const bar = els.panelbar.innerHTML;
  assert.ok(bar.includes('data-panel="stations"'), 'stations button');
  assert.ok(bar.includes('on air'), 'on-air strip');
  assert.ok(bar.includes('3d 4h'), 'uptime');
  assert.ok(bar.includes('2 live'), 'broadcasting count');
  assert.ok(bar.includes('gap 6m'), 'most recent gap');
});

test('capabilities: guest never sees the stations panel even when the server has it', async () => {
  const { t, els } = boot({
    fetchImpl: routed({ '/health': () => ({ status: 200, body: HEALTH }) }),
  });
  await settle();
  t.renderPanelBar();
  assert.ok(!els.panelbar.innerHTML.includes('data-panel="stations"'));
  assert.ok(els.panelbar.innerHTML.includes('class="health"'), 'strip is public');
});

test('stations panel: 503 shows "catalogue unavailable" instead of hiding', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({
      status: 503, body: { status: 'error', message: 'catalogue unavailable' },
    }),
  });
  await settle();
  await t.openPanel('stations');
  assert.strictEqual(els.panel.hidden, false, 'panel stays visible');
  assert.ok(els.panel.innerHTML.includes('catalogue unavailable'));
});

test('stations panel: lists idle + live, playlist rows are read-only', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvNTS, srvPlaylist] } }),
  });
  await settle();
  await t.openPanel('stations');
  const html = els.panel.innerHTML;
  assert.ok(html.includes('NTS Dub') && html.includes('Mixtape'), 'both rows');
  assert.ok(html.includes('>Stop<'), 'live station offers Stop');
  assert.ok(html.includes('>Start<'), 'idle station offers Start');
  assert.ok(html.includes('12 tracks'), 'playlist projected to a count');
  // One Edit and one Delete — the playlist row gets neither.
  assert.strictEqual((html.match(/s-delete/g) || []).length, 1);
  assert.strictEqual((html.match(/s-edit/g) || []).length, 1);
});

test('SSE stations event re-fetches the owner list while the panel is open', async () => {
  const { t, state } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvNTS] } }),
  });
  await settle();
  const es = FakeEventSource.instances[0];
  es.open();
  await t.openPanel('stations');
  const listCalls = () =>
    state.fetchCalls.filter(([u]) => String(u).includes('/stations/list')).length;
  const before = listCalls();
  es.emit('stations', '{}');
  await settle();
  assert.strictEqual(listCalls(), before + 1, 'notification triggers a token-gated re-fetch');
});

test('editor: create body matches the wire contract exactly', async () => {
  const { t } = ownerBoot();
  await settle();
  const ed = t.newEditor('lastFM');
  ed.name = ' Dub 90s ';
  ed.tags = ['dub'];
  ed.tagMatch = 'all';
  ed.yearMin = 1990;
  ed.yearMax = 1999;
  ed.regions = ['JP'];
  ed.popularity = 'deepCuts';
  ed.exploration = 0.7;
  ed.shufflePool = true;
  // deepStrictEqual pins the exact field set — a stray `id`/`config`
  // key or a renamed facet fails loudly here before it 400s in prod.
  assert.deepStrictEqual(wire(t.buildStationBody(ed)), {
    token: 'valid',
    kind: 'lastFM',
    name: 'Dub 90s',
    query: {
      genreTags: ['dub'], yearMin: 1990, yearMax: 1999, regions: ['JP'],
      tagMatch: 'all', popularity: 'deepCuts',
      excludeOwnedLibrary: false, excludedArtists: [],
    },
    exploration: 0.7,
    shufflePool: true,
  });
});

test('editor: list payload round-trips through the form into an update body', async () => {
  const { t } = ownerBoot();
  await settle();
  const ed = t.editorFrom(srvNTS);
  const body = wire(t.buildStationBody(ed, true));
  assert.deepStrictEqual(body, {
    token: 'valid',
    station: srvNTS.id,           // `station`, never `id`
    applyNow: true,
    name: 'NTS Dub',
    query: srvNTS.query,          // excludedArtists survives untouched
    shufflePool: true,            // no exploration/sort keys for an NTS station
  });
  assert.strictEqual(t.buildStationBody(ed, false).applyNow, false);
});

test('editor: validation mirrors the server 422 rules', async () => {
  const { t } = ownerBoot();
  await settle();
  const ed = t.newEditor('nts');
  assert.ok(t.validateEditor(ed), 'empty form invalid');
  ed.name = 'X';
  assert.ok(/tag/.test(t.validateEditor(ed)), 'tags required');
  ed.tags = ['dub'];
  assert.strictEqual(t.validateEditor(ed), null);
  ed.yearMin = 2000; ed.yearMax = 1990;
  assert.ok(t.validateEditor(ed), 'inverted year range invalid');
});

test('delete confirm: name mismatch blocks the POST, a match deletes', async () => {
  const deletes = [];
  const { t, state } = ownerBoot({
    '/stations/delete': (b) => { deletes.push(b); return { status: 200, body: { status: 'deleted' } }; },
  });
  await settle();
  t.ownerStations = [srvNTS];
  assert.strictEqual(t.nameMatches('other station', 'NTS Dub'), false);
  assert.strictEqual(t.nameMatches('  nts dub ', 'NTS Dub'), true, 'trim + case-insensitive');
  state.promptResponse = 'wrong name';
  await t.deleteStationFlow(srvNTS.id);
  assert.strictEqual(deletes.length, 0, 'mismatch never reaches the wire');
  assert.strictEqual(t.ownerStations.length, 1);
  state.promptResponse = ' nts dub ';
  await t.deleteStationFlow(srvNTS.id);
  assert.deepStrictEqual(deletes, [{ token: 'valid', station: srvNTS.id }]);
  assert.strictEqual(t.ownerStations.length, 0);
});

test('history: More pages accumulate, a short page ends the log', async () => {
  const entry = (i, sid, name) => ({
    playedAt: 1755856800 + i, artist: `A${i}`, title: `T${i}`, saved: false,
    sourceURL: null, youtubeURL: null, stationID: sid, station: name,
  });
  const page1 = Array.from({ length: 100 }, (_, i) =>
    entry(i, i % 2 ? 's1' : 's2', i % 2 ? 'One' : null));
  const page2 = Array.from({ length: 40 }, (_, i) => entry(100 + i, 's1', 'One'));
  const { t, els, state } = boot({
    fetchImpl: routed({
      '/history': (_, u) => ({
        status: 200,
        body: { entries: u.includes('offset=0') ? page1 : page2 },
      }),
    }),
  });
  await settle();
  await t.openPanel('history');
  assert.strictEqual(t.historyRows.length, 100);
  assert.strictEqual(t.historyDone, false);
  assert.ok(els.panel.innerHTML.includes('h-more'), 'More button offered');
  await t.loadHistory(true);
  assert.strictEqual(t.historyRows.length, 140, 'pages accumulate');
  assert.strictEqual(t.historyDone, true, 'short page = end');
  const urls = state.fetchCalls.map(([u]) => String(u)).filter((u) => u.includes('/history'));
  assert.ok(urls[1].includes('offset=100'), `second page offset (${urls[1]})`);
  assert.ok(!els.panel.innerHTML.includes('h-more'), 'More gone at the end');
});

test('history: per-station filter is client-side over accumulated rows', async () => {
  const entry = (i, sid, name) => ({
    playedAt: 1755856800 + i, artist: `A${i}`, title: `T${i}`, saved: false,
    sourceURL: null, youtubeURL: null, stationID: sid, station: name,
  });
  const rows = [entry(0, 's1', 'One'), entry(1, 's2', null), entry(2, 's1', 'One')];
  const { t, els } = boot({
    fetchImpl: routed({ '/history': () => ({ status: 200, body: { entries: rows } }) }),
  });
  await settle();
  await t.openPanel('history');
  assert.ok(els.panel.innerHTML.includes('(deleted station)'), 'null name gets a label');
  const shown = () => (els.panel.innerHTML.match(/class="htrack"/g) || []).length;
  assert.strictEqual(shown(), 3);
  t.historyFilter = 's2';
  t.renderHistoryPanel();
  assert.strictEqual(shown(), 1, 'filter narrows without re-fetching');
  t.historyFilter = null;
  t.renderHistoryPanel();
  assert.strictEqual(shown(), 3);
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
