// Ratbat panels — everything that is NOT the station grid: the bottom
// panel bar with its health strip, the panel sheet above it, the station
// editor, the selection-policy controls, the taste and why-this-track
// transparency panels, and the play history (relocated from app.js).
//
// Load order matters and is deliberate: app.js runs first (both scripts
// are `defer`), and classic scripts share one global lexical scope, so
// this file reads app.js's top-level bindings (apiPost, ownerKey,
// escapeHtml, capabilities, …) directly — no bundler, no window.
// plumbing. The reverse direction is guarded: app.js calls the
// onOwnerChange / onHealthChange / onStationsChanged hooks below through
// `typeof` checks, because render() can fire from an early fetch before
// this file has evaluated.
//
// Everything here renders into #panelbar / #panel / #dlg — siblings of
// the #stations grid. render() re-renders the grid destructively every
// few seconds, so no form state may ever live inside it; panels own
// their DOM the way the old #history bar did.

const $panelbar = document.getElementById('panelbar');
const $panel = document.getElementById('panel');
const $dlg = document.getElementById('dlg');

const KIND_LABELS = {
  nts: 'NTS', lastFM: 'Last.fm', bandcamp: 'Bandcamp',
  playlist: 'Playlist', libraryRadio: 'Library Radio',
};
const POPULARITY_LABELS = { hits: 'Hits', middle: 'Middle', deepCuts: 'Deep cuts' };
const SORT_LABELS = { date: 'Newest', pop: 'Popular' };

// Region names are localized in the browser — the wire carries bare ISO
// codes (the server serves Locale.Region.isoRegions) and
// Intl.DisplayNames turns "JP" into "Japan" in the viewer's own
// language. Fallback to the raw code where the API is missing.
const regionName = (() => {
  try {
    const dn = new Intl.DisplayNames(undefined, { type: 'region' });
    return (code) => { try { return dn.of(code) || code; } catch { return code; } };
  } catch { return (code) => code; }
})();

// --- Panel framework --------------------------------------------------

let activePanel = null;

// Registry — each panel owns its render function and its state, exactly
// the #history pattern generalized. `visible` gates the bar button AND
// openPanel: owner panels exist only while a key is stored and the
// server advertises the capability, so against an old server the bar
// shows exactly what it showed before this file existed.
const PANELS = {
  history: {
    label: 'Play history',
    visible: () => true,
    load: () => loadHistory(false),
    render: () => renderHistoryPanel(),
  },
  stations: {
    label: 'Stations',
    visible: () => !!ownerKey() && capabilities.includes('stations'),
    // Policy rides along: the Selection section lives at the bottom of
    // this panel, so its /policy/get lands on the same open.
    load: () => Promise.all([loadOwnerStations(), loadPolicy()]),
    render: () => renderStationsPanel(),
  },
  taste: {
    label: 'Taste',
    visible: () => !!ownerKey() && capabilities.includes('taste'),
    load: () => loadTaste(),
    render: () => renderTastePanel(),
  },
  why: {
    label: 'Why this track',
    visible: () => !!ownerKey() && capabilities.includes('exclusions'),
    load: () => loadWhy(),
    render: () => renderWhyPanel(),
  },
};

function renderPanelBar() {
  if (!$panelbar) return;
  // A panel whose gate closed while open (logout, capability rollback
  // on reconnect) must not stay on screen showing owner UI.
  if (activePanel && !PANELS[activePanel].visible()) closePanel();
  const buttons = Object.keys(PANELS)
    .filter((name) => PANELS[name].visible())
    .map((name) =>
      `<button type="button" class="pbtn${activePanel === name ? ' on' : ''}"
        data-panel="${name}">${escapeHtml(PANELS[name].label)}</button>`)
    .join('');
  $panelbar.innerHTML = `${healthStripHTML()}<span class="pbtns">${buttons}</span>`;
}

async function openPanel(name) {
  const p = PANELS[name];
  if (!p || !p.visible()) return;
  activePanel = name;
  if ($panel) { $panel.hidden = false; $panel.classList.add('open'); }
  renderPanelBar();
  p.render();      // paint what we have — the loader repaints when data lands
  await p.load();
  if (activePanel === name) p.render();
}

function closePanel() {
  activePanel = null;
  editor = null;   // a half-edited form must not lurk behind a closed sheet
  if ($panel) {
    $panel.hidden = true;
    $panel.classList.remove('open');
    $panel.innerHTML = '';
  }
  renderPanelBar();
}

const panelChrome = (title, body) => `
  <div class="phead">
    <h2>${escapeHtml(title)}</h2>
    <button type="button" class="p-close" aria-label="Close panel">×</button>
  </div>
  ${body}`;

// --- Health strip -----------------------------------------------------

// One muted line of broadcaster health on the bar's left edge. /health
// is public and doubles as the capability anchor; old servers 404 it
// and the strip simply is not there.
function fmtSpan(secs) {
  // "3d 4h", "4h 12m", "12m" — the strip is a glance, not a clock.
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return '<1m';
}

function healthStripHTML() {
  if (!serverHealth || !capabilities.includes('health')) return '';
  const h = serverHealth;
  const live = h.broadcastingCount || 0;
  let line = live > 0
    ? `● on air · ${fmtSpan(h.uptimeSeconds)} · ${live} live`
    : `○ off air · up ${fmtSpan(h.uptimeSeconds)}`;
  // The server already trims each station to its single most recent gap
  // (24h window) — surface the newest one across stations.
  let gap = null;
  (h.stations || []).forEach((s) => {
    if (s.lastGap && (!gap || s.lastGap.end > gap.end)) gap = s.lastGap;
  });
  if (gap) line += ` · gap ${fmtSpan(gap.end - gap.start)} at ${fmtTime(gap.start)}`;
  return `<span class="health" title="Broadcaster health">${escapeHtml(line)}</span>`;
}

// --- Vocab ------------------------------------------------------------

