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
    // Records custom properties so grid assertions can read back what
    // render() set (--cols/--rows/--count).
    style: {
      props: {},
      setProperty(k, v) { this.props[k] = String(v); },
      getPropertyValue(k) { return this.props[k] === undefined ? '' : this.props[k]; },
    },
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
    topbar: makeEl(), history: makeEl(), dlg: makeEl(),
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
  connectEvents, refresh, probeHealth, apiGet,
  fmtCount, regionName, shortBio, trackInfoHTML, ensureTrackInfo,
  get trackinfoCache() { return trackinfoCache; },
  displayDelayFor: displayDelayFor,
  get stations() { return stations; },
  get sseAlive() { return sseAlive; },
  set sseAlive(v) { sseAlive = v; },
  get pollFailures() { return pollFailures; },
  set activeId(id) { activeId = id; },
  // panels.js surface
  renderTopbar, policyRowHTML, renderHistorySection, healthStripHTML, fmtSpan,
  loadOwnerStations, renderEditor, loadHistory,
  buildStationBody, editorFrom, newEditor, validateEditor, nameMatches,
  deleteStationFlow, submitEditor,
  loadPolicy, setPolicy, policySectionHTML, onPanelChange,
  openNewStationFlow, openStationEditorById, closeEditor,
  get inlineEditorId() { return inlineEditorId; },
  get capabilities() { return capabilities; },
  get activePanel() { return activePanel; },
  get vocab() { return vocab; },
  set vocab(v) { vocab = v; },
  get ownerStations() { return ownerStations; },
  set ownerStations(v) { ownerStations = v; },
  get historyRows() { return historyRows; },
  get historyDone() { return historyDone; },
  set historyFilter(v) { historyFilter = v; },
  get editor() { return editor; },
  set editor(v) { editor = v; },
  get policy() { return policy; },
  get taste() { return taste; },
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

test('capabilities: old server (/health 404) shows no strip and no selection row', async () => {
  const { t, els } = boot({
    storedKey: 'valid',
    fetchImpl: routed({ '/health': () => ({ status: 404, body: {} }) }),
  });
  await settle();
  assert.deepStrictEqual(wire(t.capabilities), []);
  t.renderTopbar();
  assert.ok(!els.topbar.innerHTML.includes('class="health"'), 'no strip');
  assert.ok(!els.topbar.innerHTML.includes('pol-share'), 'no selection row');
  assert.ok(els.history.innerHTML.includes('Play history'), 'history section still stands');
});

test('capabilities: new server + owner key → no bar buttons, no row without policy', async () => {
  const { t, els } = ownerBoot();
  await settle();
  assert.deepStrictEqual(t.capabilities, ['health', 'stations', 'vocab']);
  t.renderTopbar();
  const bar = els.topbar.innerHTML;
  // Per-station management lives in the cards now; the bar keeps only
  // what could never belong to one station.
  assert.ok(!bar.includes('data-panel="stations"'), 'no stations button on the bar');
  // v1 server: no policy capability, so the owner row does not exist yet.
  assert.ok(!bar.includes('pol-share'), 'no dial without the policy capability');
});

test('capabilities: guest gets no owner surface even when the server has it', async () => {
  const { t, els } = boot({
    fetchImpl: routed({ '/health': () => ({ status: 200, body: HEALTH }) }),
  });
  await settle();
  t.renderTopbar();
  assert.strictEqual(els.topbar.innerHTML, '', 'guests get no header row at all');
});

test('roster: a 503 says "catalogue unavailable" above the grid, it does not hide it', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({
      status: 503, body: { status: 'error', message: 'catalogue unavailable' },
    }),
  });
  await settle();
  t.adoptNow(payload(trackA));
  await settle();
  const html = els.stations.innerHTML;
  assert.ok(html.includes('catalogue unavailable'), 'the reason is on screen');
  assert.ok(html.includes('One'), 'and what IS broadcasting still renders');
});

test('grid: the owner sees idle stations as cards too, playlists read-only', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvNTS, srvPlaylist] } }),
  });
  await settle();
  t.adoptNow(payload(trackA));
  await settle();
  const html = els.stations.innerHTML;
  assert.ok(html.includes('NTS Dub') && html.includes('Mixtape'), 'both stations are cards');
  assert.ok(html.includes('12 tracks'), 'playlist projected to a count, never its files');
  // The ✎ belongs to the editable station only — playlists are desktop-managed.
  // Every editable card carries a ✎ — the idle NTS station and the live
  // one — while the playlist card carries none.
  assert.strictEqual((html.match(/act--edit/g) || []).length, 2, 'edit on the editable cards only');
  assert.ok(html.includes('station--new'), 'and the ghost card closes the grid');
});

