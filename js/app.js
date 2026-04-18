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

// Real FFT requires the stream to send CORS headers AND crossOrigin set
// *before* src. We probe once per URL with a Range:0-0 GET; if it succeeds
// in cors mode we enable the analyser, otherwise we fall through to synth.
const corsCache = new Map();
async function streamIsCors(url) {
  if (corsCache.has(url)) return corsCache.get(url);
  let ok = false;
  try {
    const res = await fetch(url, { method: 'GET', mode: 'cors', headers: { Range: 'bytes=0-0' } });
    ok = res.ok || res.status === 206;
  } catch { ok = false; }
  corsCache.set(url, ok);
  return ok;
}

let audioCtx = null;
let analyser = null;
let freqBuf = null;
let mediaSrc = null;

function ensureAnalyser() {
  if (analyser) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = new Ctx();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;
  freqBuf = new Uint8Array(analyser.frequencyBinCount);
  mediaSrc = audioCtx.createMediaElementSource($audio);
  mediaSrc.connect(analyser);
  analyser.connect(audioCtx.destination);
}

async function select(id, url, name) {
  activeId = id;
  $stationName.textContent = name;
  const cors = await streamIsCors(url);
  if (cors) {
    // crossOrigin must be set before src to enable analysis.
    $audio.crossOrigin = 'anonymous';
  } else {
    $audio.removeAttribute('crossorigin');
  }
  $audio.src = url;
  try { await $audio.play(); } catch { /* autoplay policy — user can hit play */ }
  if (cors) {
    try {
      ensureAnalyser();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { analyser = null; }
  }
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

// Show the stage (prominent player) whenever a skin is active. Hide otherwise.
const $stage = document.getElementById('stage');
document.body.classList.contains('has-skin-panel') && $stage && ($stage.hidden = false);
window.addEventListener('ratbat:skin-applied', () => {
  if (!$stage) return;
  $stage.hidden = !document.body.classList.contains('has-skin-panel');
  // Canvas reads its box size via clientWidth; size after unhide.
  if (!$stage.hidden) requestAnimationFrame(sizeAllCanvases);
});

// ---- Responsive FFT-style visualizer (stage banner) -----------------------
// Synthesized bars driven by paused state (real FFT requires stream CORS);
// colors pulled live from the active skin's VISCOLOR palette.
const $vis = document.getElementById('stage-vis');
let visColors = [];
let visBars = [];
const BAR_W = 6;   // px per bar (on-screen)
const BAR_GAP = 2; // gap between bars

function sizeVisCanvas() {
  if (!$vis) return;
  const w = Math.max(40, $vis.clientWidth | 0);
  const h = Math.max(40, $vis.clientHeight | 0);
  // Device-pixel-aware, but kept modest so bars stay crisp.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  $vis.width = w * dpr;
  $vis.height = h * dpr;
  const ctx = $vis.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  // Resize the bar array to match.
  const barCount = Math.max(8, Math.floor(w / (BAR_W + BAR_GAP)));
  visBars = new Array(barCount).fill(0);
}

// ---- TEXT.BMP bitmap-font renderer ---------------------------------------
// Winamp classic layout: 31 chars/row × 3 rows, each char 5×6 px.
// Map only what's reliably present in classic skins; unknowns → space.
const CHAR_W = 5, CHAR_H = 6;
const FONT_LOOKUP = (() => {
  const map = {};
  const row0 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ"@';
  const row1 = '0123456789.:()-`!_+\\/[]^&%,=$#';
  for (let i = 0; i < row0.length; i++) map[row0[i]] = [i * CHAR_W, 0];
  for (let i = 0; i < row1.length; i++) map[row1[i]] = [i * CHAR_W, CHAR_H];
  return map;
})();

const $track = document.getElementById('skin-track');
let textImage = null;
let trackString = '';
let trackScroll = 0;

window.addEventListener('ratbat:skin-applied', (e) => {
  visColors = e.detail.viscolors || [];
  textImage = e.detail.textImage || null;
  trackScroll = 0;
});

function currentTrackString() {
  if (!activeId) return 'RATBAT FM';
  const s = stations.find((x) => x.id === activeId);
  if (!s) return 'RATBAT FM';
  const t = s.currentTrack;
  if (t) return `${t.artist} - ${t.title}`.toUpperCase();
  return s.name.toUpperCase();
}

// Size the track canvas so scroll speed stays consistent as the viewport
// changes. The internal resolution is pinned to CSS height so drawImage
// scales each 5x6 glyph sharply via imageSmoothingEnabled=false.
function sizeTrackCanvas() {
  if (!$track) return;
  const cssW = Math.max(120, $track.clientWidth | 0);
  const cssH = Math.max(12, $track.clientHeight | 0);
  // Pick an integer glyph upscale that matches the container height.
  const scale = Math.max(2, Math.floor(cssH / CHAR_H));
  $track.dataset.scale = String(scale);
  // Internal resolution = CSS size (glyphs are drawn at `scale` per native px).
  $track.width = cssW;
  $track.height = scale * CHAR_H;
}

function drawTrackText() {
  if (!$track) return;
  const ctx = $track.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, $track.width, $track.height);
  if (!textImage) return;

  const next = currentTrackString();
  if (next !== trackString) { trackString = next; trackScroll = 0; }

  const scale = Number($track.dataset.scale || 3);
  const glyphW = CHAR_W * scale;
  const glyphH = CHAR_H * scale;
  const text = trackString + '     '; // gap before repeat
  const textPx = text.length * glyphW;
  const viewPx = $track.width;

  const scrollable = textPx > viewPx;
  const offset = scrollable ? Math.floor(trackScroll) % textPx : 0;

  for (let copy = 0; copy < (scrollable ? 2 : 1); copy++) {
    for (let i = 0; i < text.length; i++) {
      const glyph = FONT_LOOKUP[text[i]];
      const x = i * glyphW - offset + copy * textPx;
      if (x + glyphW < 0 || x > viewPx) continue;
      if (!glyph) continue;
      ctx.drawImage(
        textImage,
        glyph[0], glyph[1], CHAR_W, CHAR_H,
        x, 0, glyphW, glyphH,
      );
    }
  }
  if (scrollable) trackScroll += scale * 0.4; // speed proportional to glyph size
}

function drawVisualizer(ts) {
  if ($vis) {
    const ctx = $vis.getContext('2d');
    const w = $vis.clientWidth;
    const h = $vis.clientHeight;
    ctx.fillStyle = visColors[0] || 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, w, h);

    const active = !$audio.paused && $audio.readyState >= 2;
    const t = ts / 1000;
    const n = visBars.length;

    // Prefer real FFT when the AnalyserNode is connected; else synthesize.
    let realFft = null;
    if (analyser && freqBuf && active) {
      analyser.getByteFrequencyData(freqBuf);
      realFft = freqBuf;
    }

    for (let i = 0; i < n; i++) {
      let target;
      if (realFft) {
        // Log-bin from the FFT so low frequencies get multiple bars.
        const lo = Math.floor(Math.pow(i / n, 2.2) * realFft.length);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 2.2) * realFft.length));
        let sum = 0;
        for (let k = lo; k < hi && k < realFft.length; k++) sum += realFft[k];
        target = (sum / Math.max(1, hi - lo)) / 255 * h * 1.4;
      } else {
        target = active
          ? (Math.sin(t * 3 + i * 0.37) * 0.4 + Math.sin(t * 6.3 + i * 0.13) * 0.3 + 0.55) * h
          : 0;
      }
      const cur = visBars[i];
      visBars[i] = cur + (target - cur) * (target > cur ? 0.45 : 0.1);
      const bh = Math.max(0, Math.min(h, visBars[i]));
      const segH = 2;
      const segGap = 1;
      let drawn = 0;
      for (let y = h - segH; drawn < bh && y >= 0; y -= (segH + segGap)) {
        const fractionFromBottom = (h - y) / h;
        const paletteIdx = 17 - Math.floor(fractionFromBottom * 15);
        ctx.fillStyle = visColors[paletteIdx] || '#0f0';
        ctx.fillRect(i * (BAR_W + BAR_GAP), y, BAR_W, segH);
        drawn += segH + segGap;
      }
    }
  }
  drawTrackText();
  requestAnimationFrame(drawVisualizer);
}

function sizeAllCanvases() { sizeVisCanvas(); sizeTrackCanvas(); }
window.addEventListener('resize', sizeAllCanvases);
sizeAllCanvases();
requestAnimationFrame(drawVisualizer);

refresh().then(schedulePoll);