// /vocab is the single source for tags/enums so these forms never
// duplicate Swift constants. Public and cacheable — one fetch per page
// life is plenty; a failure clears the promise so the next editor open
// retries. The editor renders without it (free-text tags still work),
// palette chips just appear when it lands.
let vocab = null;
let vocabPromise = null;
function loadVocab() {
  if (vocab) return Promise.resolve(vocab);
  if (!vocabPromise) {
    vocabPromise = fetch(`${API_BASE}/vocab`, { signal: timeoutSignal(8000) })
      .then((res) => (res.ok ? res.json() : null))
      .then((v) => { vocab = v; return v; })
      .catch(() => { vocabPromise = null; return null; });
  }
  return vocabPromise;
}

// --- Stations panel ---------------------------------------------------

let ownerStations = [];
let ownerStationsError = null;
// Stations with a start/stop/delete in flight — blocks double-fire,
// same idiom as actionBusy on the grid.
const stationBusy = new Set();
let panelNote = null;

function showPanelNote(text) {
  panelNote = text;
  if (activePanel === 'stations') renderStationsPanel();
  setTimeout(() => {
    if (panelNote === text) {
      panelNote = null;
      if (activePanel === 'stations') renderStationsPanel();
    }
  }, 4000);
}

async function loadOwnerStations() {
  if (!ownerKey()) return;
  try {
    const { ok, status, data } = await apiPost('/stations/list', { token: ownerKey() });
    if (ok) {
      ownerStations = data.stations || [];
      ownerStationsError = null;
    } else if (status === 503) {
      // 503 means the server HAS the route but no catalogue right now
      // (no music folder). Show that — hiding the panel would read as
      // "feature gone" when it's "library unavailable".
      ownerStationsError = briefMessage(data.message, 'catalogue unavailable');
    } else {
      // 403 already dropped the key inside apiPost; the visibility gate
      // then closes the panel via onOwnerChange, so this line is for
      // the other refusals.
      ownerStationsError = friendlyError(status, data);
    }
  } catch {
    ownerStationsError = 'Couldn’t reach the broadcaster';
  }
  if (activePanel === 'stations') renderStationsPanel();
}

function stationRowHTML(s) {
  const busy = stationBusy.has(s.id) ? 'disabled' : '';
  // Playlist stations are desktop-managed (settled decision): the wire
  // projects them to name + trackCount only, so the row offers
  // start/stop/auto-start but no Edit or Delete.
  const editable = s.kind !== 'playlist';
  return `
    <li class="row" data-id="${escapeHtml(s.id)}">
      <span class="dot${s.broadcasting ? '' : ' off'}" aria-hidden="true"></span>
      <span class="rname">${escapeHtml(s.name)}</span>
      <span class="badge">${escapeHtml(KIND_LABELS[s.kind] || s.kind)}</span>
      ${s.kind === 'playlist' && s.trackCount != null
        ? `<span class="rmeta">${s.trackCount} tracks</span>` : ''}
      <span class="rspacer"></span>
      <label class="check rauto" title="Start this station when the broadcaster launches">
        <input type="checkbox" class="s-auto"${s.autoStart ? ' checked' : ''} ${busy}> auto
      </label>
      <button type="button" class="btn s-startstop" ${busy}>${s.broadcasting ? 'Stop' : 'Start'}</button>
      ${editable ? `
      <button type="button" class="btn s-edit" ${busy}>Edit</button>
      <button type="button" class="btn btn--danger s-delete" ${busy}>Delete</button>` : ''}
    </li>`;
}

function renderStationsPanel() {
  if (!$panel || activePanel !== 'stations') return;
  let body;
  if (editor) {
    body = editorHTML(editor);
  } else {
    const rows = ownerStations.map(stationRowHTML).join('');
    body = `
      ${panelNote ? `<p class="pnote" role="status">${escapeHtml(panelNote)}</p>` : ''}
      ${ownerStationsError ? `<p class="ferror" role="alert">${escapeHtml(ownerStationsError)}</p>` : ''}
      <button type="button" class="btn s-new">＋ New station</button>
      <ul class="plist">${rows || (ownerStationsError ? '' : '<li class="hempty">No stations yet.</li>')}</ul>
      ${policySectionHTML()}`;
  }
  $panel.innerHTML = panelChrome('Stations', body);
}

async function startStopStation(id) {
  const s = ownerStations.find((x) => x.id === id);
  if (!s || stationBusy.has(id)) return;
  const starting = !s.broadcasting;
  stationBusy.add(id);
  // Optimistic: the dot flips now; the response and the SSE `stations`
  // nudge reconcile a lie.
  s.broadcasting = starting;
  renderStationsPanel();
  try {
    const { ok, status, data } = await apiPost(
      `/stations/${starting ? 'start' : 'stop'}`, { token: ownerKey(), station: id });
    if (!ok) {
      s.broadcasting = !starting;
      showPanelNote(friendlyError(status, data));
    }
  } catch {
    s.broadcasting = !starting;
    showPanelNote('Couldn’t reach the broadcaster');
  }
  stationBusy.delete(id);
  renderStationsPanel();
  loadOwnerStations();
}

async function toggleAutostart(id) {
  const s = ownerStations.find((x) => x.id === id);
  if (!s) return;
  const enabled = !s.autoStart;
  s.autoStart = enabled;
  renderStationsPanel();
  try {
    const { ok, status, data } = await apiPost('/stations/autostart',
      { token: ownerKey(), station: id, enabled });
    if (!ok) {
      s.autoStart = !enabled;
      showPanelNote(friendlyError(status, data));
    }
  } catch {
    s.autoStart = !enabled;
    showPanelNote('Couldn’t reach the broadcaster');
  }
  renderStationsPanel();
}

// --- Selection policy (W4) --------------------------------------------