test('SSE stations event re-fetches the owner list while the panel is open', async () => {
  const { t, state } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvNTS] } }),
  });
  await settle();
  const es = FakeEventSource.instances[0];
  es.open();
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
  assert.strictEqual(t.historyRows.length, 100);
  assert.strictEqual(t.historyDone, false);
  assert.ok(els.history.innerHTML.includes('h-more'), 'More button offered');
  await t.loadHistory(true);
  assert.strictEqual(t.historyRows.length, 140, 'pages accumulate');
  assert.strictEqual(t.historyDone, true, 'short page = end');
  const urls = state.fetchCalls.map(([u]) => String(u)).filter((u) => u.includes('/history'));
  assert.ok(urls[1].includes('offset=100'), `second page offset (${urls[1]})`);
  assert.ok(!els.history.innerHTML.includes('h-more'), 'More gone at the end');
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
  assert.ok(els.history.innerHTML.includes('(deleted station)'), 'null name gets a label');
  const shown = () => (els.history.innerHTML.match(/class="htrack"/g) || []).length;
  assert.strictEqual(shown(), 3);
  t.historyFilter = 's2';
  t.renderHistorySection();
  assert.strictEqual(shown(), 1, 'filter narrows without re-fetching');
  t.historyFilter = null;
  t.renderHistorySection();
  assert.strictEqual(shown(), 3);
});

// --- Policy + transparency panels (W4/W5) -----------------------------

// /health as the v2 contract ships it — all six capability strings.
const FULL_HEALTH = {
  ...HEALTH,
  capabilities: ['health', 'stations', 'vocab', 'policy', 'taste', 'exclusions'],
};

const POLICY = { newMusicShare: 0.3, excludeMixSets: false, mixSetMinimumDuration: 1500 };

// Policy routes: /policy/get serves the fixture, /policy/set records
// each body into `sets` and echoes the merged state back the way the
// server does (or refuses with opts.setStatus).
const policyRoutes = (sets, opts = {}) => ({
  '/health': () => ({ status: 200, body: FULL_HEALTH }),
  '/policy/get': () => ({ status: 200, body: POLICY }),
  '/policy/set': (b) => {
    sets.push(b);
    if (opts.setStatus) {
      return { status: opts.setStatus, body: { status: 'error', message: 'nope' } };
    }
    return {
      status: 200,
      body: {
        newMusicShare: 'newMusicShare' in b ? b.newMusicShare : POLICY.newMusicShare,
        excludeMixSets: 'excludeMixSets' in b ? b.excludeMixSets : POLICY.excludeMixSets,
        mixSetMinimumDuration: POLICY.mixSetMinimumDuration,
      },
    };
  },
});

// A change event the way onPanelChange sees one — just enough target to
// hit exactly one classList branch.
const changeEvt = (cls, props) => ({
  target: { classList: { contains: (c) => c === cls }, closest: () => null, ...props },
});

test('capabilities: the Selection row gates on policy; taste and why are gone', async () => {
  // Full server + owner key: the header row carries the dial. Taste and
  // why no longer exist as surfaces at all.
  const full = boot({ storedKey: 'valid', fetchImpl: routed(policyRoutes([])) });
  await settle();
  full.t.renderTopbar();
  const bar = full.els.topbar.innerHTML;
  assert.ok(bar.includes('pol-share'), 'the dial is on the header row');
  assert.ok(bar.includes('class="health"'), 'so is the status dot');
  assert.ok(!/taste|why/i.test(bar), 'no taste, no why');

  // Same server, no key: the strip stays public, the controls do not.
  const guest = boot({ fetchImpl: routed({ '/health': () => ({ status: 200, body: FULL_HEALTH }) }) });
  await settle();
  guest.t.renderTopbar();
  assert.strictEqual(guest.els.topbar.innerHTML, '', 'no row for guests — the cards say who is on air');

  // Owner against a server without the policy capability: strip only.
  const v1 = ownerBoot();
  await settle();
  v1.t.renderTopbar();
  assert.strictEqual(v1.els.topbar.innerHTML, '', 'no row without the policy capability');
});

