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

// Skin picker
const $skinToggle = document.getElementById('skin-toggle');
const $skinPicker = document.getElementById('skin-picker');
const $skinFile = document.getElementById('skin-file');
const $skinUrlInput = document.getElementById('skin-url-input');

$skinToggle?.addEventListener('click', () => {
  const open = $skinPicker.hasAttribute('hidden');
  if (open) $skinPicker.removeAttribute('hidden');
  else $skinPicker.setAttribute('hidden', '');
  $skinToggle.setAttribute('aria-expanded', String(open));
});

$skinPicker?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-skin-url], button[data-skin-reset]');
  if (!btn) return;
  try {
    if (btn.hasAttribute('data-skin-reset')) {
      await window.ratbatSkins.applyAndSave({ kind: 'reset' });
    } else {
      await window.ratbatSkins.applyAndSave({ kind: 'url', url: btn.dataset.skinUrl });
    }
  } catch (err) { console.warn('skin failed:', err); }
});

$skinFile?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try { await window.ratbatSkins.applyAndSave({ kind: 'file', file }); }
  catch (err) { console.warn('skin failed:', err); }
});

$skinUrlInput?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const url = e.target.value.trim();
  if (!url) return;
  try { await window.ratbatSkins.applyAndSave({ kind: 'url', url }); }
  catch (err) { console.warn('skin failed:', err); }
});

window.ratbatSkins.initialLoad();

// Skin-panel controls (prev/play/pause/stop/next). Prev/next cycle stations.
const $skinPanel = document.getElementById('skin-panel');
$skinPanel?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (!btn) return;
  const cmd = btn.dataset.cmd;
  if (cmd === 'play') $audio.play().catch(() => {});
  else if (cmd === 'pause') $audio.pause();
  else if (cmd === 'stop') { $audio.pause(); $audio.currentTime = 0; }
  else if (cmd === 'prev' || cmd === 'next') {
    if (!stations.length) return;
    const idx = stations.findIndex((s) => s.id === activeId);
    const delta = cmd === 'next' ? 1 : -1;
    const nextIdx = (idx + delta + stations.length) % stations.length;
    const s = stations[nextIdx];
    select(s.id, s.streamURL, s.name);
  }
});

// Visualizer — synthesized bars using the active skin's VISCOLOR palette.
// Real FFT is gated by stream CORS, so we always render plausible bars that
// react to play/pause state. Bars use classic Winamp 19×16 geometry.
const $vis = document.getElementById('skin-vis');
let visColors = [];
let visRaf = null;
const visBars = new Array(19).fill(0);

window.addEventListener('ratbat:skin-applied', (e) => {
  visColors = e.detail.viscolors || [];
});

function drawVisualizer(ts) {
  const ctx = $vis.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // Background is color 0 (typically black in viscolor.txt)
  ctx.fillStyle = visColors[0] || '#000';
  ctx.fillRect(0, 0, 76, 16);

  const active = !$audio.paused && $audio.readyState >= 2;
  const t = ts / 1000;
  for (let i = 0; i < 19; i++) {
    // Drive each bar with a mix of sines so adjacent bars differ.
    const target = active
      ? (Math.sin(t * 3 + i * 0.9) * 0.4 + Math.sin(t * 6.3 + i * 0.33) * 0.3 + 0.55) * 16
      : 0;
    // Ease toward target (attack/decay)
    const cur = visBars[i];
    visBars[i] = cur + (target - cur) * (target > cur ? 0.35 : 0.12);
    const h = Math.max(0, Math.min(16, Math.round(visBars[i])));
    for (let y = 0; y < h; y++) {
      // Map y (0 = bottom) to color index 17 (bottom) down to 2 (top).
      const idx = 17 - Math.floor((y / 15) * 15);
      ctx.fillStyle = visColors[idx] || '#0f0';
      ctx.fillRect(i * 4, 16 - y - 1, 3, 1);
    }
  }
  visRaf = requestAnimationFrame(drawVisualizer);
}

if ($vis) {
  $vis.getContext('2d').imageSmoothingEnabled = false;
  visRaf = requestAnimationFrame(drawVisualizer);
}

refresh().then(schedulePoll);
