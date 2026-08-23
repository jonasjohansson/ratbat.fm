// Ratbat — each station card is its own mini media player.
// Click a card to play, click again to pause. Only one plays at a time.
// The grid adapts to fill the viewport based on how many stations are live.

const resolveAPIBase = () => {
  const params = new URLSearchParams(window.location.search);
  if (params.has('api')) return params.get('api').replace(/\/+$/, '');
  if (typeof window.RATBAT_API === 'string' && window.RATBAT_API) {
    return window.RATBAT_API.replace(/\/+$/, '');
  }
  const host = window.location.hostname;
  if (host.startsWith('ratbat.')) {
    return `${window.location.protocol}//radio.${host.slice('ratbat.'.length)}`;
  }
  return window.location.origin;
};

const API_BASE = resolveAPIBase();
let stations = [];
let activeId = null;

// --- Owner roster -----------------------------------------------------
//
// /now.json says what is PLAYING; POST /stations/list says what EXISTS.
// The owner's grid is the roster — idle stations are cards too, because
// everything about a station belongs on the station. Guests never fetch
// this and never see anything but what is on air.
//
// It lives in app.js and not with the editor because the grid IS the
// station list now; panels.js reads and mutates it the same way it reads
// everything else in this file.
let ownerStations = [];
let ownerStationsError = null;
// Stations with a start/stop/delete in flight — blocks double-fire, the
// same idiom as actionBusy further down. The inline editor shares it.
const stationBusy = new Set();

// Which card, if any, has the inline editor open: a station id, or
// NEW_CARD_ID for the ghost card's create form. panels.js sets it when
// it opens and clears it when it closes; render() reads it to know it
// must keep its hands off the grid (see the note there).
let inlineEditorId = null;
// The ghost card has no station id — this stands in for one. The NUL
// prefix guarantees it can never collide with a real one.
const NEW_CARD_ID = '\u0000new';

// Owner passcode — actions (♥/⤴/⏭) are owner-only server-side; guests get
// a radio, not a mixer. Enter it once via the lock button (top right)
// and localStorage holds it with no expiry: no re-prompt on reload, on a
// new tab, or after the browser restarts. It survives until the passcode
// changes on the broadcaster or the browser's site data is cleared.
//
// The unlock flow itself lives at the bottom of this file — it needs
// `timeoutSignal`, which is a `const` declared further down.
//
// A 403 despite a stored passcode means it was changed on the broadcaster
// — drop it and hide the buttons again.
const KEY_STORE = 'ratbat_key';
const ownerKey = () => {
  try { return localStorage.getItem(KEY_STORE) || null; } catch { return null; }
};
const storeOwnerKey = (key) => {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch {}
};

// The now-playing DISPLAY lags the server on purpose: the server flips
// the moment the encoder starts the next track, but listeners are ~ring
// buffer + browser buffer behind (10s+). Hold the old title until the
// audio has plausibly caught up. While display and server disagree, the
// action buttons pause — a ♥ would target the server's track, not the
// one being heard.
// 10s is the buffer-lag ceiling, but a track shorter than ~30s must not
// be held longer than a third of its runtime or the display never
// catches up (station IDs, interstitials).
const DISPLAY_DELAY_MS = 10_000;
const displayDelayFor = (t) =>
  t && t.durationSeconds
    ? Math.max(2_000, Math.min(DISPLAY_DELAY_MS, t.durationSeconds * 1000 / 3))
    : DISPLAY_DELAY_MS;
const displayState = new Map(); // id -> {shownKey, shownTrack, shownAt, pendingKey, pendingTrack, pendingAt}

function displayTrack(s) {
  const st = displayState.get(s.id) || {};
  const incoming = trackKey(s);
  if (!st.shownKey || activeId !== s.id) {
    // Nothing shown yet (or nobody's listening to this card) — no lag to
    // honor, adopt immediately. `shownAt` is stamped only on a real track
    // change so the elapsed clock keeps counting across renders.
    if (st.shownKey !== incoming) {
      displayState.set(s.id, { shownKey: incoming, shownTrack: s.currentTrack, shownAt: performance.now() });
    }
    return { track: s.currentTrack, settled: true };
  }
  if (incoming === st.shownKey) {
    st.pendingKey = null;
    return { track: st.shownTrack, settled: true };
  }
  if (st.pendingKey !== incoming) {
    st.pendingKey = incoming;
    st.pendingTrack = s.currentTrack;
    st.pendingAt = performance.now();
    // Under SSE there may be no poll-driven render before the lag window
    // closes — schedule the settling render explicitly. (Also settles the
    // display exactly instead of at the next poll.)
    setTimeout(render, displayDelayFor(s.currentTrack) + 100);
  }
  if (performance.now() - st.pendingAt >= displayDelayFor(st.pendingTrack)) {
    displayState.set(s.id, { shownKey: incoming, shownTrack: s.currentTrack, shownAt: performance.now() });
    return { track: s.currentTrack, settled: true };
  }
  return { track: st.shownTrack, settled: false };
}

