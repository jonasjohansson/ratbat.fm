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

// Owner key — actions (♥/👎/⏭) are owner-only server-side; guests get a
// radio, not a mixer. Unlock once per device by visiting #key=<owner key>
// (shown in the Mac app's Settings → Broadcast); stored in localStorage.
// A 403 despite a stored key means the key rotated — drop it and hide
// the buttons again.
(() => {
  const m = window.location.hash.match(/^#key=(.+)$/);
  if (m) {
    try { localStorage.setItem('ratbat_key', decodeURIComponent(m[1])); } catch {}
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
})();
const ownerKey = () => {
  try { return localStorage.getItem('ratbat_key') || null; } catch { return null; }
};

// The now-playing DISPLAY lags the server on purpose: the server flips
// the moment the encoder starts the next track, but listeners are ~ring
// buffer + browser buffer behind (10s+). Hold the old title until the
// audio has plausibly caught up. While display and server disagree, the
// action buttons pause — a ♥ would target the server's track, not the
// one being heard.
const DISPLAY_DELAY_MS = 10_000;
const displayState = new Map(); // id -> {shownKey, shownTrack, pendingKey, pendingTrack, pendingAt}

function displayTrack(s) {
  const st = displayState.get(s.id) || {};
  const incoming = trackKey(s);
  if (!st.shownKey || activeId !== s.id) {
    // Nothing shown yet (or nobody's listening to this card) — no lag to
    // honor, adopt immediately.
    displayState.set(s.id, { shownKey: incoming, shownTrack: s.currentTrack });
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
  }
  if (performance.now() - st.pendingAt >= DISPLAY_DELAY_MS) {
    displayState.set(s.id, { shownKey: incoming, shownTrack: s.currentTrack });
    return { track: s.currentTrack, settled: true };
  }
  return { track: st.shownTrack, settled: false };
}

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

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const ICON_PLAY =
  '<svg class="icon icon--play" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5v14l12-7z"/></svg>';
const ICON_PAUSE =
  '<svg class="icon icon--pause" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const ICON_LOADING =
  '<svg class="icon icon--loading" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="42" stroke-dashoffset="28"/></svg>';
const ICON_HEART =
  '<svg class="icon icon--heart" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M12 20.5C7 16.5 3.5 13.2 3.5 9.4 3.5 6.9 5.4 5 7.9 5c1.6 0 3.1.8 4.1 2.2C13 5.8 14.5 5 16.1 5c2.5 0 4.4 1.9 4.4 4.4 0 3.8-3.5 7.1-8.5 11.1z"/></svg>';
const ICON_HEART_FILLED =
  '<svg class="icon icon--heart-filled" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.5C7 16.5 3.5 13.2 3.5 9.4 3.5 6.9 5.4 5 7.9 5c1.6 0 3.1.8 4.1 2.2C13 5.8 14.5 5 16.1 5c2.5 0 4.4 1.9 4.4 4.4 0 3.8-3.5 7.1-8.5 11.1z"/></svg>';
const ICON_THUMBSDOWN =
  '<svg class="icon icon--skip" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M16 3H7.5L5 11v2h6l-1 5.5 1.5 1.5 4.5-7V3zm0 0h3v10h-3"/></svg>';
const ICON_NEXT =
  '<svg class="icon icon--next" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 5v14l8-7zM16 5h2v14h-2z"/></svg>';
const ICON_SHARE =
  '<svg class="icon icon--share" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 15V4m0 0L8 8m4-4 4 4M5 13v6h14v-6"/></svg>';

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

async function refresh() {
  try {
    const res = await fetch(`${API_BASE}/now.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    stations = (data.stations || []).map((s) => {
      if (s.streamURL && s.streamURL.startsWith('/')) s.streamURL = API_BASE + s.streamURL;
      return s;
    });
    // If the active station went offline, stop.
    if (activeId && !stations.some((s) => s.id === activeId)) stop();
    render();
    syncTitle();
  } catch {
    stations = [];
    stop();
    $stations.innerHTML = '<p class="empty">Broadcaster offline.</p>';
  }
}

function render() {
  if (!stations.length) {
    $stations.style.setProperty('--cols', 1);
    $stations.style.setProperty('--rows', 1);
    $stations.style.setProperty('--count', 1);
    $stations.innerHTML = '<p class="empty">No stations broadcasting right now.</p>';
    return;
  }
  const [cols, rows] = gridDims(stations.length);
  $stations.style.setProperty('--cols', cols);
  $stations.style.setProperty('--rows', rows);
  $stations.style.setProperty('--count', stations.length);

  const playing = !$audio.paused && $audio.readyState >= 3;
  // Loading = user asked to play (audio element has src + isn't paused)
  // but data isn't ready yet. Covers initial fetch + mid-stream rebuffer
  // (readyState drops back under 3 and the `waiting` event fires).
  const loading = !!$audio.src && !$audio.paused && $audio.readyState < 3;

  $stations.innerHTML = stations.map((s) => {
    const active = activeId === s.id;
    const isPlaying = active && playing;
    const isLoading = active && loading;
    const shown = displayTrack(s);
    const t = shown.track;
    const now = isLoading
      ? `<span class="status">Connecting…</span>`
      : t
        ? `<b class="title">${escapeHtml(t.title)}</b><span class="artist">${escapeHtml(t.artist)}</span>`
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
    const ownerActions = ownerKey()
      ? `<button type="button" class="act act--like${liked ? ' liked' : ''}"
          aria-label="${liked ? 'Saved to library' : 'Save to library'}" ${disabled}>
          ${liked ? ICON_HEART_FILLED : ICON_HEART}
        </button>
        <button type="button" class="act act--skip"
          aria-label="Dislike and skip this track" ${disabled}>
          ${ICON_THUMBSDOWN}
        </button>
        <button type="button" class="act act--next"
          aria-label="Next track" ${disabled}>
          ${ICON_NEXT}
        </button>`
      : '';
    // Share shows on every card with a track — guests can pass along
    // what a channel is playing without tuning in. Owner controls stay
    // on the active card: you only judge what you're hearing.
    const actions = t
      ? `<span class="actions">
          ${active ? ownerActions : ''}
          <button type="button" class="act act--share" aria-label="Share this track">
            ${ICON_SHARE}
          </button>
          ${note
            ? `<span class="note" role="status">${escapeHtml(note)}</span>`
            : (active && s.listeners > 1
              ? `<span class="note" title="Skips and next affect every listener">${s.listeners} listening</span>`
              : '')}
        </span>`
      : '';
    return `
      <div role="button" tabindex="0"
        class="${classes}"
        data-id="${escapeHtml(s.id)}"
        data-url="${escapeHtml(s.streamURL || '')}"
        aria-pressed="${active}"
        aria-busy="${isLoading}">
        <div class="head">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">${escapeHtml(s.name)}</span>
        </div>
        <div class="now">${now}</div>
        <div class="foot">
          ${actions}
          <span class="transport">${ICON_LOADING}${ICON_PLAY}${ICON_PAUSE}</span>
        </div>
      </div>`;
  }).join('');
}

$stations.addEventListener('click', (e) => {
  const card = e.target.closest('.station');
  if (!card) return;
  const act = e.target.closest('.act');
  if (act) {
    if (act.classList.contains('act--share')) {
      shareTrack(card.dataset.id);
      return;
    }
    const kind = act.classList.contains('act--like') ? 'like'
      : act.classList.contains('act--next') ? 'next'
      : 'skip';
    sendAction(card.dataset.id, kind);
    return;
  }
  toggle(card.dataset.id, card.dataset.url);
});

// div[role=button] doesn't get click-on-Enter/Space for free the way a
// real <button> did — restore it so the cards stay keyboard-operable.
$stations.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.station');
  if (!card || e.target.closest('.act')) return;
  e.preventDefault();
  toggle(card.dataset.id, card.dataset.url);
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

// POST ♥ / 👎 / ⏭ for the station's current track. The body wants the
// station's UUID (`id` from /now.json), not the slug. ♥ saves and fills
// until the track changes; 👎 dislikes AND advances (taste blacklist);
// ⏭ advances with no judgement recorded. Timeboxed: a hung request must
// un-busy the button, not dim it forever.
async function sendAction(id, kind) {
  if (actionBusy.has(id)) return;
  actionBusy.add(id);
  render();
  try {
    const res = await fetch(`${API_BASE}/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: id, token: ownerKey() }),
      signal: timeoutSignal(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) {
      // Stored key no longer valid (rotated server-side) — drop it so
      // the buttons hide instead of failing forever.
      try { localStorage.removeItem('ratbat_key'); } catch {}
      showNote(id, 'Owner key expired — re-open with #key=…');
      actionBusy.delete(id);
      render();
      return;
    }
    if (kind === 'like') {
      // 'saved' = downloaded into the library; 'noted' = already owned,
      // affinity recorded ("♥ always means more like this" — the
      // download is just a side effect when the track isn't yours yet).
      if (res.ok && (data.status === 'saved' || data.status === 'noted')) {
        const s = stations.find((x) => x.id === id);
        const key = trackKey(s);
        if (key) likedKeys.add(key);
        showNote(id, data.status === 'noted' ? 'More like this ♥' : 'Saved to library ♥');
      } else if (res.status === 409) {
        // Pre-affinity servers refuse owned tracks — keep their message
        // sensible until the Mini catches up.
        showNote(id, 'Already in your library');
      } else {
        showNote(id, briefMessage(data.message, 'Couldn’t save'));
      }
    } else if (!res.ok) {
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
    if ($audio.paused) { try { await $audio.play(); } catch {} }
    else $audio.pause();
    render();
    return;
  }
  activeId = id;
  $audio.src = url;
  try { await $audio.play(); } catch { /* autoplay policy — user will retap */ }
  render();
  syncTitle();
}

function stop() {
  activeId = null;
  $audio.pause();
  $audio.removeAttribute('src');
  $audio.load();
}

// Share what's being HEARD (the display-lagged track), not the server's
// current. Native share sheet where available, clipboard elsewhere.
// Links are search URLs built from artist+title — always constructible;
// real provenance links come when the server exposes them.
async function shareTrack(id) {
  const s = stations.find((x) => x.id === id);
  if (!s) return;
  const t = (displayState.get(id) || {}).shownTrack || s.currentTrack;
  if (!t) return;
  const label = `${t.artist} — ${t.title}`;
  const q = encodeURIComponent(label);
  const text = `${label}\nhttps://bandcamp.com/search?q=${q}\nheard on https://${window.location.host}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: label, text });
    } else {
      await navigator.clipboard.writeText(text);
      showNote(id, 'Copied to clipboard');
    }
  } catch { /* user cancelled the sheet — not an error */ }
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

// Poll faster when nothing is live so new broadcasts appear quickly;
// back off once stations are up (keeps now-playing fresh without hammering).
const POLL_FAST = 1500;
const POLL_SLOW = 3000;
let pollTimer = null;

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = stations.length ? POLL_SLOW : POLL_FAST;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh().then(schedulePoll);