test('policy: /policy/get lands with the header row — dial, read-only duration, honest copy', async () => {
  const { t, els, state } = boot({ storedKey: 'valid', fetchImpl: routed(policyRoutes([])) });
  await settle();
  const gets = state.fetchCalls.filter(([u]) => String(u).includes('/policy/get'));
  assert.strictEqual(gets.length, 1, 'one get per open');
  assert.deepStrictEqual(JSON.parse(gets[0][1].body), { token: 'valid' });
  const html = els.topbar.innerHTML;
  assert.ok(html.includes('pol-share'), 'dial rendered');
  assert.ok(html.includes('value="30"'), 'share adopted from the server');
  assert.ok(html.includes('30%'), 'labeled');
  assert.ok(html.includes('not in your library'), '"new" defined honestly');
  assert.ok(html.includes('longer than 25m'), 'mixSetMinimumDuration explained in the tooltip');
});

test('policy: each control sends only its own key — absent means untouched, null means off', async () => {
  const sets = [];
  const { t, els } = boot({ storedKey: 'valid', fetchImpl: routed(policyRoutes(sets)) });
  await settle();

  // Mix-set toggle: excludeMixSets alone — an untouched dial must not
  // ride along (absent = leave alone on the server's double optional).
  t.onPanelChange(changeEvt('pol-mixsets', { checked: true }));
  await settle();
  assert.deepStrictEqual(wire(sets[0]), { token: 'valid', excludeMixSets: true });
  assert.ok(!('newMusicShare' in sets[0]), 'untouched dial absent from the body');

  // Dial off: newMusicShare present as an EXPLICIT null — the -1
  // sentinel never leaves the server.
  t.onPanelChange(changeEvt('pol-share-on', { checked: false }));
  await settle();
  assert.ok('newMusicShare' in sets[1], 'key present');
  assert.strictEqual(sets[1].newMusicShare, null, 'explicit null = off');
  assert.ok(!('excludeMixSets' in sets[1]), 'toggle not dragged along');
  assert.ok(els.topbar.innerHTML.includes('>off<'), 'off state labeled');

  // Dial back on: restores the remembered share, not zero.
  t.onPanelChange(changeEvt('pol-share-on', { checked: true }));
  await settle();
  assert.strictEqual(sets[2].newMusicShare, 0.3);

  // Slider commit sends the new share and nothing else.
  t.onPanelChange(changeEvt('pol-share', { value: '55' }));
  await settle();
  assert.deepStrictEqual(wire(sets[3]), { token: 'valid', newMusicShare: 0.55 });
});

test('policy: a refused set (503) reverts the optimistic patch', async () => {
  const sets = [];
  const { t, els } = boot({
    storedKey: 'valid',
    fetchImpl: routed(policyRoutes(sets, { setStatus: 503 })),
  });
  await settle();
  t.onPanelChange(changeEvt('pol-mixsets', { checked: true }));
  assert.strictEqual(t.policy.excludeMixSets, true, 'optimistic flip');
  await settle();
  assert.strictEqual(t.policy.excludeMixSets, false, 'reverted on refusal');
  assert.ok(els.topbar.innerHTML.includes('Broadcaster hiccup'), 'note shown');
});

const TASTE = {
  libraryArtists: [{ artist: 'Prince Far I', score: 0.92 }, { artist: 'Scientist', score: 0.4 }],
  libraryTags: [{ tag: 'dub', score: 0.61 }],
  stations: [{
    id: 'S1', name: 'One', topAffinityArtists: ['Scientist', 'King Tubby'],
    counts: { plays: 214, saves: 38, boosts: 7, skips: 91 },
  }],
};

test('403 on an owner surface drops the key and takes the owner row with it', async () => {
  const { t, els, state } = boot({
    storedKey: 'valid',
    fetchImpl: routed({
      '/health': () => ({ status: 200, body: FULL_HEALTH }),
      '/policy/get': () => ({ status: 403, body: {} }),
    }),
  });
  await settle();
  await t.loadPolicy();
  assert.strictEqual(state.store.has('ratbat_key'), false, 'key dropped centrally');
  t.renderTopbar();
  assert.strictEqual(els.topbar.innerHTML, '', 'the row goes with the key');
});