// Global, all stations (settled scope). The wire is careful about one
// thing above all: on /policy/set, a key that is ABSENT means "leave
// alone" and an EXPLICIT null means "dial off" — null ≠ 0, which is an
// active reorder. So every set sends exactly the keys the interaction
// changed and nothing else; the -1 sentinel stays server-internal.
//
// mixSetMinimumDuration is deliberately control-free (it has no
// persistence server-side): /policy/get reports it and the copy renders
// it read-only.
let policy = null;        // {newMusicShare, excludeMixSets, mixSetMinimumDuration}
let policyError = null;
// Where the dial re-arms when the checkbox comes back on — the last
// non-null share we saw, so off→on restores rather than resets.
let policyShareMemory = 0.3;

function adoptPolicy(data) {
  policy = {
    newMusicShare: data.newMusicShare ?? null,
    excludeMixSets: !!data.excludeMixSets,
    mixSetMinimumDuration: data.mixSetMinimumDuration ?? null,
  };
  if (policy.newMusicShare != null) policyShareMemory = policy.newMusicShare;
}

async function loadPolicy() {
  if (!ownerKey() || !capabilities.includes('policy')) return;
  try {
    const { ok, status, data } = await apiPost('/policy/get', { token: ownerKey() });
    if (ok) {
      adoptPolicy(data);
      policyError = null;
    } else {
      policyError = friendlyError(status, data);
    }
  } catch {
    policyError = 'Couldn’t reach the broadcaster';
  }
  if (activePanel === 'stations') renderStationsPanel();
}

// Optimistic set with reconcile: patch locally, POST only the changed
// keys, adopt the server's authoritative echo on 2xx, revert on refusal.
async function setPolicy(patch) {
  if (!policy) return;
  const prev = { ...policy };
  Object.assign(policy, patch);
  if (policy.newMusicShare != null) policyShareMemory = policy.newMusicShare;
  renderStationsPanel();
  try {
    // Object spread keeps patch's explicit nulls; keys not in patch are
    // genuinely absent from the JSON — the absent-vs-null distinction
    // the server decodes with a double optional.
    const { ok, status, data } = await apiPost('/policy/set', { token: ownerKey(), ...patch });
    if (ok) adoptPolicy(data);
    else {
      policy = prev;
      showPanelNote(friendlyError(status, data));
    }
  } catch {
    policy = prev;
    showPanelNote('Couldn’t reach the broadcaster');
  }
  renderStationsPanel();
}

function policySectionHTML() {
  if (!ownerKey() || !capabilities.includes('policy')) return '';
  let inner;
  if (!policy) {
    inner = policyError
      ? `<p class="ferror" role="alert">${escapeHtml(policyError)}</p>`
      : '<p class="pnote">Loading…</p>';
  } else {
    const on = policy.newMusicShare != null;
    const pct = Math.round((on ? policy.newMusicShare : policyShareMemory) * 100);
    const minDur = policy.mixSetMinimumDuration;
    inner = `
      <div class="field">
        <label class="check"><input type="checkbox" class="pol-share-on"${on ? ' checked' : ''}>
          Prefer a share of new music</label>
        <div class="frow">
          <input type="range" class="pol-share" min="0" max="100" value="${pct}"${on ? '' : ' disabled'}>
          <span class="pol-share-label">${on ? `${pct}%` : 'off'}</span>
        </div>
        <p class="fhint">“New” means an artist not in your library.</p>
      </div>
      <div class="field">
        <label class="check"><input type="checkbox" class="pol-mixsets"${policy.excludeMixSets ? ' checked' : ''}>
          Skip long mix sets</label>
        ${minDur != null
          ? `<p class="fhint">A mix set is anything longer than ${escapeHtml(fmtSpan(minDur))}.</p>` : ''}
      </div>
      <p class="fhint">Applies to every station at its next pool refill — no restart.</p>
      ${policyError ? `<p class="ferror" role="alert">${escapeHtml(policyError)}</p>` : ''}`;
  }
  return `<div class="psec pol"><h3>Selection</h3>${inner}</div>`;
}

// --- Delete (typed-name confirm) -------------------------------------

// Typing the name is the friction that makes the shared passcode an
// acceptable delete credential (settled decision) — enforced here; the
// server only checks the token.
function nameMatches(typed, name) {
  return String(typed).trim().toLowerCase() === String(name ?? '').trim().toLowerCase();
}

function confirmDeleteStation(station) {
  if (!$dlg || typeof $dlg.showModal !== 'function') {
    // No <dialog> support — fall back to the native prompt this flow
    // otherwise replaces.
    const typed = prompt(`Type “${station.name}” to delete this station.`);
    return Promise.resolve(typed != null && nameMatches(typed, station.name));
  }
  return new Promise((resolve) => {
    $dlg.innerHTML = `
      <h2>Delete station</h2>
      <p>Type <b>${escapeHtml(station.name)}</b> to delete this station. This can’t be undone.</p>
      <div class="field"><input type="text" class="d-name" autocomplete="off"></div>
      <div class="frow">
        <button type="button" class="btn d-cancel">Cancel</button>
        <button type="button" class="btn btn--danger d-confirm" disabled>Delete</button>
      </div>`;
    const input = $dlg.querySelector('.d-name');
    const confirmBtn = $dlg.querySelector('.d-confirm');
    const done = (ok) => { $dlg.close(); $dlg.innerHTML = ''; resolve(ok); };
    // The red button only arms once the typed name matches — a
    // mistyped paste can't delete the wrong station.
    input.addEventListener('input', () => {
      confirmBtn.disabled = !nameMatches(input.value, station.name);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) done(true);
    });
    confirmBtn.addEventListener('click', () => done(true));
    $dlg.querySelector('.d-cancel').addEventListener('click', () => done(false));
    // Escape closes the dialog natively — resolve it as a cancel.
    // Resolving an already-settled promise is a no-op, so the stray
    // once-listener from a confirmed run stays harmless.
    $dlg.addEventListener('cancel', () => resolve(false), { once: true });
    $dlg.showModal();
    input.focus();
  });
}

