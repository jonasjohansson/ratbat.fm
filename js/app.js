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
const ICON_BOOST =
  '<svg class="icon icon--boost" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 13l6-6 6 6M6 19l6-6 6 6"/></svg>';
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
    $stations.innerHTML = '<p class="empty">Broadcaster offline.</p>';
  }
}

const ORIGIN_LABELS = { nts: 'NTS', lastFM: 'Last.fm', bandcamp: 'Bandcamp', library: 'Library' };

function render() {
  // Keep the lock in step with the stored passcode from one place: a 403
  // can drop the key mid-session, and the icon must not keep claiming
  // owner mode after the buttons have gone.
  syncLock();
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
    // Meta stays text-only by design — `artworkURL` is deliberately
    // ignored. Album and progress are quiet second-order lines; the
    // progress span's text is re-patched every second by the tick above.
    const progress = active && t ? progressText(s.id) : '';
    const now = isLoading
      ? `<span class="status">Connecting…</span>`
      : t
        ? `<b class="title">${escapeHtml(t.title)}</b><span class="artist">${escapeHtml(t.artist)}</span>`
          + (t.album ? `<span class="album">${escapeHtml(t.album)}</span>` : '')
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
    const ownerActions = ownerKey()
      ? `<button type="button" class="act act--like${liked ? ' liked' : ''}"
          aria-label="${liked ? 'Un-save (remove from library)' : 'Save to library'}" ${disabled}>
          ${liked ? ICON_HEART_FILLED : ICON_HEART}
        </button>
        <button type="button" class="act act--boost"
          aria-label="More like this — steer the station" ${disabled}>
          ${ICON_BOOST}
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
            ? `<button type="button" class="act act--retro" data-entry="${escapeHtml(r.entryID)}" aria-label="Save ${escapeHtml(r.title)}">${ICON_HEART}</button>`
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
    const nowLinks = active && t && (origin || t.sourceURL || t.youtubeURL)
      ? `<span class="nowlinks">${origin}${links(t)}</span>`
      : '';
    // ✎ opens the station editor — never inline UI on the card. The
    // grid stays a radio; management lives in the panel, and the button
    // only exists once the server advertises the CRUD capability.
    const editBtn = ownerKey() && capabilities.includes('stations')
      ? `<button type="button" class="act act--edit" aria-label="Edit ${escapeHtml(s.name)}">✎</button>`
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
          ${editBtn}
        </div>
        <div class="now">${now}${nowLinks}</div>
        ${timeline}
        <div class="foot">
          ${actions}
          <span class="transport">${ICON_LOADING}${ICON_PLAY}${ICON_PAUSE}</span>
        </div>
      </div>`;
  }).join('');
}

$stations.addEventListener('click', (e) => {
  // Provenance links navigate; they must not toggle playback.
  if (e.target.closest('a')) return;
  const card = e.target.closest('.station');
  if (!card) return;
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
    // Owner surfaces re-fetch their token-gated routes on the same
    // nudge — the hook lives in panels.js and is guarded (load order).
    if (typeof onStationsChanged === 'function') onStationsChanged();
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
    $lock.setAttribute('aria-label', on ? 'Owner mode on — tap to log out' : 'Owner login');
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

refresh().then(() => {
  connectEvents();
  schedulePoll();
});
validateStoredKey();
probeHealth();