test('fmtCount compacts to K/M/B and passes small numbers through', ({ t }) => {
  assert.strictEqual(t.fmtCount(0), '0');
  assert.strictEqual(t.fmtCount(999), '999');
  assert.strictEqual(t.fmtCount(1200), '1.2K');
  assert.strictEqual(t.fmtCount(45300), '45.3K');
  assert.strictEqual(t.fmtCount(1234567), '1.2M');
  assert.strictEqual(t.fmtCount(2000000000), '2B');
  assert.strictEqual(t.fmtCount(null), '');
});

test('track info: written onto the card for the current track, no toggle anywhere', async () => {
  const { t, els } = boot();
  t.capabilities.length = 0;
  t.capabilities.push('trackinfo');
  await settle();
  t.trackinfoCache.set('Artist A|Alpha', {
    artist: 'Artist A', title: 'Alpha',
    artistInfo: { bio: 'A dub engineer from Kingston who built his own desk.',
      country: 'JM', listeners: 1200000, playcount: null,
      tags: ['dub', 'roots reggae'], similar: ['King Tubby', 'Scientist'] },
    trackInfo: { album: 'LP One', firstReleaseYear: 1976, listeners: null, playcount: null, tags: [], wiki: null },
  });
  t.adoptNow(payload(trackA));
  const html = els.stations.innerHTML;
  assert.ok(html.includes('first release 1976'), 'year on the card');
  assert.ok(html.includes('1.2M listeners'), 'listeners compacted');
  assert.ok(html.includes('dub · roots reggae'), 'tags on the card');
  assert.ok(html.includes('built his own desk'), 'bio on the card');
  assert.ok(html.includes('Similar: King Tubby, Scientist'), 'similar on the card');
  assert.ok(!html.includes('about-link') && !/>about</.test(html), 'no about affordance');
});

test('track info: nothing extra without the capability, and the card still renders', async () => {
  const { t, els } = boot();
  t.capabilities.length = 0;
  await settle();
  t.adoptNow(payload(trackA));
  const html = els.stations.innerHTML;
  assert.ok(!html.includes('class="trackinfo"'), 'no info block without the capability');
  assert.ok(html.includes('Alpha'), 'card still renders');
});

test('track info: the answer is cached under the track that came back, not the one asked for', async () => {
  let calls = 0;
  const { t } = boot({
    fetchImpl: async (url) => {
      if (String(url).includes('/trackinfo')) {
        calls++;
        // The server answers for what is CURRENT — a different track
        // than the display-lagged card is showing.
        return { ok: true, status: 200, json: async () => ({
          artist: 'Artist B', title: 'Beta', artistInfo: { listeners: 5 }, trackInfo: {},
        }) };
      }
      return { ok: true, status: 200, json: async () => ({ stations: [] }) };
    },
  });
  await settle();
  t.capabilities.length = 0;
  t.capabilities.push('trackinfo');
  t.adoptNow(payload(trackA));
  await settle(); await settle(); await settle();
  assert.equal(calls, 1, 'asked once');
  assert.ok(t.trackinfoCache.has('Artist B|Beta'), 'cached under the answer');
  assert.ok(!t.trackinfoCache.has('Artist A|Alpha'), 'never mis-keyed onto what we asked for');
  t.render();
  await settle(); await settle();
  assert.equal(calls, 1, 'and does not re-ask on the next paint');
});

test('new-station card: an empty slot at the end of the grid, owner only', async () => {
  const { t, els } = ownerBoot();
  await settle();
  t.adoptNow(payload(trackA));
  const html = els.stations.innerHTML;
  assert.ok(html.includes('station--new'), 'owner gets the empty card');
  assert.ok(html.includes('aria-label="Add a new station"'), 'and it is labeled');
  // One real station + the ghost = two cards in the grid.
  assert.equal(els.stations.style.getPropertyValue('--count'), '2', 'grid counts the ghost');
});

test('new-station card: guests never see it, and it never starts audio', async () => {
  const { t, els } = boot();
  await settle();
  t.adoptNow(payload(trackA));
  assert.ok(!els.stations.innerHTML.includes('station--new'), 'guest sees no empty card');
  assert.equal(els.stations.style.getPropertyValue('--count'), '1', 'grid counts stations only');
});

