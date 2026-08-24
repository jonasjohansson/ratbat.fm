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

async function loadHistory(more) {
  if (loading) return;
  if (!more) { rows = []; offset = 0; done = false; }
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

// One list, newest first, and every row says where it came from.
//
// The heart and the two links share ONE cell rather than taking a column
// each: the row is a four-column grid, and a track with both `source`
// and `yt` was a fifth child, which the grid put on a line of its own
// underneath — a stray "yt" hanging below every row. There
// is no station picker: the log's whole job is "what has this radio
// played", and a filter turned that into a question you had to answer
// before you got an answer. `station` is the display name at play time
// and null once the station has been deleted — the row still says so
// rather than going quiet about its origin.
function render() {
  if (!$history) return;
  const list = rows.map((r) => `
    <li>
      <span class="htime">${escapeHtml(fmtTime(r.playedAt))}</span>
      <span class="hstation">${escapeHtml(r.station || '(deleted station)')}</span>
      <span class="htrack">${escapeHtml(r.artist)} — ${escapeHtml(r.title)}</span>
      <span class="hmeta">
        ${r.saved ? '<span class="hsaved" title="In your library">♥</span>' : ''}
        ${r.sourceURL ? `<a class="tlink" href="${escapeHtml(r.sourceURL)}" target="_blank" rel="noopener">source</a>` : ''}
        ${r.youtubeURL ? `<a class="tlink" href="${escapeHtml(r.youtubeURL)}" target="_blank" rel="noopener">yt</a>` : ''}
      </span>
    </li>`).join('');
  const empty = loading ? 'Loading…' : 'Nothing played yet.';
  const more = !done && rows.length
    ? `<button type="button" class="btn h-more" ${loading ? 'disabled' : ''}>More</button>`
    : '';
  $history.innerHTML = `
    <ul class="hlist">${list || `<li class="hempty">${empty}</li>`}</ul>
    ${more}`;
}

if ($history) {
  $history.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('h-more')) return void loadHistory(true);
  });
  loadHistory(false);
}
