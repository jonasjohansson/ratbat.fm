// Ratbat web player — responsive card grid.
// Each live station is one card. Click a card to play it. The sticky
// footer shows what's playing + native <audio> controls.

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
const $player = document.getElementById('player');
const $audio = document.getElementById('audio');
const $title = document.getElementById('track-title');
const $artist = document.getElementById('track-artist');
const $stationName = document.getElementById('active-station-name');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

async function refresh() {
  try {
    const res = await fetch(`${API_BASE}/now.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    stations = (data.stations || []).map((s) => {
      if (s.streamURL && s.streamURL.startsWith('/')) s.streamURL = API_BASE + s.streamURL;
      return s;
    });
    render();
    syncPlayer();
  } catch {
    stations = [];
    activeId = null;
    $stations.innerHTML = '<p class="empty">Broadcaster offline.</p>';
    $player.hidden = true;
  }
}

function render() {
  if (!stations.length) {
    $stations.innerHTML = '<p class="empty">No stations broadcasting right now.</p>';
    return;
  }
  $stations.innerHTML = stations.map((s) => {
    const active = activeId === s.id;
    const t = s.currentTrack;
    const np = t
      ? `<b>${escapeHtml(t.title)}</b> — ${escapeHtml(t.artist)}`
      : 'Live';
    return `
      <button type="button" class="station${active ? ' active' : ''}"
        data-id="${escapeHtml(s.id)}"
        data-url="${escapeHtml(s.streamURL || '')}"
        data-name="${escapeHtml(s.name)}"
        aria-pressed="${active}">
        <div class="row">
          <span class="dot" aria-hidden="true"></span>
          <span class="name">${escapeHtml(s.name)}</span>
        </div>
        <div class="np">${np}</div>
      </button>`;
  }).join('');
}

// Event delegation — one listener survives re-renders.
$stations.addEventListener('click', (e) => {
  const card = e.target.closest('.station');
  if (!card) return;
  select(card.dataset.id, card.dataset.url, card.dataset.name);
});

function select(id, url, name) {
  activeId = id;
  $stationName.textContent = name;
  $audio.src = url;
  $audio.play().catch(() => { /* autoplay policy — user can hit play */ });
  $player.hidden = false;
  syncPlayer();
  render();
}

function syncPlayer() {
  if (!activeId) {
    document.title = 'Ratbat';
    return;
  }
  const s = stations.find((x) => x.id === activeId);
  if (!s) {
    $title.textContent = '—';
    $artist.textContent = 'Station went offline';
    document.title = 'Ratbat';
    return;
  }
  const t = s.currentTrack;
  if (t) {
    $title.textContent = t.title;
    $artist.textContent = t.artist;
    document.title = `${t.artist} — ${t.title} · Ratbat`;
  } else {
    $title.textContent = 'Live';
    $artist.textContent = s.name;
    document.title = `${s.name} · Ratbat`;
  }
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