test('inline editor: the ✎ opens the form inside its own card, not a panel', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvNTS] } }),
    '/vocab': () => ({ status: 200, body: V3_VOCAB }),
  });
  await settle();
  t.adoptNow({ stations: [] });
  await settle();
  await t.openStationEditorById(srvNTS.id);
  await settle();
  assert.equal(t.inlineEditorId, srvNTS.id, 'the card owns the open editor');
  assert.ok(els.stations.innerHTML.includes('class="editor"'), 'the form is in the grid');
  assert.ok(!els.topbar.innerHTML.includes('class="editor"'), 'and nothing opened outside the card');
  t.closeEditor();
  assert.equal(t.inlineEditorId, null, 'closing hands the grid back');
  assert.ok(!els.stations.innerHTML.includes('class="editor"'), 'form gone');
});

test('inline editor: an arriving frame must not repaint the form out from under you', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvNTS] } }),
    '/vocab': () => ({ status: 200, body: V3_VOCAB }),
  });
  await settle();
  t.adoptNow({ stations: [] });
  await settle();
  await t.openStationEditorById(srvNTS.id);
  await settle();
  // Stand in for a caret: something only present in the live DOM, which
  // a wholesale rebuild of #stations would throw away.
  els.stations.innerHTML += '<!--caret-->';
  t.adoptNow(payload(trackA));   // the poll/SSE frame that used to eat it
  assert.ok(els.stations.innerHTML.includes('<!--caret-->'), 'grid stayed frozen');
  t.closeEditor();
  assert.ok(!els.stations.innerHTML.includes('<!--caret-->'), 'and repaints once closed');
});

test('shortBio cuts long text at a sentence, short text untouched', ({ t }) => {
  assert.equal(t.shortBio('One sentence.'), 'One sentence.');
  const long = `${'A'.repeat(150)}. ${'B'.repeat(200)}.`;
  const cut = t.shortBio(long);
  assert.ok(cut.length <= 201, 'capped');
  assert.ok(cut.endsWith('.'), 'cut at a sentence end');
});

// Vocab from a server that knows Library Radio, and the deploy before it.
const V3_VOCAB = {
  tags: { nts: ['dub'], lastFM: ['dub'], bandcamp: ['dub'], libraryRadio: [] },
  tagMatch: ['any', 'all'],
  popularity: ['hits', 'middle', 'deepCuts'],
  bandcampSort: ['date', 'pop'],
  kinds: ['nts', 'lastFM', 'bandcamp', 'libraryRadio'],
  regions: ['JP'],
};
// Same server one deploy earlier: no libraryRadio anywhere.
const V2_VOCAB = {
  ...V3_VOCAB,
  tags: { nts: ['dub'], lastFM: ['dub'], bandcamp: ['dub'] },
  kinds: ['nts', 'lastFM', 'bandcamp'],
};

// A /stations/list libraryRadio station — flat contract, query present,
// exploration/sort null (wrongKind), excludeOwnedLibrary normalized off.
const srvLibrary = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Home Radio', slug: 'home-radio', kind: 'libraryRadio',
  broadcasting: false, autoStart: false,
  query: {
    genreTags: [], yearMin: null, yearMax: null,
    regions: [], tagMatch: 'any', popularity: 'middle',
    excludeOwnedLibrary: false, excludedArtists: [],
  },
  exploration: null, sort: null, shufflePool: true, trackCount: null,
};

test('libraryRadio: kind picker offered only when vocab.kinds includes it', async () => {
  const { t, els } = ownerBoot();
  await settle();
  t.adoptNow(payload(trackA));
  // v2 server: the kind never appears — its create would 422.
  await t.openNewStationFlow();
  t.vocab = V2_VOCAB;
  t.editor = t.newEditor('nts');
  t.renderEditor();
  assert.ok(!els.stations.innerHTML.includes('libraryRadio'), 'v2 vocab: not offered');
  // v3 server: offered, labeled "Library radio".
  t.vocab = V3_VOCAB;
  t.renderEditor();
  const html = els.stations.innerHTML;
  assert.ok(html.includes('value="libraryRadio"'), 'v3 vocab: option present');
  assert.ok(html.includes('>Library radio<'), 'labeled');
});

test('libraryRadio: editor shows query + shuffle only — no exploration, no sort, no exclude-owned', async () => {
  const { t, els } = ownerBoot();
  await settle();
  t.adoptNow(payload(trackA));
  await t.openNewStationFlow();
  t.vocab = V3_VOCAB;
  t.editor = t.newEditor('libraryRadio');
  t.renderEditor();
  const html = els.stations.innerHTML;
  assert.ok(!html.includes('f-exploration'), 'no exploration slider');
  assert.ok(!html.includes('f-sort'), 'no sort select');
  assert.ok(!html.includes('f-excludeowned'), 'no exclude-owned checkbox');
  assert.ok(html.includes('plays only tracks you own'), 'copy note explains why');
  assert.ok(html.includes('f-shuffle'), 'shuffle stays');
  assert.ok(html.includes('f-newtag'), 'query facets stay editable');
});