async function deleteStationFlow(id) {
  const s = ownerStations.find((x) => x.id === id);
  if (!s || stationBusy.has(id)) return;
  const confirmed = await confirmDeleteStation(s);
  if (!confirmed) return;
  stationBusy.add(id);
  renderStationsPanel();
  try {
    const { ok, status, data } = await apiPost('/stations/delete',
      { token: ownerKey(), station: id });
    if (ok) {
      // The server stops a broadcasting station before deleting it —
      // no client-side stop dance needed.
      ownerStations = ownerStations.filter((x) => x.id !== id);
      showPanelNote(`Deleted ${s.name}`);
    } else {
      showPanelNote(friendlyError(status, data));
    }
  } catch {
    showPanelNote('Couldn’t reach the broadcaster');
  }
  stationBusy.delete(id);
  renderStationsPanel();
}

// --- Station editor ---------------------------------------------------

let editor = null;

function newEditor(kind) {
  return {
    mode: 'create', kind, name: '', tags: [], tagMatch: 'any',
    yearMin: null, yearMax: null, regions: [], popularity: 'middle',
    exploration: 0.25, sort: 'date', shufflePool: false,
    excludeOwnedLibrary: false, excludedArtists: [],
    broadcasting: false, error: null, saving: false,
  };
}

// The list payload is the same flat shape the editor writes back
// (settled decision M3) — read it straight into form state. Fields the
// form doesn't edit (excludedArtists — 👎 builds that set, not this
// form) are carried so an update round-trips them unchanged.
function editorFrom(s) {
  const q = s.query || {};
  return {
    mode: 'edit', id: s.id, kind: s.kind, name: s.name || '',
    tags: (q.genreTags || []).slice(),
    tagMatch: q.tagMatch || 'any',
    yearMin: q.yearMin ?? null, yearMax: q.yearMax ?? null,
    regions: (q.regions || []).slice(),
    popularity: q.popularity || 'middle',
    exploration: s.exploration ?? 0.25,
    sort: s.sort || 'date',
    shufflePool: !!s.shufflePool,
    excludeOwnedLibrary: !!q.excludeOwnedLibrary,
    excludedArtists: (q.excludedArtists || []).slice(),
    broadcasting: !!s.broadcasting, error: null, saving: false,
  };
}

// The wire bodies are flat — no nested config blob (settled decision).
// `query` is the full FacetedQuery Codable: its Swift decode is
// synthesized with non-optional tagMatch/popularity/excludeOwnedLibrary/
// excludedArtists, so every key is sent every time with explicit nulls —
// the same wire discipline the server's own payloads follow.
function buildQuery(ed) {
  return {
    genreTags: ed.tags.slice(),
    yearMin: ed.yearMin ?? null,
    yearMax: ed.yearMax ?? null,
    regions: ed.regions.slice(),
    tagMatch: ed.tagMatch,
    popularity: ed.popularity,
    excludeOwnedLibrary: !!ed.excludeOwnedLibrary,
    excludedArtists: (ed.excludedArtists || []).slice(),
  };
}

function buildStationBody(ed, applyNow) {
  const body = {
    token: ownerKey(),
    name: ed.name.trim(),
    query: buildQuery(ed),
    shufflePool: !!ed.shufflePool,
  };
  // Kind-scoped knobs are sent only where they mean something — the
  // server rejects exploration on non-Last.fm (wrongKind), so an
  // always-sent null would be an error, not a no-op.
  if (ed.kind === 'lastFM') body.exploration = Number(ed.exploration);
  if (ed.kind === 'bandcamp') body.sort = ed.sort;
  if (ed.mode === 'create') {
    body.kind = ed.kind;
  } else {
    // `station`, not `id` — the envelope name every shipped write route
    // already uses (LikeRequest et al).
    body.station = ed.id;
    body.applyNow = !!applyNow;
  }
  return body;
}

// Mirrors the server's 422 rules so the round trip is for real errors,
// not typos.
function validateEditor(ed) {
  if (!ed.name.trim()) return 'Name the station';
  if (!ed.tags.length) return 'Pick at least one tag';
  if (ed.yearMin != null && ed.yearMax != null && ed.yearMin > ed.yearMax) {
    return 'Year range is inside out';
  }
  return null;
}

function newStationFlow() {
  editor = newEditor((vocab && vocab.kinds && vocab.kinds[0]) || 'nts');
  loadVocab().then(() => {
    if (activePanel === 'stations' && editor) renderStationsPanel();
  });
  renderStationsPanel();
}

function editStationRow(id) {
  const s = ownerStations.find((x) => x.id === id);
  if (!s || s.kind === 'playlist') return;
  editor = editorFrom(s);
  loadVocab().then(() => {
    if (activePanel === 'stations' && editor) renderStationsPanel();
  });
  renderStationsPanel();
}

// Entry point for the grid's per-card ✎ (app.js calls this, guarded).
async function openStationEditorById(id) {
  await openPanel('stations');
  editStationRow(id);
}

async function submitEditor(applyNow) {
  const ed = editor;
  if (!ed || ed.saving) return;
  const err = validateEditor(ed);
  if (err) {
    ed.error = err;
    renderStationsPanel();
    return;
  }
  ed.saving = true;
  ed.error = null;
  renderStationsPanel();
  const path = ed.mode === 'create' ? '/stations/create' : '/stations/update';
  try {
    const { ok, status, data } = await apiPost(path, buildStationBody(ed, applyNow));
    if (ok && data.station) {
      // The response is authoritative — the server may uniquify the
      // name ("(2)") — so adopt it, then re-fetch the list anyway; the
      // optimistic patch just makes the panel honest immediately.
      const s = data.station;
      const i = ownerStations.findIndex((x) => x.id === s.id);
      if (i >= 0) ownerStations[i] = s; else ownerStations.push(s);
      editor = null;
      showPanelNote(ed.mode === 'create'
        ? `Created ${s.name}`
        : (applyNow ? `Saved & restarted ${s.name}` : `Saved ${s.name}`));
      loadOwnerStations();
    } else {
      // 422 carries the server's specific reason ("Last.fm API key not
      // configured") — better than the generic map entry.
      ed.error = status === 422
        ? briefMessage(data.message, 'Check the form')
        : friendlyError(status, data);
    }
  } catch {
    ed.error = 'Couldn’t reach the broadcaster';
  }
  if (editor === ed) {
    ed.saving = false;
    renderStationsPanel();
  }
}

