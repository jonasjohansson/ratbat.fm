// The play log, on its own page.
//
// It lived at the foot of the grid until the grid took a promise it
// could not keep with a scrolling page underneath it: every station
// visible at a glance, no page scroll. A log is the one thing on this
// site that is unbounded by nature, so it moved out to /history rather
// than being the reason the front page scrolls.
//
// Deliberately standalone — it does not load app.js. Nothing here needs
// audio, SSE, the owner passcode or the station grid, and booting all of
// that to render a list would open a stream connection for a page that
// plays nothing. The cost is the three helpers below, copied rather than
// shared, which is the whole of the duplication.

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
const $history = document.getElementById('history');

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Time-of-day for today, date + time for anything older.
const fmtTime = (ts) => {
  const d = new Date(ts * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} `
      + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const HISTORY_PAGE = 100;
let rows = [];
let offset = 0;
let done = false;
let loading = false;
let filter = null;   // stationID, null = all

async function loadHistory(more) {
  if (loading) return;
  if (!more) { rows = []; offset = 0; done = false; filter = null; }
  loading = true;
  render();
  try {
    const res = await fetch(
      `${API_BASE}/history?limit=${HISTORY_PAGE}&offset=${offset}`,
      { cache: 'no-store' });
    const data = await res.json();
    const page = data.entries || [];
    rows = rows.concat(page);
    offset += page.length;
    // A short page is the end of the log — the server pages by offset
    // (limit capped at 200), so "fewer than asked" means "no more".
    done = page.length < HISTORY_PAGE;
  } catch {
    done = true;
  }
  loading = false;
  render();
}

function filterChips() {
  // Distinct stations from the loaded rows. `station` is the display
  // name at play time and null once the station is deleted; stationID
  // survives deletion, so the filter keys on the ID and labels with the
  // name. Filtering is client-side over the accumulated rows and
  // survives "More".
  const seen = new Map();
  rows.forEach((r) => {
    if (r.stationID && !seen.has(r.stationID)) {
      seen.set(r.stationID, r.station || '(deleted station)');
    }
  });
  if (seen.size < 2) return '';
  const chips = [...seen.entries()].map(([sid, name]) =>
    `<button type="button" class="chip h-filter${filter === sid ? ' on' : ''}"
      data-sid="${escapeHtml(sid)}">${escapeHtml(name)}</button>`).join('');
  return `<div class="chips hfilters">
    <button type="button" class="chip h-filter${!filter ? ' on' : ''}" data-sid="">All</button>
    ${chips}</div>`;
}

function render() {
  if (!$history) return;
  const list = rows
    .filter((r) => !filter || r.stationID === filter)
    .map((r) => `
    <li>
      <span class="htime">${escapeHtml(fmtTime(r.playedAt))}</span>
      <span class="htrack">${escapeHtml(r.artist)} — ${escapeHtml(r.title)}</span>
      ${r.saved ? '<span class="hsaved" title="In your library">♥</span>' : ''}
      ${r.sourceURL ? `<a class="tlink" href="${escapeHtml(r.sourceURL)}" target="_blank" rel="noopener">source</a>` : ''}
      ${r.youtubeURL ? `<a class="tlink" href="${escapeHtml(r.youtubeURL)}" target="_blank" rel="noopener">yt</a>` : ''}
    </li>`).join('');
  const empty = loading ? 'Loading…' : 'Nothing played yet.';
  const more = !done && rows.length
    ? `<button type="button" class="btn h-more" ${loading ? 'disabled' : ''}>More</button>`
    : '';
  $history.innerHTML = `
    ${filterChips()}
    <ul class="hlist">${list || `<li class="hempty">${empty}</li>`}</ul>
    ${more}`;
}

if ($history) {
  $history.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('h-more')) return void loadHistory(true);
    if (btn.classList.contains('h-filter')) {
      filter = btn.dataset.sid || null;
      render();
    }
  });
  loadHistory(false);
}
