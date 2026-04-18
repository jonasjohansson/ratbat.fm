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

const $stations = document.getElementById('stations');
const $audio = document.getElementById('audio');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const ICON_PLAY =
  '<svg class="icon icon--play" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5v14l12-7z"/></svg>';
const ICON_PAUSE =
  '<svg class="icon icon--pause" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

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

  const playing = !$audio.paused && $audio.readyState >= 2;
  $stations.innerHTML = stations.map((s) => {
    const active = activeId === s.id;
    const isPlaying = active && playing;
    const t = s.currentTrack;
    const np = t
      ? `<b>${escapeHtml(t.title)}</b> — ${escapeHtml(t.artist)}`
      : 'Live';
    return `
      <button type="button"
        class="station${active ? ' active' : ''}${isPlaying ? ' playing' : ''}"
        data-id="${escapeHtml(s.id)}"
        data-url="${escapeHtml(s.streamURL || '')}"
        aria-pressed="${active}">
        <div class="head">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">${escapeHtml(s.name)}</span>
        </div>
        <div class="foot">
          <div class="np">${np}</div>
          ${ICON_PLAY}${ICON_PAUSE}
        </div>
      </button>`;
  }).join('');
}

$stations.addEventListener('click', (e) => {
  const card = e.target.closest('.station');
  if (!card) return;
  toggle(card.dataset.id, card.dataset.url);
});

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

['play', 'pause', 'playing', 'ended', 'waiting'].forEach((ev) =>
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