function editorHTML(ed) {
  const kinds = (vocab && vocab.kinds) || ['nts', 'lastFM', 'bandcamp'];
  const palette = (vocab && vocab.tags && vocab.tags[ed.kind]) || [];
  // Palette first, then any selected tags the palette doesn't know —
  // tags outside a palette still round-trip fine, so a station edited
  // on the desktop keeps its custom tags visible here.
  const allTags = palette.concat(ed.tags.filter((t) => !palette.includes(t)));
  const tagChips = allTags.map((t) =>
    `<button type="button" class="chip f-chip${ed.tags.includes(t) ? ' on' : ''}"
      data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('');
  const matches = (vocab && vocab.tagMatch) || ['any', 'all'];
  const seg = matches.map((m) =>
    `<button type="button" class="chip f-tagmatch${ed.tagMatch === m ? ' on' : ''}"
      data-match="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('');
  const regionChips = ed.regions.map((c) =>
    `<button type="button" class="chip on f-region-remove" data-code="${escapeHtml(c)}"
      aria-label="Remove ${escapeHtml(regionName(c))}">${escapeHtml(regionName(c))} ×</button>`).join('');
  const regionCodes = (vocab && vocab.regions) || [];
  const regionOptions = regionCodes
    .filter((c) => !ed.regions.includes(c))
    .map((c) => ({ c, n: regionName(c) }))
    .sort((a, b) => a.n.localeCompare(b.n))
    .map(({ c, n }) => `<option value="${escapeHtml(c)}">${escapeHtml(n)}</option>`)
    .join('');
  const pops = (vocab && vocab.popularity) || ['hits', 'middle', 'deepCuts'];
  const sorts = (vocab && vocab.bandcampSort) || ['date', 'pop'];
  const saving = ed.saving ? 'disabled' : '';
  const pct = Math.round((ed.exploration ?? 0.25) * 100);
  return `
    ${ed.mode === 'create'
      ? `<div class="field"><label>Kind</label><select class="f-kind">
          ${kinds.map((k) =>
            `<option value="${escapeHtml(k)}"${ed.kind === k ? ' selected' : ''}>${escapeHtml(KIND_LABELS[k] || k)}</option>`).join('')}
        </select></div>`
      : `<p class="fkind">${escapeHtml(KIND_LABELS[ed.kind] || ed.kind)} station</p>`}
    <div class="field"><label>Name</label>
      <input type="text" class="f-name" value="${escapeHtml(ed.name)}" autocomplete="off"></div>
    <div class="field"><label>Tags</label>
      <div class="chips">${tagChips}</div>
      <div class="frow">
        <input type="text" class="f-newtag" placeholder="Add a tag…" autocomplete="off">
        <button type="button" class="btn f-addtag">Add</button>
      </div></div>
    <div class="field"><label>Tag match</label><div class="chips">${seg}</div></div>
    <div class="field"><label>Era</label>
      <div class="frow">
        <input type="number" class="f-yearmin" placeholder="any" value="${ed.yearMin ?? ''}">
        <span>–</span>
        <input type="number" class="f-yearmax" placeholder="any" value="${ed.yearMax ?? ''}">
      </div></div>
    ${regionCodes.length || ed.regions.length ? `
    <div class="field"><label>Regions</label>
      <div class="chips">${regionChips}</div>
      ${regionOptions
        ? `<select class="f-region-add"><option value="">Add region…</option>${regionOptions}</select>`
        : ''}
    </div>` : ''}
    ${ed.kind === 'lastFM' ? `
    <div class="field"><label>Popularity</label><select class="f-popularity">
      ${pops.map((p) =>
        `<option value="${escapeHtml(p)}"${ed.popularity === p ? ' selected' : ''}>${escapeHtml(POPULARITY_LABELS[p] || p)}</option>`).join('')}
    </select></div>
    <div class="field"><label>Exploration</label>
      <div class="frow">
        <input type="range" class="f-exploration" min="0" max="100" value="${pct}">
        <span class="f-exploration-label">${pct}%</span>
      </div></div>` : ''}
    ${ed.kind === 'bandcamp' ? `
    <div class="field"><label>Sort</label><select class="f-sort">
      ${sorts.map((v) =>
        `<option value="${escapeHtml(v)}"${ed.sort === v ? ' selected' : ''}>${escapeHtml(SORT_LABELS[v] || v)}</option>`).join('')}
    </select></div>` : ''}
    <div class="field">
      <label class="check"><input type="checkbox" class="f-shuffle"${ed.shufflePool ? ' checked' : ''}> Shuffle the pool</label>
      <label class="check"><input type="checkbox" class="f-excludeowned"${ed.excludeOwnedLibrary ? ' checked' : ''}> Only music I don’t own</label>
    </div>
    ${ed.error ? `<p class="ferror" role="alert">${escapeHtml(ed.error)}</p>` : ''}
    <div class="frow">
      <button type="button" class="btn f-cancel" ${saving}>Cancel</button>
      <button type="button" class="btn btn--primary f-save" ${saving}>${ed.mode === 'create' ? 'Create' : 'Save'}</button>
      ${ed.mode === 'edit' && ed.broadcasting
        ? `<button type="button" class="btn f-saverestart" ${saving}>Save &amp; restart station</button>` : ''}
    </div>
    ${ed.mode === 'edit' && ed.broadcasting
      ? `<p class="fhint">Restart cuts the track that’s playing for every listener.</p>` : ''}`;
}

function toggleTag(tag) {
  if (!editor) return;
  const i = editor.tags.indexOf(tag);
  if (i >= 0) editor.tags.splice(i, 1); else editor.tags.push(tag);
  renderStationsPanel();
}

function addTagFromInput() {
  if (!editor || !$panel || typeof $panel.querySelector !== 'function') return;
  const input = $panel.querySelector('.f-newtag');
  if (!input) return;
  const tag = input.value.trim();
  if (tag && !editor.tags.includes(tag)) editor.tags.push(tag);
  renderStationsPanel();
}

function addRegion(code) {
  if (!editor || editor.regions.includes(code)) return;
  editor.regions.push(code);
  renderStationsPanel();
}

function removeRegion(code) {
  if (!editor) return;
  editor.regions = editor.regions.filter((c) => c !== code);
  renderStationsPanel();
}

// --- Taste panel (W5) -------------------------------------------------

// Text-only transparency: the taste profile's top artists/tags with
// scores as dotted-leader rows (a bar of text, not a chart), then each
// station's signal counts and top affinity artists. Fetched on open,
// never polled — taste moves at the speed of ♥, not of seconds.
let taste = null;
let tasteError = null;

async function loadTaste() {
  try {
    const { ok, status, data } = await apiPost('/taste', { token: ownerKey() });
    if (ok) {
      taste = data;
      tasteError = null;
    } else {
      tasteError = status === 503
        ? briefMessage(data.message, 'catalogue unavailable')
        : friendlyError(status, data);
    }
  } catch {
    tasteError = 'Couldn’t reach the broadcaster';
  }
  if (activePanel === 'taste') renderTastePanel();
}

const scoreRowsHTML = (items, key) => (items || []).map((it) => `
  <li class="srow">
    <span class="sname">${escapeHtml(it[key])}</span>
    <span class="sleader" aria-hidden="true"></span>
    <span class="sscore">${Math.round((it.score || 0) * 100)}%</span>
  </li>`).join('');

function renderTastePanel() {
  if (!$panel || activePanel !== 'taste') return;
  let body;
  if (!taste) {
    body = tasteError
      ? `<p class="ferror" role="alert">${escapeHtml(tasteError)}</p>`
      : '<p class="pnote">Loading…</p>';
  } else {
    const stationRows = (taste.stations || []).map((s) => {
      const c = s.counts || {};
      const lean = (s.topAffinityArtists || []).join(', ');
      return `
      <li class="trow">
        <span class="rname">${escapeHtml(s.name)}</span>
        <span class="rmeta">${c.plays || 0} plays · ${c.saves || 0} saves · ${c.boosts || 0} boosts · ${c.skips || 0} skips</span>
        ${lean ? `<span class="tlean">leaning ${escapeHtml(lean)}</span>` : ''}
      </li>`;
    }).join('');
    body = `
      ${tasteError ? `<p class="ferror" role="alert">${escapeHtml(tasteError)}</p>` : ''}
      <div class="psec"><h3>Top artists</h3>
        <ul class="slist">${scoreRowsHTML(taste.libraryArtists, 'artist')
          || '<li class="hempty">Nothing yet — ♥ some tracks.</li>'}</ul></div>
      <div class="psec"><h3>Top tags</h3>
        <ul class="slist">${scoreRowsHTML(taste.libraryTags, 'tag')
          || '<li class="hempty">Nothing yet.</li>'}</ul></div>
      <div class="psec"><h3>Stations</h3>
        <ul class="slist">${stationRows || '<li class="hempty">No stations.</li>'}</ul></div>`;
  }
  $panel.innerHTML = panelChrome('Taste', body);
}

// --- Why-this-track panel (W5) ----------------------------------------

// The selection filters' audit trail: HistoryStore's exclusion rows,
// each rendered as one human sentence. enforced:false rows are the
// mix-set filter's shadow log — "would remove", logged but let through,
// exactly the preview the toggle's ship-dark design intended; the label
// flips to "removed" once the filter is on.
let exclRows = [];
let exclStationFilter = null; // stationID (UUID string), null = all stations
let exclLimit = 100;
let exclDone = false;
let exclLoading = false;
let exclError = null;
// Station IDs seen across fetches this panel session — a filtered fetch
// returns one station's rows, so the chip set must not collapse to it.
const exclStationIDs = new Set();

const EXCL_PAGE = 100;
const EXCL_CAP = 500; // matches the server clamp

// "2h02m" for hour-plus mixes, "62m" below — the sentence reads like a
// person describing a mix, not a duration column.
function fmtMixDur(secs) {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

function exclusionSentence(r) {
  const verb = r.enforced ? 'removed' : 'would remove';
  let detail = '';
  if (r.arm === 'duration' && r.durationSeconds != null) {
    detail = ` (${fmtMixDur(r.durationSeconds)} mix)`;
  } else if (r.matchedText) {
    detail = ` (title matched “${r.matchedText}”)`;
  }
  return `${verb}: ${r.artist} — ${r.title}${detail}`;
}

function stationNameFor(sid) {
  const s = ownerStations.find((x) => x.id === sid);
  return s ? s.name : '(deleted station)';
}

// Panel open: reset filter + paging, and fetch the owner station list
// if the stations panel never loaded it — exclusion rows carry only
// stationIDs, the names for the chips live in /stations/list.
function loadWhy() {
  exclStationFilter = null;
  exclStationIDs.clear();
  if (capabilities.includes('stations') && !ownerStations.length) {
    loadOwnerStations().then(() => {
      if (activePanel === 'why') renderWhyPanel();
    });
  }
  return loadExclusions(true);
}

async function loadExclusions(reset) {
  if (exclLoading) return;
  if (reset) {
    exclRows = [];
    exclLimit = EXCL_PAGE;
    exclDone = false;
    exclError = null;
  }
  exclLoading = true;
  if (activePanel === 'why') renderWhyPanel();
  try {
    // `station` rides as an explicit null when unfiltered — the wire's
    // explicit-nulls discipline, same as the server's own payloads.
    const { ok, status, data } = await apiPost('/exclusions',
      { token: ownerKey(), station: exclStationFilter, limit: exclLimit });
    if (ok) {
      exclRows = data.exclusions || [];
      exclRows.forEach((r) => { if (r.stationID) exclStationIDs.add(r.stationID); });
      exclDone = exclRows.length < exclLimit || exclLimit >= EXCL_CAP;
      exclError = null;
    } else {
      exclError = status === 503
        ? briefMessage(data.message, 'catalogue unavailable')
        : friendlyError(status, data);
    }
  } catch {
    exclError = 'Couldn’t reach the broadcaster';
  }
  exclLoading = false;
  if (activePanel === 'why') renderWhyPanel();
}

// The chips re-fetch server-side (the wire scopes by station) — unlike
// history, whose filter narrows already-loaded rows client-side.
function setExclusionFilter(sid) {
  exclStationFilter = sid || null;
  loadExclusions(true);
}

// This wire has no offset — "More" widens the limit and re-fetches from
// the top (rows come newest-first and the cap is small), which reads
// like history's paging without pretending the contract pages.
function moreExclusions() {
  if (exclDone || exclLoading) return;
  exclLimit = Math.min(exclLimit + EXCL_PAGE, EXCL_CAP);
  loadExclusions(false);
}

function whyFilterChips() {
  if (exclStationIDs.size < 2) return '';
  const chips = [...exclStationIDs].map((sid) =>
    `<button type="button" class="chip x-filter${exclStationFilter === sid ? ' on' : ''}"
      data-sid="${escapeHtml(sid)}">${escapeHtml(stationNameFor(sid))}</button>`).join('');
  return `<div class="chips hfilters">
    <button type="button" class="chip x-filter${!exclStationFilter ? ' on' : ''}" data-sid="">All</button>
    ${chips}</div>`;
}

function renderWhyPanel() {
  if (!$panel || activePanel !== 'why') return;
  const rows = exclRows.map((r) => `
    <li>
      <span class="htime">${escapeHtml(fmtTime(r.lastExcludedAt))}</span>
      <span class="htrack">${escapeHtml(exclusionSentence(r))}</span>
      ${r.hitCount > 1 ? `<span class="xcount" title="Times this track came up">×${r.hitCount}</span>` : ''}
      ${r.sourceURL ? `<a class="tlink" href="${escapeHtml(r.sourceURL)}" target="_blank" rel="noopener">source</a>` : ''}
    </li>`).join('');
  const empty = exclError ? ''
    : (exclLoading ? '<li class="hempty">Loading…</li>' : '<li class="hempty">Nothing filtered yet.</li>');
  const more = !exclDone && exclRows.length
    ? `<button type="button" class="btn x-more" ${exclLoading ? 'disabled' : ''}>More</button>`
    : '';
  $panel.innerHTML = panelChrome('Why this track', `
    ${exclError ? `<p class="ferror" role="alert">${escapeHtml(exclError)}</p>` : ''}
    <p class="fhint">Tracks the selection filters caught. “would remove” rows are the mix-set filter running in shadow — logged, not enforced.</p>
    ${whyFilterChips()}
    <ul class="hlist">${rows || empty}</ul>
    ${more}`);
}

// --- Play history panel -----------------------------------------------

// The DB-backed log, not the 5-track ring on the cards. Moved here from
// app.js; gains offset paging and a per-station filter over what the
// server already sends (stationID has always been on the wire, ignored
// until now).
let historyRows = [];
let historyOffset = 0;
let historyDone = false;
let historyLoading = false;
let historyFilter = null; // stationID, null = all

const HISTORY_PAGE = 100;

async function loadHistory(more) {
  if (historyLoading) return;
  if (!more) {
    historyRows = [];
    historyOffset = 0;
    historyDone = false;
    historyFilter = null;
  }
  historyLoading = true;
  if (activePanel === 'history') renderHistoryPanel();
  try {
    const res = await fetch(
      `${API_BASE}/history?limit=${HISTORY_PAGE}&offset=${historyOffset}`,
      { cache: 'no-store' });
    const data = await res.json();
    const page = data.entries || [];
    historyRows = historyRows.concat(page);
    historyOffset += page.length;
    // A short page is the end of the log — the server pages by offset
    // (limit capped at 200), so "fewer than asked" means "no more".
    historyDone = page.length < HISTORY_PAGE;
  } catch {
    historyDone = true;
  }
  historyLoading = false;
  if (activePanel === 'history') renderHistoryPanel();
}

function historyFilterChips() {
  // Distinct stations from the loaded rows. `station` is the display
  // name at play time and null once the station is deleted; stationID
  // survives deletion, so the filter keys on the ID and labels with
  // the name. Filtering is client-side over the accumulated rows and
  // survives "More".
  const seen = new Map();
  historyRows.forEach((r) => {
    if (r.stationID && !seen.has(r.stationID)) {
      seen.set(r.stationID, r.station || '(deleted station)');
    }
  });
  if (seen.size < 2) return '';
  const chips = [...seen.entries()].map(([sid, name]) =>
    `<button type="button" class="chip h-filter${historyFilter === sid ? ' on' : ''}"
      data-sid="${escapeHtml(sid)}">${escapeHtml(name)}</button>`).join('');
  return `<div class="chips hfilters">
    <button type="button" class="chip h-filter${!historyFilter ? ' on' : ''}" data-sid="">All</button>
    ${chips}</div>`;
}

function renderHistoryPanel() {
  if (!$panel || activePanel !== 'history') return;
  const rows = historyRows
    .filter((r) => !historyFilter || r.stationID === historyFilter)
    .map((r) => `
    <li>
      <span class="htime">${escapeHtml(fmtTime(r.playedAt))}</span>
      <span class="htrack">${escapeHtml(r.artist)} — ${escapeHtml(r.title)}</span>
      ${r.saved ? '<span class="hsaved" title="In your library">♥</span>' : ''}
      ${r.sourceURL ? `<a class="tlink" href="${escapeHtml(r.sourceURL)}" target="_blank" rel="noopener">source</a>` : ''}
      ${r.youtubeURL ? `<a class="tlink" href="${escapeHtml(r.youtubeURL)}" target="_blank" rel="noopener">yt</a>` : ''}
    </li>`).join('');
  const more = !historyDone && historyRows.length
    ? `<button type="button" class="btn h-more" ${historyLoading ? 'disabled' : ''}>More</button>`
    : '';
  $panel.innerHTML = panelChrome('Play history', `
    ${historyFilterChips()}
    <ul class="hlist">${rows || '<li class="hempty">No history yet.</li>'}</ul>
    ${more}`);
}

// --- Hooks app.js pokes (guarded there with typeof) -------------------

function onOwnerChange() { renderPanelBar(); }

function onHealthChange() { renderPanelBar(); }

// SSE `stations` is a notification, never data — /events is public, so
// owner state re-fetches its token-gated route here instead of trusting
// the event body.
function onStationsChanged() {
  if (activePanel === 'stations' && PANELS.stations.visible()) loadOwnerStations();
}

// --- Wiring -----------------------------------------------------------

function onPanelClick(e) {
  if (e.target.closest('a')) return;
  const btn = e.target.closest('button');
  if (!btn) return;
  const row = btn.closest('.row');
  if (btn.classList.contains('p-close')) return closePanel();
  // History
  if (btn.classList.contains('h-more')) return void loadHistory(true);
  if (btn.classList.contains('h-filter')) {
    historyFilter = btn.dataset.sid || null;
    return renderHistoryPanel();
  }
  // Why-this-track
  if (btn.classList.contains('x-more')) return void moreExclusions();
  if (btn.classList.contains('x-filter')) return void setExclusionFilter(btn.dataset.sid);
  // Stations list
  if (btn.classList.contains('s-new')) return newStationFlow();
  if (btn.classList.contains('s-startstop') && row) return void startStopStation(row.dataset.id);
  if (btn.classList.contains('s-edit') && row) return editStationRow(row.dataset.id);
  if (btn.classList.contains('s-delete') && row) return void deleteStationFlow(row.dataset.id);
  // Editor
  if (btn.classList.contains('f-chip')) return toggleTag(btn.dataset.tag);
  if (btn.classList.contains('f-tagmatch')) {
    if (editor) { editor.tagMatch = btn.dataset.match; renderStationsPanel(); }
    return;
  }
  if (btn.classList.contains('f-region-remove')) return removeRegion(btn.dataset.code);
  if (btn.classList.contains('f-addtag')) return addTagFromInput();
  if (btn.classList.contains('f-cancel')) {
    editor = null;
    return renderStationsPanel();
  }
  if (btn.classList.contains('f-save')) return void submitEditor(false);
  if (btn.classList.contains('f-saverestart')) return void submitEditor(true);
}

// Text fields sync DOM → state without re-rendering (a re-render per
// keystroke would drop focus); structural changes (chips, selects)
// re-render from state.
function onPanelInput(e) {
  const t = e.target;
  // Policy dial: drag patches the % label in place (a re-render would
  // drop the drag); the commit happens on `change`.
  if (t.classList.contains('pol-share')) {
    const label = typeof $panel.querySelector === 'function'
      ? $panel.querySelector('.pol-share-label') : null;
    if (label) label.textContent = `${t.value}%`;
    return;
  }
  if (!editor) return;
  if (t.classList.contains('f-name')) editor.name = t.value;
  if (t.classList.contains('f-yearmin')) editor.yearMin = t.value ? Number(t.value) : null;
  if (t.classList.contains('f-yearmax')) editor.yearMax = t.value ? Number(t.value) : null;
  if (t.classList.contains('f-exploration')) {
    editor.exploration = Number(t.value) / 100;
    // Patch the % label in place — re-rendering would drop the drag.
    const label = typeof $panel.querySelector === 'function'
      ? $panel.querySelector('.f-exploration-label') : null;
    if (label) label.textContent = `${t.value}%`;
  }
}

function onPanelChange(e) {
  const t = e.target;
  const row = t.closest('.row');
  if (t.classList.contains('s-auto') && row) return void toggleAutostart(row.dataset.id);
  // Selection policy — each control sends only its own key, so an
  // untouched dial never rides along on a mix-set toggle (absent =
  // leave alone) and unchecking the dial sends an explicit null (off).
  if (t.classList.contains('pol-share-on')) {
    return void setPolicy({ newMusicShare: t.checked ? policyShareMemory : null });
  }
  if (t.classList.contains('pol-share')) {
    return void setPolicy({ newMusicShare: Number(t.value) / 100 });
  }
  if (t.classList.contains('pol-mixsets')) {
    return void setPolicy({ excludeMixSets: t.checked });
  }
  if (!editor) return;
  if (t.classList.contains('f-kind')) {
    editor.kind = t.value;
    return renderStationsPanel();
  }
  if (t.classList.contains('f-popularity')) editor.popularity = t.value;
  if (t.classList.contains('f-sort')) editor.sort = t.value;
  if (t.classList.contains('f-shuffle')) editor.shufflePool = t.checked;
  if (t.classList.contains('f-excludeowned')) editor.excludeOwnedLibrary = t.checked;
  if (t.classList.contains('f-region-add') && t.value) addRegion(t.value);
}

function onPanelKeydown(e) {
  if (e.key !== 'Enter') return;
  if (e.target.classList && e.target.classList.contains('f-newtag')) {
    e.preventDefault();
    addTagFromInput();
  }
}

if ($panelbar) {
  $panelbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-panel]');
    if (!b) return;
    const name = b.dataset.panel;
    if (activePanel === name) closePanel(); else openPanel(name);
  });
  renderPanelBar();
}

if ($panel) {
  $panel.addEventListener('click', onPanelClick);
  $panel.addEventListener('input', onPanelInput);
  $panel.addEventListener('change', onPanelChange);
  $panel.addEventListener('keydown', onPanelKeydown);
}

document.addEventListener('keydown', (e) => {
  // Escape closes the sheet — unless the dialog is up, whose own Escape
  // handling must not also dismiss the panel behind it.
  if (e.key !== 'Escape' || !activePanel) return;
  if ($dlg && $dlg.open) return;
  closePanel();
});