test('libraryRadio: create body is contract-exact — no exploration/sort keys, exclude-owned normalized', async () => {
  const { t } = ownerBoot();
  await settle();
  const ed = t.newEditor('libraryRadio');
  ed.name = ' Home Radio ';
  // Stale checkbox state from a kind switch in the picker — must never
  // reach the wire as true: library radio plays only owned tracks.
  ed.excludeOwnedLibrary = true;
  assert.strictEqual(t.validateEditor(ed), null, 'empty tags = whole library, valid');
  assert.deepStrictEqual(wire(t.buildStationBody(ed)), {
    token: 'valid',
    kind: 'libraryRadio',
    name: 'Home Radio',
    query: {
      genreTags: [], yearMin: null, yearMax: null, regions: [],
      tagMatch: 'any', popularity: 'middle',
      excludeOwnedLibrary: false, excludedArtists: [],
    },
    shufflePool: false,
  });
});

test('libraryRadio: list payload round-trips into an update body of name/query/shufflePool', async () => {
  const { t } = ownerBoot();
  await settle();
  const ed = t.editorFrom(srvLibrary);
  assert.deepStrictEqual(wire(t.buildStationBody(ed, false)), {
    token: 'valid',
    station: srvLibrary.id,
    applyNow: false,
    name: 'Home Radio',
    query: srvLibrary.query,
    shufflePool: true,          // and nothing else — exploration/sort stay wrongKind
  });
});

test('libraryRadio: card badge and now-playing origin badge', async () => {
  const { t, els } = ownerBoot({
    '/stations/list': () => ({ status: 200, body: { stations: [srvLibrary] } }),
  });
  await settle();
  t.adoptNow({ stations: [] });
  await settle();
  const html = els.stations.innerHTML;
  assert.ok(html.includes('Library radio'), 'kind badge labeled on the card');
  assert.ok(html.includes('act--edit'), 'libraryRadio is editable, unlike playlist');
  // Origin "library" on the active card maps through ORIGIN_LABELS.
  t.activeId = 'S1';
  t.adoptNow(payload({ ...trackA, origin: 'library' }));
  assert.ok(els.stations.innerHTML.includes('>Library<'), 'origin badge mapped');
});

// --- Legibility pass --------------------------------------------------

test('now block: album line reads "from <album>" with a muted prefix', async () => {
  const { t, els } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload(trackA));
  assert.ok(els.stations.innerHTML.includes(
    '<span class="album"><span class="from">from</span> LP One</span>'),
    'album line carries the from prefix');
});

test('now block: album line suppressed when it repeats the title (trim + case-insensitive)', async () => {
  const { t, els } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload({ ...trackA, album: '  ALPHA ' })); // self-titled, sloppy casing
  const html = els.stations.innerHTML;
  assert.ok(html.includes('Alpha'), 'title still shown');
  assert.ok(!html.includes('class="album"'), 'no album line for a self-titled release');
});

test('now block: album line suppressed when the album is empty', async () => {
  const { t, els } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload({ ...trackA, album: '' }));
  assert.ok(!els.stations.innerHTML.includes('class="album"'));
});

test('origin badge renders on non-active cards; links stay active-only', async () => {
  const { t, els } = ownerBoot();
  await settle();
  // Nobody tuned in — the card still says where the track came from.
  t.adoptNow(payload({ ...trackA, sourceURL: 'https://x.example/rel' }));
  let html = els.stations.innerHTML;
  assert.ok(html.includes('class="origin"') && html.includes('>Last.fm<'),
    'origin badge on a non-active card');
  assert.ok(!html.includes('x.example'), 'source link held back until active');
  assert.ok(!html.includes('x.example'), 'source links held back until active');
  t.activeId = 'S1';
  t.render();
  html = els.stations.innerHTML;
  assert.ok(html.includes('x.example'), 'active card gets the links');
  assert.ok(!html.includes('>about<'), 'and no about affordance anywhere');
});