// mm:ss for elapsed/duration — progress is textual on purpose, no bars.
function fmtClock(secs) {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Timestamps for history rows and the on-card timeline: time-of-day for
// today, date + time for anything older.
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Elapsed is a client-side estimate counted from the moment this card's
// display adopted the track — which itself lags the server by the buffer
// delay, so the clock roughly tracks what's being heard. Null duration
// (unknown length) shows elapsed alone.
function progressText(id) {
  const st = displayState.get(id);
  if (!st || st.shownAt == null || !st.shownTrack) return '';
  const d = st.shownTrack.durationSeconds;
  const elapsed = (performance.now() - st.shownAt) / 1000;
  return d ? `${fmtClock(Math.min(elapsed, d))} / ${fmtClock(d)}` : fmtClock(elapsed);
}

// The 1s tick patches only the progress spans' text — never structure —
// so it coexists with the destructive re-render instead of fighting it
// (render always re-emits the same freshly computed string).
setInterval(() => {
  document.querySelectorAll('.progress').forEach((el) => {
    el.textContent = progressText(el.dataset.station);
  });
}, 1000);

// ♥ state is keyed on station + track so the filled heart resets itself
// when the station moves on. Session-scoped on purpose: the server is the
// durable record (the file lands in the library), this is just button UI.
const likedKeys = new Set();
// Stations with a like/skip request in flight — blocks double-fire.
const actionBusy = new Set();

const trackKey = (s) =>
  s.currentTrack ? `${s.id}|${s.currentTrack.artist}|${s.currentTrack.title}` : null;

const $stations = document.getElementById('stations');
const $audio = document.getElementById('audio');
const $lock = document.getElementById('lock');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Region names are localized in the browser — the wire carries bare ISO
// codes and Intl.DisplayNames turns "JP" into "Japan" in the viewer's
// own language. Falls back to the raw code where the API is missing.
// Lives here, not in panels.js, because the cards render places too.
const regionName = (() => {
  try {
    const dn = new Intl.DisplayNames(undefined, { type: 'region' });
    return (code) => { try { return dn.of(code) || code; } catch { return code; } };
  } catch { return (code) => code; }
})();

// "1.2M", "45.3K" — listener and play counts compacted to a glance.
function fmtCount(n) {
  if (n == null || isNaN(n)) return '';
  const one = (x) => {
    const v = x.toFixed(1);
    return v.endsWith('.0') ? v.slice(0, -2) : v;
  };
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${one(n / 1e9)}B`;
  if (abs >= 1e6) return `${one(n / 1e6)}M`;
  if (abs >= 1e3) return `${one(n / 1e3)}K`;
  return String(n);
}

// --- Track enrichment, written straight onto the card -----------------
// GET /trackinfo is public and answers only for a station's CURRENT
// track. Enrichment moves at the speed of discographies, not seconds,
// so results are cached by artist|title for the life of the page.
const trackinfoCache = new Map();
// What we have already asked for, and when. Two reasons to remember:
// render() runs every couple of seconds (no stampede), and the server
// answers for what is current while the card may still be showing the
// previous track through the display lag — that answer gets cached
// under ITS own key, leaving ours unfilled, so the ask must expire
// rather than repeat forever.
const trackinfoAsked = new Map();
const TRACKINFO_RETRY_MS = 30000;

const trackInfoKey = (t) => (t && t.artist && t.title ? `${t.artist}|${t.title}` : '');

function ensureTrackInfo(stationId, t) {
  const key = trackInfoKey(t);
  if (!key || !capabilities.includes('trackinfo')) return;
  if (trackinfoCache.has(key)) return;
  const asked = trackinfoAsked.get(key);
  if (asked && Date.now() - asked < TRACKINFO_RETRY_MS) return;
  trackinfoAsked.set(key, Date.now());
  apiGet(`/trackinfo?station=${encodeURIComponent(stationId)}`)
    .then(({ ok, data }) => {
      if (!ok || !data) return;
      // Key on what came back, never on what we asked for.
      const k = trackInfoKey(data);
      if (!k) return;
      trackinfoCache.set(k, data);
      render();
    })
    .catch(() => {});
}

// The bio the server sends is capped at ~1200 chars for a panel; a card
// wants a paragraph you can take in at a glance. Cut at the last
// sentence end that fits, else the last word.
function shortBio(text, cap = 200) {
  const s = String(text || '').trim();
  if (s.length <= cap) return s;
  const head = s.slice(0, cap);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (stop > cap * 0.5) return head.slice(0, stop + 1);
  const space = head.lastIndexOf(' ');
  return `${head.slice(0, space > 0 ? space : cap)}…`;
}

// Everything the broadcaster knows about the track on air, as quiet
// lines under the title. Explicit-null tolerant: each row assembles
// from the fields that are actually there and is dropped entirely when
// none are, so a keyless broadcaster simply shows nothing extra.
function trackInfoHTML(t) {
  const d = trackinfoCache.get(trackInfoKey(t));
  if (!d) return '';
  const a = d.artistInfo || {};
  const tr = d.trackInfo || {};
  const facts = [];
  if (a.country) facts.push(regionName(a.country));
  if (tr.firstReleaseYear != null) facts.push(`first release ${tr.firstReleaseYear}`);
  if (a.listeners != null) facts.push(`${fmtCount(a.listeners)} listeners`);
  else if (a.playcount != null) facts.push(`${fmtCount(a.playcount)} plays`);
  const tags = (a.tags || []).filter(Boolean).slice(0, 3).join(' · ');
  const similar = (a.similar || []).filter(Boolean).slice(0, 3).join(', ');
  const bio = shortBio(a.bio || tr.wiki);
  // Column one is the artist in prose — where they are from, then who
  // they are. Column two is the artist as data. Left-aligned, both:
  // a centred paragraph makes the eye hunt for every line's start.
  const who = [
    facts.length ? `<p class="tifacts">${escapeHtml(facts.join(' · '))}</p>` : '',
    bio ? `<p class="tibio">${escapeHtml(bio)}</p>` : '',
  ].filter(Boolean).join('');
  const what = [
    tags ? `<p class="titags">${escapeHtml(tags)}</p>` : '',
    similar ? `<p class="tisim">Similar: ${escapeHtml(similar)}</p>` : '',
  ].filter(Boolean).join('');
  if (!who && !what) return '';
  return `<div class="trackinfo">
    ${who ? `<div class="ticol ticol--who">${who}</div>` : ''}
    ${what ? `<div class="ticol ticol--what">${what}</div>` : ''}
  </div>`;
}

// A station's color is a fact about the station, not a dice roll:
// hash its id to a hue so "Techno" is the same color on every device,
// every visit. Saturation/lightness live in CSS, per theme.
function stationHue(id) {
  let h = 5381;
  const str = String(id || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Icons are drawn, not filled: a hairline stroke reads as a mark rather
// than a blob, and they take the card's own line colour (see --card-line)
// so the chrome is one family with the border around it. The filled
// heart is the exception — a filled heart IS the saved state.
const ICON_STROKE = 'fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"';
const ICON_PLAY =
  `<svg class="icon icon--play" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M8.5 5.8v12.4L19 12z"/></svg>`;
const ICON_PAUSE =
  `<svg class="icon icon--pause" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M9.25 5.5v13M14.75 5.5v13"/></svg>`;
const ICON_LOADING =
  `<svg class="icon icon--loading" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" ${ICON_STROKE} stroke-dasharray="42" stroke-dashoffset="28"/></svg>`;
const ICON_HEART =
  `<svg class="icon icon--heart" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M12 20.5C7 16.5 3.5 13.2 3.5 9.4 3.5 6.9 5.4 5 7.9 5c1.6 0 3.1.8 4.1 2.2C13 5.8 14.5 5 16.1 5c2.5 0 4.4 1.9 4.4 4.4 0 3.8-3.5 7.1-8.5 11.1z"/></svg>`;
const ICON_HEART_FILLED =
  '<svg class="icon icon--heart-filled" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.5C7 16.5 3.5 13.2 3.5 9.4 3.5 6.9 5.4 5 7.9 5c1.6 0 3.1.8 4.1 2.2C13 5.8 14.5 5 16.1 5c2.5 0 4.4 1.9 4.4 4.4 0 3.8-3.5 7.1-8.5 11.1z"/></svg>';
const ICON_THUMBSDOWN =
  `<svg class="icon icon--skip" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M16 3H7.5L5 11v2h6l-1 5.5 1.5 1.5 4.5-7V3zm0 0h3v10h-3"/></svg>`;
const ICON_NEXT =
  `<svg class="icon icon--next" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M7 5.8v12.4L16 12zM17.75 5.5v13"/></svg>`;
const ICON_BOOST =
  `<svg class="icon icon--boost" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M6 13l6-6 6 6M6 19l6-6 6 6"/></svg>`;
const ICON_VOLUME =
  `<svg class="icon icon--vol" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4zM16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10"/></svg>`;
const ICON_MUTED =
  `<svg class="icon icon--vol" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4zM16.5 10l4 4M20.5 10l-4 4"/></svg>`;
const ICON_SHARE =
  `<svg class="icon icon--share" viewBox="0 0 24 24" aria-hidden="true"><path ${ICON_STROKE} d="M12 15V4m0 0L8 8m4-4 4 4M5 13v6h14v-6"/></svg>`;

// --- Volume -----------------------------------------------------------
//
// One <audio> element plays whichever station you tuned into, so volume
// is global by construction — one control, remembered across visits.
//
// iOS is the wrinkle: Safari there refuses programmatic volume (the
// hardware buttons own it) and silently keeps `volume` at 1. Rather than
// sniff the UA, ask the element: set a value and read it back. If it
// didn't take, the control would be a lie, so it never renders.
const VOL_STORE = 'ratbat_volume';
const MUTE_STORE = 'ratbat_muted';

let volume = 1;
let muted = false;
let volumeSupported = false;

function loadVolume() {
  try {
    const v = parseFloat(localStorage.getItem(VOL_STORE));
    if (!isNaN(v) && v >= 0 && v <= 1) volume = v;
    muted = localStorage.getItem(MUTE_STORE) === '1';
  } catch { /* private mode: defaults are fine */ }
}

function saveVolume() {
  try {
    localStorage.setItem(VOL_STORE, String(volume));
    if (muted) localStorage.setItem(MUTE_STORE, '1');
    else localStorage.removeItem(MUTE_STORE);
  } catch { /* nothing to do — the session still works */ }
}

// Does this browser actually honour a set? (See the iOS note above.)
function detectVolumeSupport() {
  if (!$audio) return false;
  const before = $audio.volume;
  try {
    $audio.volume = 0.123;
    const took = Math.abs($audio.volume - 0.123) < 0.001;
    $audio.volume = before;
    return took;
  } catch {
    return false;
  }
}

function applyVolume() {
  if (!$audio) return;
  try {
    $audio.volume = volume;
    $audio.muted = muted;
  } catch { /* see detectVolumeSupport */ }
}

function setVolume(next, isMuted) {
  if (next != null) volume = Math.min(1, Math.max(0, next));
  if (isMuted != null) muted = isMuted;
  // Dragging up from silence is a request to hear something.
  if (next != null && next > 0 && muted) muted = false;
  applyVolume();
  saveVolume();
  if (typeof renderTopbar === 'function') renderTopbar();
}

// Rendered by the header row (panels.js) so it sits with the other
// always-on controls, but it lives here with the element it drives.
function volumeControlHTML() {
  if (!volumeSupported) return '';
  const pct = Math.round((muted ? 0 : volume) * 100);
  return `<span class="vol">
    <button type="button" class="vol-mute" title="${muted ? 'Unmute' : 'Mute'}"
      aria-label="${muted ? 'Unmute' : 'Mute'}">${muted ? ICON_MUTED : ICON_VOLUME}</button>
    <input type="range" class="vol-range" min="0" max="100" value="${pct}"
      aria-label="Volume" title="Volume ${pct}%">
  </span>`;
}

// Grid geometry — aims for the shape Jonas described:
// 1 → 1×1, 2 → 1×2 stacked, 3 → 1×3 stacked, 4 → 2×2, 5–6 → 3×2, then sqrt-ish.
function gridDims(n) {
  if (n <= 1) return [1, 1];
  if (n === 2) return [1, 2];
  if (n === 3) return [1, 3];
  if (n === 4) return [2, 2];
  if (n <= 6) return [3, 2];
  if (n <= 9) return [3, 3];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return [cols, rows];
}

// One ingestion path: SSE frames and poll responses both land here, so
// rendering can't diverge between transports.
function adoptNow(data) {
  stations = (data.stations || []).map((s) => {
    if (s.streamURL && s.streamURL.startsWith('/')) s.streamURL = API_BASE + s.streamURL;
    return s;
  });
  // If the active station went offline, stop.
  if (activeId && !stations.some((s) => s.id === activeId)) stop();
  render();
  syncTitle();
}

async function refresh() {
  try {
    const res = await fetch(`${API_BASE}/now.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    adoptNow(await res.json());
    pollFailures = 0;
  } catch {
    // Count the failure so schedulePoll backs off — the old fixed 1.5s
    // cadence hammered an unreachable broadcaster forever.
    pollFailures = Math.min(pollFailures + 1, 8);
    stations = [];
    stop();
    // Same reason render() freezes: an open editor holds live DOM state
    // in this subtree, and an unreachable broadcaster is no reason to
    // throw away what the owner is halfway through typing.
    if (inlineEditorId === null) {
      $stations.innerHTML = '<p class="empty">Broadcaster offline.</p>';
    }
  }
}

const ORIGIN_LABELS = { nts: 'NTS', lastFM: 'Last.fm', bandcamp: 'Bandcamp', library: 'Library' };

// Station kinds ride the wire as Swift coding keys; the grid and the
// editor both show them to people. One map, declared here because app.js
// evaluates first and panels.js reads it — never a second copy over
// there.
const KIND_LABELS = {
  nts: 'NTS', lastFM: 'Last.fm', bandcamp: 'Bandcamp',
  playlist: 'Playlist', libraryRadio: 'Library radio',
};
const kindLabel = (k) => KIND_LABELS[k] || k || 'Station';

// The owner surface exists only where BOTH are true: a key is stored and
// the server advertises station CRUD. Everything per-station gates on
// this one predicate — grid cards, the ✎, the ghost card.
const canManageStations = () => !!ownerKey() && capabilities.includes('stations');

async function loadOwnerStations() {
  if (!canManageStations()) return;
  try {
    const { ok, status, data } = await apiPost('/stations/list', { token: ownerKey() });
    if (ok) {
      ownerStations = data.stations || [];
      ownerStationsError = null;
    } else if (status === 503) {
      // 503 means the server HAS the route but no catalogue right now
      // (no music folder). Say so above the grid — dropping the idle
      // cards silently would read as "the stations are gone".
      ownerStationsError = briefMessage(data.message, 'catalogue unavailable');
    } else {
      // 403 already dropped the key inside apiPost, which hides the
      // owner surface wholesale; this line is for the other refusals.
      ownerStationsError = friendlyError(status, data);
    }
  } catch {
    ownerStationsError = 'Couldn’t reach the broadcaster';
  }
  render();
}

// Re-fetch on every signal that can change the roster: login, capability
// discovery, the SSE `stations` nudge, and after each mutation. Losing
// the key or the capability empties it, so the grid falls straight back
// to the guest view instead of keeping owner cards on screen.
function maybeLoadOwnerStations() {
  if (canManageStations()) { loadOwnerStations(); return; }
  if (!ownerStations.length && !ownerStationsError) return;
  ownerStations = [];
  ownerStationsError = null;
  render();
}

// What the grid draws. A guest sees exactly what is on air. The owner
// sees the roster: a station in both sources is one card built from both
// — identity (kind, autoStart) from the list, playing state from
// /now.json — and a station only the list knows about is a card marked
// off air.
function gridStations() {
  if (!canManageStations() || !ownerStations.length) return stations;
  const live = new Map(stations.map((s) => [s.id, s]));
  const cards = ownerStations.map((o) => {
    const l = live.get(o.id);
    live.delete(o.id);
    return l ? { ...o, ...l, offAir: false } : { ...o, offAir: true };
  });
  // Anything audibly on air that the roster hasn't caught up with (just
  // created, list still in flight) is still a card — never drop what a
  // listener can hear.
  live.forEach((s) => cards.push(s));
  return cards;
}

// ✎ opens the editor INSIDE this card. Owner + capability gated, and
// never on a playlist station: those are desktop-managed and the wire
// projects them to a name and a track count, so there is nothing here to
// edit.
function editButtonHTML(s) {
  if (!canManageStations() || s.kind === 'playlist') return '';
  // A word, not a glyph. The bare ✎ was there all along and nobody could
  // find it — "what a station is" is worth naming out loud.
  return `<button type="button" class="act act--edit"
    title="Station settings" aria-label="Settings for ${escapeHtml(s.name)}">Settings</button>`;
}

// The settings a station HAS, in one muted row under its name: what it
// is, what it is made of, when it is from. Reading them should not
// require opening anything.
function settingsSummaryHTML(s) {
  if (!canManageStations()) return '';
  const q = s.query || {};
  const bits = [kindLabel(s.kind)];
  const tags = (q.genreTags || []).filter(Boolean);
  if (tags.length) bits.push(tags.slice(0, 4).join(', ') + (tags.length > 4 ? '…' : ''));
  if (q.yearMin != null || q.yearMax != null) {
    bits.push(`${q.yearMin != null ? q.yearMin : '…'}–${q.yearMax != null ? q.yearMax : '…'}`);
  }
  if ((q.regions || []).length) bits.push((q.regions || []).map(regionName).join(', '));
  if (s.kind === 'playlist' && s.trackCount != null) bits.push(`${s.trackCount} tracks`);
  return bits.length > 1
    ? `<div class="setsum">${escapeHtml(bits.join(' · '))}</div>`
    : '';
}

// The form's markup lives in panels.js, which owns the editor's state
// machine. typeof-guarded like every other call into that file: it
// evaluates second, and an early render must not throw.
const editorBodyHTML = () =>
  typeof editorHTML === 'function' && typeof editor !== 'undefined' && editor
    ? editorHTML(editor)
    : '';

// A station that exists but isn't broadcasting. No transport, no track,
// no display-lag machinery — who it is, what it is, and the one control
// that changes that.
function offAirCardHTML(s) {
  const busy = stationBusy.has(s.id) ? 'disabled' : '';
  const note = actionNotes.get(s.id);
  // `broadcasting` from the roster while /now.json hasn't caught up means
  // a start is in the air — say so rather than lying "off".
  const starting = !!s.broadcasting;
  return `
    <div class="station station--off"
      style="--accent-h:${stationHue(s.id)}"
      data-id="${escapeHtml(s.id)}"
      data-offair="1">
      <div class="head">
        <span class="dot off" aria-hidden="true"></span>
        <span class="name">${escapeHtml(s.name)}</span>
        ${editButtonHTML(s)}
      </div>
      <div class="now">
        <span class="status">${starting ? 'Starting…' : 'Off air'}</span>
        ${settingsSummaryHTML(s) || `<span class="kind">${escapeHtml(kindLabel(s.kind))}</span>`}
      </div>
      <div class="foot">
        ${note ? `<span class="note" role="status">${escapeHtml(note)}</span>` : ''}
        <button type="button" class="btn s-start" ${busy}>${starting ? 'Stop' : 'Start'}</button>
      </div>
    </div>`;
}

// The card in edit mode: its identity line, then the form where the
// now-playing block was. Everything per-station is in there — this only
// gives it a home inside the station it belongs to.
function editorCardHTML(s) {
  return `
    <div class="station station--editing"
      style="--accent-h:${stationHue(s.id)}"
      data-id="${escapeHtml(s.id)}"
      data-editing="1">
      <div class="head">
        <span class="dot${s.offAir ? ' off' : ''}" aria-hidden="true"></span>
        <span class="name">${escapeHtml(s.name)}</span>
      </div>
      <div class="editor">${editorBodyHTML()}</div>
    </div>`;
}

function render() {
  // Keep the lock in step with the stored passcode from one place: a 403
  // can drop the key mid-session, and the icon must not keep claiming
  // owner mode after the buttons have gone.
  syncLock();
  // THE TRAP. renderGrid() rebuilds #stations wholesale, and it runs on
  // every poll and every SSE frame — 1.5–3s apart. The inline editor
  // lives inside that subtree, so repainting under an open form would
  // throw away the focus, the caret and every keystroke since the last
  // paint. While an editor is open the grid is FROZEN: the editor
  // repaints only its own subtree from its own state (renderEditor in
  // panels.js), and normal rendering resumes with a full renderGrid() on
  // save, cancel or delete.
  if (inlineEditorId !== null) return;
  renderGrid();
}

function renderGrid() {
  // A form is taller than a now-playing line. While one is open the grid
  // drops its one-screen discipline and lets the cards size to their
  // content — the page scrolls instead of the form being cut off.
  if ($stations.classList && typeof $stations.classList.toggle === 'function') {
    $stations.classList.toggle('editing', inlineEditorId !== null);
  }
  // An empty card at the end of the grid is the "add a station" button:
  // the shape you are about to create, in the place it will appear.
  // Owner-only, and only once the server advertises station CRUD.
  const canCreate = canManageStations();
  const cards = gridStations();
  if (!cards.length && !canCreate) {
    $stations.style.setProperty('--cols', 1);
    $stations.style.setProperty('--rows', 1);
    $stations.style.setProperty('--count', 1);
    $stations.innerHTML = '<p class="empty">No stations broadcasting right now.</p>';
    return;
  }
  // A roster that wouldn't load is a line across the top of the grid,
  // never a card: the cards that DID load stay usable underneath it.
  const rosterNote = ownerStationsError
    ? `<p class="gnote" role="alert">${escapeHtml(ownerStationsError)}</p>`
    : '';
  const cardCount = cards.length + (canCreate ? 1 : 0);
  const [cols, rows] = gridDims(cardCount);
  $stations.style.setProperty('--cols', cols);
  $stations.style.setProperty('--rows', rows + (rosterNote ? 1 : 0));
  $stations.style.setProperty('--count', cardCount + (rosterNote ? 1 : 0));

  const playing = !$audio.paused && $audio.readyState >= 3;
  // Loading = user asked to play (audio element has src + isn't paused)
  // but data isn't ready yet. Covers initial fetch + mid-stream rebuffer
  // (readyState drops back under 3 and the `waiting` event fires).
  const loading = !!$audio.src && !$audio.paused && $audio.readyState < 3;

  $stations.innerHTML = rosterNote + cards.map((s) => {
    // The two cards that are not a now-playing card: this station's
    // editor, and a station that exists but isn't on air.
    if (inlineEditorId === s.id) return editorCardHTML(s);
    if (s.offAir) return offAirCardHTML(s);
    const active = activeId === s.id;
    const isPlaying = active && playing;
    const isLoading = active && loading;
    const shown = displayTrack(s);
    const t = shown.track;
    // Meta stays text-only by design — `artworkURL` is deliberately
    // ignored. Album and progress are quiet second-order lines; the
    // progress span's text is re-patched every second by the tick above.
    const progress = active && t ? progressText(s.id) : '';
    // The album is a second-order fact — say so: "from <album>", the
    // "from" muted. Suppressed when empty or when it repeats the title
    // (a self-titled release used to make three near-identical lines).
    const albumShown = t && t.album
      && String(t.album).trim().toLowerCase() !== String(t.title ?? '').trim().toLowerCase();
    const now = isLoading
      ? `<span class="status">Connecting…</span>`
      : t
        ? `<b class="title">${escapeHtml(t.title)}</b><span class="artist">${escapeHtml(t.artist)}</span>`
          + (albumShown ? `<span class="album"><span class="from">from</span> ${escapeHtml(t.album)}</span>` : '')
          + (progress ? `<span class="progress" data-station="${escapeHtml(s.id)}">${progress}</span>` : '')
        : `<span class="status">Live</span>`;
    const classes = [
      'station',
      active ? 'active' : '',
      isPlaying ? 'playing' : '',
      isLoading ? 'loading' : '',
    ].filter(Boolean).join(' ');
    // ♥ / 👎 only on the active card — you judge what you're hearing.
    // (The server agrees: /like and /skip 404 without a current track.)
    // Real <button>s can't nest, so the card is a div[role=button] and
    // the action buttons stop the card's play/pause toggle themselves.
    const liked = likedKeys.has(trackKey(s));
    const note = actionNotes.get(s.id);
    // Owner-only controls, and only when display has settled — during
    // the lag window a ♥ would target the server's (next) track, not the
    // one being heard. Share is for everyone: guests spreading the radio
    // is the point.
    const disabled = actionBusy.has(s.id) || !shown.settled ? 'disabled' : '';
    const likeLabel = liked ? 'Remove from library' : 'Save to library';
    const ownerActions = ownerKey()
      ? `<button type="button" class="act act--like${liked ? ' liked' : ''}"
          title="${likeLabel}" aria-label="${likeLabel}" ${disabled}>
          ${liked ? ICON_HEART_FILLED : ICON_HEART}
        </button>
        <button type="button" class="act act--boost"
          title="More like this" aria-label="More like this" ${disabled}>
          ${ICON_BOOST}
        </button>
        <button type="button" class="act act--skip"
          title="Less like this" aria-label="Less like this" ${disabled}>
          ${ICON_THUMBSDOWN}
        </button>
        <button type="button" class="act act--next"
          title="Skip track" aria-label="Skip track" ${disabled}>
          ${ICON_NEXT}
        </button>`
      : '';
    // Share shows on every card with a track — guests can pass along
    // what a channel is playing without tuning in. Owner controls stay
    // on the active card: you only judge what you're hearing.
    const actions = t
      ? `<span class="actions">
          ${active ? ownerActions : ''}
          <button type="button" class="act act--share" title="Share this track" aria-label="Share this track">
            ${ICON_SHARE}
          </button>
          ${note
            ? `<span class="note" role="status">${escapeHtml(note)}</span>`
            : (active && s.listeners > 1
              ? `<span class="note" title="Skips and next affect every listener">${s.listeners} listening</span>`
              : '')}
        </span>`
      : '';
    // Timeline on the active card: the certain next track, then what
    // just played (each row retro-♥-able for the owner, linkable for
    // everyone). Recent rows still inside the display-lag window are
    // suppressed — the card's now-playing is still showing them.
    const shownKey = (displayState.get(s.id) || {}).shownKey;
    const links = (o) => [
      o.sourceURL ? `<a class="tlink" href="${escapeHtml(o.sourceURL)}" target="_blank" rel="noopener">source</a>` : '',
      o.youtubeURL ? `<a class="tlink" href="${escapeHtml(o.youtubeURL)}" target="_blank" rel="noopener">yt</a>` : '',
    ].join('');
    const recentRows = (s.recent || [])
      .filter((r) => `${s.id}|${r.artist}|${r.title}` !== shownKey)
      .slice(0, 4)
      .map((r) => `
        <li>
          ${r.playedAt ? `<span class="ttime">${escapeHtml(fmtTime(r.playedAt))}</span>` : ''}
          ${ownerKey()
            ? `<button type="button" class="act act--retro" data-entry="${escapeHtml(r.entryID)}" title="Save to library" aria-label="Save ${escapeHtml(r.title)}">${ICON_HEART}</button>`
            : ''}
          <span class="ttrack">${escapeHtml(r.artist)} — ${escapeHtml(r.title)}</span>
          ${links(r)}
        </li>`).join('');
    const timeline = active && (s.nextTrack || recentRows)
      ? `<div class="timeline">
          ${s.nextTrack ? `<div class="tnext">Next: ${escapeHtml(s.nextTrack.artist)} — ${escapeHtml(s.nextTrack.title)}</div>` : ''}
          ${recentRows ? `<ul class="trecent">${recentRows}</ul>` : ''}
        </div>`
      : '';
    // Origin badge: which source fed the station this track. Wire values
    // are Swift coding keys — map them to display names, pass unknown
    // ones through so new origins degrade to their raw name.
    const origin = t && t.origin
      ? `<span class="origin">${escapeHtml(ORIGIN_LABELS[t.origin] || t.origin)}</span>`
      : '';
    // What's known about the track on air, written onto the station
    // itself — no toggle, no panel, nothing to click. Only the current
    // track earns it; the recent rows stay a bare list.
    if (t) ensureTrackInfo(s.id, t);
    const info = t ? trackInfoHTML(t) : '';
    // The origin badge is provenance and renders on EVERY card with a
    // track — a guest scanning the grid gets to see where each channel
    // sources from. Links stay on the active card: you dig into what
    // you're hearing.
    const nowLinks = t && (origin || (active && (t.sourceURL || t.youtubeURL)))
      ? `<span class="nowlinks">${origin}${active ? links(t) : ''}</span>`
      : '';
    // ✎ opens the station's editor inside this very card (see
    // editorCardHTML) — the grid stays a radio until you ask it not to.
    const editBtn = editButtonHTML(s);
    return `
      <div role="button" tabindex="0"
        class="${classes}"
        style="--accent-h:${stationHue(s.id)}"
        data-id="${escapeHtml(s.id)}"
        data-url="${escapeHtml(s.streamURL || '')}"
        aria-pressed="${active}"
        aria-busy="${isLoading}">
        <div class="head">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">${escapeHtml(s.name)}</span>
          ${editBtn}
        </div>
        ${settingsSummaryHTML(s)}
        <div class="now">${now}${nowLinks}</div>
        ${info}
        ${timeline}
        <div class="foot">
          ${actions}
          <span class="transport" title="${isPlaying ? 'Pause' : 'Play'}"
            aria-label="${isPlaying ? 'Pause' : 'Play'}">${ICON_LOADING}${ICON_PLAY}${ICON_PAUSE}</span>
        </div>
      </div>`;
  }).join('') + (canCreate
    ? (inlineEditorId === NEW_CARD_ID
      // The ghost card holds its own create form: the station you are
      // about to make, in the place it will appear.
      ? `<div class="station station--new station--editing" data-new="1" data-editing="1">
          <div class="head"><span class="name">New station</span></div>
          <div class="editor">${editorBodyHTML()}</div>
        </div>`
      : `<div role="button" tabindex="0" class="station station--new" data-new="1"
          title="Add a new station" aria-label="Add a new station">
          <div class="now"><span class="newplus" aria-hidden="true">＋</span><span class="newlabel">New station</span></div>
        </div>`)
    : '');
}

// The inline editor lives inside #stations, so the grid's own listeners
// are the only ones its events pass through. They hand the whole editor
// subtree to panels.js, which owns that form's state machine — nothing
// about it is re-implemented here. All four handlers are typeof-guarded:
// panels.js evaluates second.
$stations.addEventListener('click', (e) => {
  // Provenance links navigate; they must not toggle playback.
  if (e.target.closest('a')) return;
  // An open editor is a form, not a play/pause surface.
  if (e.target.closest('.editor')) {
    if (typeof onControlClick === 'function') onControlClick(e);
    return;
  }
  const card = e.target.closest('.station');
  if (!card) return;
  // The chrome around an open editor is inert — its own buttons are the
  // way out, and a stray click must not reset the form.
  if (card.dataset.editing) return;
  if (card.dataset.new) {
    // Defined in panels.js — guarded because that file loads second.
    if (typeof openNewStationFlow === 'function') openNewStationFlow();
    return;
  }
  // The one control an off-air card offers.
  if (e.target.closest('.s-start')) {
    if (typeof startStopStation === 'function') startStopStation(card.dataset.id);
    return;
  }
  const act = e.target.closest('.act');
  if (act) {
    if (act.classList.contains('act--share')) {
      openTrack(card.dataset.id);
      return;
    }
    if (act.classList.contains('act--edit')) {
      // Defined in panels.js — guarded because that file loads second.
      if (typeof openStationEditorById === 'function') openStationEditorById(card.dataset.id);
      return;
    }
    if (act.classList.contains('act--retro')) {
      sendAction(card.dataset.id, 'like', act.dataset.entry);
      return;
    }
    let kind = act.classList.contains('act--like') ? 'like'
      : act.classList.contains('act--boost') ? 'boost'
      : act.classList.contains('act--next') ? 'next'
      : 'skip';
    // The heart toggles: pressed while filled = undo the ♥.
    if (kind === 'like') {
      const s = stations.find((x) => x.id === card.dataset.id);
      if (s && likedKeys.has(trackKey(s))) kind = 'unlike';
    }
    sendAction(card.dataset.id, kind);
    return;
  }
  // An off-air card has no stream behind it; its buttons are its whole
  // interface.
  if (card.dataset.offair || !card.dataset.url) return;
  toggle(card.dataset.id, card.dataset.url);
});

// div[role=button] doesn't get click-on-Enter/Space for free the way a
// real <button> did — restore it so the cards stay keyboard-operable.
$stations.addEventListener('keydown', (e) => {
  // Typing in the editor must never reach the card's play/pause keys.
  if (e.target.closest && e.target.closest('.editor')) {
    if (typeof onControlKeydown === 'function') onControlKeydown(e);
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.station');
  if (!card || e.target.closest('.act') || card.dataset.editing) return;
  e.preventDefault();
  if (card.dataset.new) {
    if (typeof openNewStationFlow === 'function') openNewStationFlow();
    return;
  }
  if (card.dataset.offair || !card.dataset.url) return;
  toggle(card.dataset.id, card.dataset.url);
});

$stations.addEventListener('input', (e) => {
  if (!e.target.closest || !e.target.closest('.editor')) return;
  if (typeof onControlInput === 'function') onControlInput(e);
});

$stations.addEventListener('change', (e) => {
  if (!e.target.closest || !e.target.closest('.editor')) return;
  if (typeof onControlChange === 'function') onControlChange(e);
});

// Transient per-station status line ("Saved ♥", "Already in your
// library", "Couldn't reach the broadcaster") — cleared after a beat.
const actionNotes = new Map();
function showNote(id, text) {
  actionNotes.set(id, text);
  render();
  setTimeout(() => {
    if (actionNotes.get(id) === text) { actionNotes.delete(id); render(); }
  }, 3000);
}

// Server error messages can be raw Swift error dumps (with local
// filesystem paths) — keep notes short and screen-sized.
const briefMessage = (m, fallback) =>
  m && m.length <= 60 ? m : fallback;

// AbortSignal.timeout is iOS 16.4+ — on older Safari it would throw
// synchronously and break the action entirely. Degrade to no timeout.
const timeoutSignal = (ms) =>
  typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(ms)
    : undefined;

// Every JSON POST goes through here: one place for the timeout, the
// JSON dance, and the 403 handling — a stored key that stops working
// (rotated on the broadcaster) is dropped centrally so owner UI hides
// everywhere instead of failing forever. Throws on network error /
// timeout so callers can tell "broadcaster said no" from "couldn't ask".
async function apiPost(path, body, ms = 8000) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(ms),
  });
  const data = await res.json().catch(() => ({}));
  // Only drop the session when the refused request actually carried the
  // stored key — checkOwnerKey also probes *candidate* passcodes (login
  // prompt, legacy #key= links), and a wrong guess there must not log
  // out the session that was fine the whole time.
  if (res.status === 403 && body && body.token && body.token === ownerKey()) {
    storeOwnerKey(null);
    syncLock();
    render();
  }
  return { ok: res.ok, status: res.status, data };
}

// Public JSON GETs (trackinfo) — the same timeout and JSON dance as
// apiPost, but no token and no body: the routes it serves are public.
// Throws on network error / timeout so callers can tell "broadcaster
// said no" from "couldn't ask", same as apiPost.
async function apiGet(path, ms = 8000) {
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    signal: timeoutSignal(ms),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Short, human translations for statuses whose meaning is fixed here.
// Anything unmapped falls back to the server's message when it's
// screen-sized (sendAction keeps its own per-action wording; this map
// is the shared surface for panels.js in a later milestone).
const FRIENDLY_STATUS = {
  401: 'Passcode no longer valid',
  403: 'Passcode no longer valid',
  404: 'Not available on this broadcaster',
  409: 'That name is taken',
  410: 'Station no longer exists',
  422: 'Check the form',
  503: 'Broadcaster hiccup — try again',
};
function friendlyError(status, data) {
  if (FRIENDLY_STATUS[status]) return FRIENDLY_STATUS[status];
  if (status >= 500) return 'Broadcaster hiccup — try again';
  return briefMessage(data && data.message, 'Broadcaster hiccup — try again');
}

// POST ♥ / 👎 / ⏭ for the station's current track. The body wants the
// station's UUID (`id` from /now.json), not the slug. ♥ saves and fills
// until the track changes; 👎 dislikes AND advances (taste blacklist);
// ⏭ advances with no judgement recorded. Timeboxed: a hung request must
// un-busy the button, not dim it forever.
async function sendAction(id, kind, entry) {
  if (actionBusy.has(id)) return;
  actionBusy.add(id);
  render();
  try {
    const { ok, status, data } = await apiPost(`/${kind}`, {
      station: id, token: ownerKey(), entry: entry || undefined,
    });
    if (status === 403) {
      // apiPost already dropped the rotated key — the per-card note is
      // the only thing left to do.
      showNote(id, 'Passcode no longer valid — tap the lock to re-enter');
      actionBusy.delete(id);
      render();
      return;
    }
    if (kind === 'like') {
      // 'saved' = downloaded into the library; 'noted' = already owned,
      // affinity recorded ("♥ always means more like this" — the
      // download is just a side effect when the track isn't yours yet).
      // A retro-♥ (entry set) fills nothing on the current card — it
      // acted on a past track, the note is the feedback.
      if (ok && (data.status === 'saved' || data.status === 'noted')) {
        if (!entry) {
          const s = stations.find((x) => x.id === id);
          const key = trackKey(s);
          if (key) likedKeys.add(key);
        }
        showNote(id, entry
          ? 'Saved from history ♥'
          : (data.status === 'noted' ? 'More like this ♥' : 'Saved to library ♥'));
      } else if (status === 409) {
        // Pre-affinity servers refuse owned tracks — keep their message
        // sensible until the Mini catches up.
        showNote(id, 'Already in your library');
      } else {
        showNote(id, briefMessage(data.message, 'Couldn’t save'));
      }
    } else if (kind === 'boost') {
      showNote(id, ok ? 'Steering toward this ⤴' : briefMessage(data.message, 'Couldn’t boost'));
    } else if (kind === 'unlike') {
      if (ok) {
        const s = stations.find((x) => x.id === id);
        const key = trackKey(s);
        if (key) likedKeys.delete(key);
        showNote(id, 'Removed ♡');
      } else {
        showNote(id, briefMessage(data.message, 'Couldn’t undo'));
      }
    } else if (!ok) {
      showNote(id, briefMessage(data.message, kind === 'next' ? 'Couldn’t advance' : 'Couldn’t skip'));
    }
  } catch {
    showNote(id, 'Couldn’t reach the broadcaster');
  }
  actionBusy.delete(id);
  render();
  if (kind === 'skip' || kind === 'next') setTimeout(refresh, 1200);
}

async function toggle(id, url) {
  if (activeId === id) {
    if ($audio.paused) {
      wantsAudio = true;
      try { await $audio.play(); } catch {}
    } else {
      // An explicit pause is the one thing the watchdog must respect.
      wantsAudio = false;
      $audio.pause();
    }
    render();
    return;
  }
  activeId = id;
  activeURL = url;
  wantsAudio = true;
  reconnectAttempts = 0;
  $audio.src = url;
  try { await $audio.play(); } catch { /* autoplay policy — user will retap */ }
  render();
  syncTitle();
}

function stop() {
  activeId = null;
  activeURL = null;
  wantsAudio = false;
  cancelReconnect();
  $audio.pause();
  $audio.removeAttribute('src');
  $audio.load();
}

// --- Keeping the stream alive -----------------------------------------
//
// A live stream is not a file: it ends whenever the broadcaster restarts,
// the tunnel blips, or the network coughs. The page used to treat all of
// that as "the user stopped listening" — it rendered a paused card and
// waited, so an iMac left playing would be silent hours later with no
// sign of why.
//
// So: remember whether the listener WANTS audio, and if the element
// stops while they do, reconnect. Backoff because the broadcaster may be
// mid-restart, and a cache-buster because a dead stream URL is exactly
// the thing a browser is happiest to serve from cache.
let wantsAudio = false;
let activeURL = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastProgressAt = 0;

const RECONNECT_CAP_MS = 30000;
// Long enough that a normal rebuffer resolves itself first; short enough
// that nobody stands there wondering whether it is coming back.
const STALL_LIMIT_MS = 20000;

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect(why) {
  if (!wantsAudio || !activeURL || reconnectTimer) return;
  const wait = Math.min(1000 * 2 ** reconnectAttempts, RECONNECT_CAP_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!wantsAudio || !activeURL) return;
    // A fresh query each time: without it the browser may hand back the
    // very connection that just died.
    const sep = activeURL.includes('?') ? '&' : '?';
    $audio.src = `${activeURL}${sep}r=${reconnectAttempts}-${lastProgressAt}`;
    $audio.play().catch(() => scheduleReconnect('play refused'));
    render();
  }, wait);
  showNote(activeId, why);
  render();
}

// Progress is the only honest proof a stream is alive: `playing` fires
// before a single byte of audio has to arrive.
$audio.addEventListener('timeupdate', () => {
  lastProgressAt = Date.now();
  if (reconnectAttempts) { reconnectAttempts = 0; cancelReconnect(); }
});

// A pause the page did not ask for — the OS media key, the headphones,
// the lock screen — is still the listener's intent, and the watchdog
// must not argue with it. Only a deliberate pause reaches here with the
// element healthy and full of data; a dying stream pauses with an error
// set or with its buffer already gone.
$audio.addEventListener('pause', () => {
  if (!$audio.error && $audio.readyState >= 3) wantsAudio = false;
});

// The stream ended or broke while the listener still wants it. That is
// never a normal end for a radio station.
['ended', 'error'].forEach((ev) => $audio.addEventListener(ev, () => {
  if (wantsAudio) scheduleReconnect('Reconnecting…');
}));

// A stall that resolves itself is a rebuffer; one that doesn't is a dead
// connection wearing a rebuffer's clothes.
setInterval(() => {
  if (!wantsAudio || !activeURL || reconnectTimer) return;
  if (!$audio.paused && $audio.readyState >= 3) return;
  if (lastProgressAt && Date.now() - lastProgressAt < STALL_LIMIT_MS) return;
  if (!lastProgressAt) return;
  scheduleReconnect('Reconnecting…');
}, 5000);

// Coming back to a sleeping laptop: browsers suspend media in background
// tabs and some never resume it. If the listener still wants audio and
// it is not running, get it running.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (wantsAudio && $audio.paused) {
    $audio.play().catch(() => scheduleReconnect('Reconnecting…'));
  }
});

// Open what's being HEARD (the display-lagged track) in a new tab — the
// real release/video page when the server knows it (listen there, share
// from there), a Bandcamp search for the track when it doesn't. Must be
// synchronous with the click or popup blockers eat the tab.
function openTrack(id) {
  const s = stations.find((x) => x.id === id);
  if (!s) return;
  const t = (displayState.get(id) || {}).shownTrack || s.currentTrack;
  if (!t) return;
  const label = `${t.artist} — ${t.title}`;
  const link = t.sourceURL || t.youtubeURL
    || `https://bandcamp.com/search?q=${encodeURIComponent(label)}`;
  window.open(link, '_blank', 'noopener');
}

// Full set of events that change the "is it actually playing / is it
// buffering / is it stalled" visible state. `loadstart` fires as soon as
// we assign a new src, so the loading indicator appears immediately.
['loadstart', 'canplay', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error'].forEach((ev) =>
  $audio.addEventListener(ev, render),
);

function syncTitle() {
  if (!activeId) { document.title = 'Ratbat'; return; }
  const s = stations.find((x) => x.id === activeId);
  if (!s) { document.title = 'Ratbat'; return; }
  const t = s.currentTrack;
  document.title = t ? `${t.artist} — ${t.title} · Ratbat` : `${s.name} · Ratbat`;
}

// --- Transport -------------------------------------------------------
//
// SSE is the live path: the broadcaster pushes a full now.json snapshot
// over `/events` on every change. Polling stays as the fallback — for
// browsers without EventSource, and for whenever the stream is down.

// Poll faster when nothing is live so new broadcasts appear quickly;
// back off once stations are up (keeps now-playing fresh without hammering).
const POLL_FAST = 1500;
const POLL_SLOW = 3000;
let pollTimer = null;
let pollFailures = 0;

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  // SSE owns freshness while it's healthy — the poll loop stands down
  // and connectEvents() restarts it if the stream drops.
  if (sseAlive) { pollTimer = null; return; }
  // Consecutive failures back the cadence off exponentially (cap 30s).
  const delay = pollFailures
    ? Math.min(POLL_FAST * 2 ** pollFailures, 30_000)
    : (stations.length ? POLL_SLOW : POLL_FAST);
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, delay);
}

let es = null;
let sseAlive = false;
let sseEverOpened = false;
let sseRetries = 0;
let sseRetryTimer = null;
let lastEventAt = 0;

function connectEvents() {
  // No EventSource (museum-piece browsers) — polling continues, status quo.
  if (!window.EventSource) return;
  if (es) es.close();
  const src = new EventSource(`${API_BASE}/events`);
  es = src;
  const adopt = (e) => {
    lastEventAt = performance.now();
    try { adoptNow(JSON.parse(e.data)); } catch { /* malformed frame — a poll will correct */ }
  };
  // Today's server sends unnamed `data:` frames (→ onmessage); the next
  // one names its events. Listen on both paths so this client works
  // against either server without a flag day.
  src.onmessage = adopt;
  src.addEventListener('now', adopt);
  // `stations` is a change *notification*, not data. /events is public
  // (Allow-Origin: *), so owner data must NEVER ride SSE — on a nudge we
  // re-fetch the public snapshot, and owner surfaces (later milestone)
  // re-fetch their token-gated routes themselves.
  src.addEventListener('stations', () => {
    lastEventAt = performance.now();
    refresh();
    // The owner's roster re-fetches itself over its own token-gated
    // route on the same nudge — the grid shows idle stations too, so a
    // station created or deleted elsewhere has to land here.
    maybeLoadOwnerStations();
  });
  // Named heartbeat from the next server — makes the staleness watchdog
  // below exact instead of best-effort.
  src.addEventListener('ping', () => { lastEventAt = performance.now(); });
  src.onopen = () => {
    if (es !== src) return;
    sseAlive = true;
    sseRetries = 0;
    // A reconnect often follows a broadcaster redeploy — re-read
    // /health so a capability change (upgrade or rollback) is noticed
    // without a page reload. The first open skips it: boot already
    // probed.
    if (sseEverOpened) probeHealth();
    sseEverOpened = true;
    // The stream connecting proves the broadcaster is reachable — if it
    // drops again, polling must resume at its normal cadence, not a
    // failure backoff left over from before the outage ended.
    pollFailures = 0;
    lastEventAt = performance.now();
    // SSE has freshness now — stop the poll loop.
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  };
  src.onerror = () => {
    // A stale instance erroring after being replaced must not touch the
    // live one's state.
    if (es !== src) { src.close(); return; }
    // EventSource would retry on its own, but with no backoff and no
    // signal to us — close it and own the schedule: exponential with
    // jitter, polling resumes to cover the gap.
    src.close();
    sseAlive = false;
    const delay = Math.min(1000 * 2 ** sseRetries, 30_000);
    sseRetries = Math.min(sseRetries + 1, 8);
    clearTimeout(sseRetryTimer);
    sseRetryTimer = setTimeout(connectEvents, delay + delay * 0.2 * Math.random());
    // Every failed reconnect lands here — rescheduling unconditionally
    // would keep resetting the pending poll timer and let a fast retry
    // cadence starve the very fallback meant to cover the gap.
    if (!pollTimer) schedulePoll();
  };
}

// Staleness watchdog. Today's server heartbeat is an SSE *comment*
// (`: heartbeat`), invisible to EventSource — a silently dead connection
// looks identical to a quiet one. Best effort until the named `ping`
// ships: if nothing arrived for 90s while the tab is visible, assume the
// worst and reconnect.
setInterval(() => {
  if (document.visibilityState !== 'visible' || !sseAlive) return;
  if (performance.now() - lastEventAt > 90_000) {
    es.close();
    sseAlive = false;
    connectEvents();
  }
}, 90_000);

// --- Capabilities -----------------------------------------------------
//
// /health is the capability anchor (settled decision): the server lists
// what it can do and the client believes it. Old servers 404 the route
// — empty capabilities, so no owner panels and no health strip; the
// deployed site must look exactly like today against them. Memory-only
// on purpose: the Mini can be redeployed any time, so nothing here is
// cached across page loads.
let serverHealth = null; // last /health payload; null = old server / unreachable
let capabilities = [];   // serverHealth.capabilities, [] when absent

async function probeHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`, {
      cache: 'no-store', signal: timeoutSignal(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    serverHealth = data;
    capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
  } catch {
    serverHealth = null;
    capabilities = [];
  }
  // panels.js redraws the bar and strip — guarded, load-order note there.
  if (typeof onHealthChange === 'function') onHealthChange();
  // A server that just advertised (or dropped) station CRUD changes what
  // the grid is allowed to be.
  maybeLoadOwnerStations();
}

// The strip shows uptime — keep it honest while the tab is watched.
// Only re-probes where a probe has succeeded before; a server gaining
// /health is discovered by the SSE-reconnect probe instead.
setInterval(() => {
  if (document.visibilityState === 'visible' && serverHealth) probeHealth();
}, 60_000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  // Tabs coming back from the background often return with a dead
  // EventSource — reconnect now rather than waiting out the backoff.
  if (window.EventSource && !sseAlive) {
    clearTimeout(sseRetryTimer);
    sseRetries = 0;
    connectEvents();
  }
  // A boot-time key check that couldn't reach the broadcaster gets
  // another chance whenever the tab is looked at again.
  if (keyCheckPending) validateStoredKey();
});

// --- Owner login -----------------------------------------------------
//
// Ask the broadcaster whether a passcode is the owner's. `POST /auth`
// answers 200 or 403 and changes nothing, so the prompt can report a
// typo without ♥-ing a track to find out. Returns null when the question
// couldn't be asked at all — "wrong" and "unreachable" deserve different
// messages, and conflating them is how you end up retyping a passcode
// that was right the whole time.
async function checkOwnerKey(key) {
  try {
    const { status } = await apiPost('/auth', { token: key });
    return status === 200;
  } catch {
    return null;
  }
}

// Boot-time validation of the stored passcode. The lock used to claim
// 🔓 until the first failing action; ask /auth up front instead so the
// owner signal is trustworthy before any owner UI shows. Silent when
// the key is fine. Wrong ≠ unreachable: a 403 clears the key, a network
// failure keeps it and retries on the next visibilitychange.
let keyCheckPending = false;
async function validateStoredKey() {
  keyCheckPending = false;
  if (!ownerKey()) return;
  const ok = await checkOwnerKey(ownerKey());
  if (ok === false) {
    // checkOwnerKey's 403 already dropped the key via apiPost — surface
    // why the buttons vanished, once, on the card being listened to.
    syncLock();
    render();
    if (activeId) showNote(activeId, 'Passcode no longer valid — tap the lock');
  } else if (ok === null) {
    keyCheckPending = true;
  }
}

let lastOwnerState = null;
function syncLock() {
  const on = !!ownerKey();
  if ($lock) {
    $lock.textContent = on ? '🔓' : '🔒';
    const lockLabel = on ? 'Owner menu' : 'Owner login';
    $lock.setAttribute('aria-label', lockLabel);
    $lock.setAttribute('title', lockLabel);
    $lock.classList.toggle('on', on);
  }
  // Panels gate owner-only UI on the same signal — poke panels.js when
  // it flips (login, logout, rotation). Guarded with typeof: render()
  // can run before panels.js has evaluated (see the load-order note
  // there), and only on a real flip so the every-render syncLock call
  // doesn't rebuild the panel bar constantly.
  if (on !== lastOwnerState) {
    lastOwnerState = on;
    if (typeof onOwnerChange === 'function') onOwnerChange();
    // Logging in reveals the idle stations; logging out must forget them.
    maybeLoadOwnerStations();
  }
}

async function unlock() {
  if (ownerKey()) {
    if (confirm('Log out of owner mode on this device?')) {
      storeOwnerKey(null);
      syncLock();
      render();
    }
    return;
  }
  const entered = prompt('Owner passcode');
  if (entered === null) return;
  const key = entered.trim();
  if (!key) return;
  const ok = await checkOwnerKey(key);
  if (ok === null) {
    alert('Couldn’t reach the broadcaster — try again in a moment.');
    return;
  }
  if (!ok) {
    alert('Wrong passcode.');
    return;
  }
  storeOwnerKey(key);
  syncLock();
  render();
}

if ($lock) {
  $lock.addEventListener('click', unlock);
  syncLock();
}

// Legacy unlock link: /#key=<passcode>. Kept working because old
// bookmarks exist, but validated now rather than trusted — storing an
// unverified key used to mean the buttons appeared and then failed.
// The hash is stripped either way so the passcode doesn't linger in the
// address bar or get shared by copy-pasting the URL.
(async () => {
  const m = window.location.hash.match(/^#key=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  const key = decodeURIComponent(m[1]).trim();
  if (await checkOwnerKey(key)) {
    storeOwnerKey(key);
    syncLock();
    render();
  }
})();

// Volume before anything can play: restore what this browser chose last
// time, and find out whether choosing is even possible here.
loadVolume();
volumeSupported = detectVolumeSupport();
applyVolume();

refresh().then(() => {
  connectEvents();
  schedulePoll();
});
validateStoredKey();
probeHealth();