test('settings affordance: guest never gets it even when the server advertises stations', async () => {
  // Regression: the way into a station's settings must share the owner
  // gate — key AND capability — not render for logged-out guests.
  const guest = boot({
    fetchImpl: routed({ '/health': () => ({ status: 200, body: HEALTH }) }),
  });
  await settle();
  assert.ok(guest.t.capabilities.includes('stations'), 'server does advertise stations');
  guest.t.adoptNow(payload(trackA));
  assert.ok(!guest.els.stations.innerHTML.includes('act--edit'), 'no settings button for guests');
  assert.ok(!guest.els.stations.innerHTML.includes('class="setsum"'), 'and no settings summary');

  const owner = ownerBoot();
  await settle();
  owner.t.adoptNow(payload(trackA));
  const html = owner.els.stations.innerHTML;
  assert.ok(html.includes('act--edit'), 'owner gets the settings button');
  assert.ok(html.includes('>Settings</button>'), 'named, not a bare glyph');
  assert.ok(html.includes('title="Station settings"'), 'and titled');
});

// The strip is a dot now; what it SAYS lives in its tooltip, so these
// assertions read the title rather than the glyph. Owner + policy,
// because the row only exists for the owner.
async function healthTooltip(overrides) {
  const { t, els } = boot({
    storedKey: 'valid',
    fetchImpl: routed({
      '/health': () => ({ status: 200, body: { ...HEALTH, capabilities: ['health', 'policy'], ...overrides } }),
      '/policy/get': () => ({ status: 200, body: { newMusicShare: null, excludeMixSets: false, mixSetMinimumDuration: 1500 } }),
    }),
  });
  await settle();
  t.renderTopbar();
  const m = els.topbar.innerHTML.match(/class="health[^"]*" title="([^"]*)"/);
  return m ? m[1] : '';
}

test('health dot: the detail lives in its tooltip, singular and plural', async () => {
  const one = await healthTooltip({ broadcastingCount: 1 });
  assert.ok(one.includes('● on air · up 3d 4h · 1 station live'), `singular (${one})`);
  assert.ok((await healthTooltip({ broadcastingCount: 2 })).includes('2 stations live'), 'plural');
  const off = await healthTooltip({ broadcastingCount: 0 });
  assert.ok(off.includes('○ off air'), 'off air');
  assert.ok(!off.includes('station live'), 'and no count when nothing is on');
});

test('header row: the strip is labeled and the controls carry accessible names', async () => {
  const full = boot({ storedKey: 'valid', fetchImpl: routed(policyRoutes([])) });
  await settle();
  full.t.renderTopbar();
  const bar = full.els.topbar.innerHTML;
  assert.ok(/class="health[^"]*" title="[^"]*on air/.test(bar), 'the dot carries the detail');
  assert.ok(bar.includes('aria-label="Share of new music"'), 'the dial has a name');
  assert.ok(bar.includes('New music') && bar.includes('Skip mix sets'), 'both controls read as words');
});

test('no tap-to-listen hint anywhere (removed by request)', async () => {
  const { t, els } = boot();
  await settle();
  t.adoptNow(payload(trackA));
  assert.ok(!els.stations.innerHTML.includes('tap to listen'), 'non-active card carries no hint');
  t.activeId = 'S1';
  t.render();
  assert.ok(!els.stations.innerHTML.includes('tap to listen'), 'active card carries no hint');
});

test('station accent: hue is deterministic per station id, present on every card', async () => {
  const { t, els } = boot();
  await settle();
  t.adoptNow(payload(trackA));
  const first = els.stations.innerHTML.match(/--accent-h:(\d+)/);
  assert.ok(first, 'card carries an accent hue');
  t.render();
  const second = els.stations.innerHTML.match(/--accent-h:(\d+)/);
  assert.equal(first[1], second[1], 'same station, same hue across renders');
  assert.ok(Number(first[1]) >= 0 && Number(first[1]) < 360, 'hue in range');
});

test('a11y: share carries title+aria, transport glyph is Play/Pause per state', async () => {
  const { t, els } = boot();
  await settle();
  t.activeId = 'S1';
  t.adoptNow(payload(trackA));
  let html = els.stations.innerHTML;
  assert.ok(html.includes('title="Share this track" aria-label="Share this track"'), 'share labeled');
  assert.ok(html.includes('class="transport" title="Play"'), 'paused card says Play');
  els.audio.paused = false;
  els.audio.readyState = 4;
  t.render();
  html = els.stations.innerHTML;
  assert.ok(html.includes('class="transport" title="Pause"'), 'playing card says Pause');
  assert.ok(html.includes('aria-label="Pause"'));
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
