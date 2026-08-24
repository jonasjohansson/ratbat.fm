// Ratbat panels — the app-wide surfaces, plus the station editor's state
// machine. Two different things, deliberately:
//
//   * The two always-on surfaces: the Selection header row (how pools
//     are filled, for EVERY station) and the play-history section under
//     the grid. No bar, no sheet, nothing to open — and nothing
//     per-station lives there.
//   * The station editor — its markup, its state and its writes. It is
//     no longer panel-hosted: app.js paints it INSIDE the station's own
//     card and delegates that card's click/input/change/keydown into the
//     onEditor* handlers at the bottom of this file. Everything about a
//     station belongs on the station.
//
// Load order matters and is deliberate: app.js runs first (both scripts
// are `defer`), and classic scripts share one global lexical scope, so
// this file reads app.js's top-level bindings (apiPost, ownerKey,
// escapeHtml, capabilities, ownerStations, KIND_LABELS, renderGrid, …)
// directly — no bundler, no window. plumbing, and never a second copy of
// a name app.js already owns. The reverse direction is guarded: app.js
// calls the hooks and the onEditor* handlers below through `typeof`
// checks, because render() can fire from an early fetch before this file
// has evaluated.

const $dlg = document.getElementById('dlg');

// Where this radio's music actually comes from — the shortcut at the top
// of the region picker. Ordered by how often they come up here rather
// than alphabetically: an alphabetical shortlist is just a short list.
const COMMON_REGIONS = [
  'SE', 'GB', 'US', 'DE', 'NL', 'FR', 'JP',
  'DK', 'NO', 'FI', 'IT', 'ES', 'BE', 'PL', 'CA', 'AU', 'BR',
];

const POPULARITY_LABELS = { hits: 'Hits', middle: 'Middle', deepCuts: 'Deep cuts' };
const SORT_LABELS = { date: 'Newest', pop: 'Popular' };

// --- Always-on surfaces ----------------------------------------------
//
// There is no panel bar and no sheet any more. Everything that used to
// hide behind a button is simply on the page: the global Selection
// controls as a header row above the grid, the play history as a
// section below it that you scroll to. Nothing to discover, nothing to
// open.

const $topbar = document.getElementById('topbar');
const $historySection = document.getElementById('history');

// The header row: app-wide selection knobs, laid out in one line, owner
// only. Everything per-station lives on its own card, so what is left
// here is exactly what could never belong to one station.
// The row is always on screen, so nothing "opens" to trigger the fetch:
// ask for the policy the first time the owner surface becomes real, and
// again after a login, but never twice for the same state.
let policyRequested = false;
function maybeLoadPolicy() {
  const owns = !!ownerKey() && capabilities.includes('policy');
  if (!owns) { policyRequested = false; policy = null; return; }
  if (policyRequested) return;
  policyRequested = true;
  loadPolicy();
}

function renderTopbar() {
  if (!$topbar) return;
  maybeLoadPolicy();
  // The row belongs to the settings, so it only exists for the owner: a
  // guest's cards already say who is on air. The health dot rides along
  // as a glance, with the detail in its tooltip.
  const owns = !!ownerKey() && capabilities.includes('policy');
  const vol = typeof volumeControlHTML === 'function' ? volumeControlHTML() : '';
  $topbar.hidden = !owns && !vol;
  const note = panelNote
    ? `<span class="tnote" role="status">${escapeHtml(panelNote)}</span>` : '';
  $topbar.innerHTML = `${healthStripHTML()}${vol}${
    owns ? `<span class="pol">${policyRowHTML()}${note}</span>` : ''}`;
}

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
  // Spelled out, not compressed — "12m" alone read as anything, and a
  // bare count read as nothing. "up 12m" and "N station(s) live" cost a
  // word each and stop being cryptic.
  let line = live > 0
    ? `● on air · up ${fmtSpan(h.uptimeSeconds)} · ${live} station${live === 1 ? '' : 's'} live`
    : `○ off air · up ${fmtSpan(h.uptimeSeconds)}`;
  // The server already trims each station to its single most recent gap
  // (24h window) — surface the newest one across stations.
  let gap = null;
  (h.stations || []).forEach((s) => {
    if (s.lastGap && (!gap || s.lastGap.end > gap.end)) gap = s.lastGap;
  });
  if (gap) line += ` · gap ${fmtSpan(gap.end - gap.start)} at ${fmtTime(gap.start)}`;
  // A dot, not a sentence. The row belongs to the settings; whether the
  // broadcaster is up is a glance, and the detail is one hover away.
  return `<span class="health${live > 0 ? '' : ' off'}" title="${escapeHtml(line)}"
    aria-label="${escapeHtml(line)}">${live > 0 ? '●' : '○'}</span>`;
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

// --- Per-station writes ------------------------------------------------
//
// start / stop / auto-start / delete. The roster they act on lives in
// app.js (the grid is the station list); what lives here is the flow —
// optimistic patch, reconcile, and where the answer is shown.

let panelNote = null;

function showPanelNote(text) {
  panelNote = text;
  renderTopbar();
  setTimeout(() => {
    if (panelNote === text) {
      panelNote = null;
      renderTopbar();
    }
  }, 4000);
}

// A station-scoped message goes where the eye already is: into the open
// editor's error line when that card is being edited, otherwise onto the
// card itself as one of the transient notes the grid already does.
function stationNote(id, text) {
  if (editor && editor.id === id) {
    editor.error = text;
    renderEditor();
  } else {
    showNote(id, text);
  }
}

// Repaint after an owner mutation. An open editor owns its own subtree
// and the grid around it is frozen (see render() in app.js); with no
// editor open the grid is free to repaint wholesale.
function repaintStations() {
  if (editor) renderEditor(); else render();
}

async function startStopStation(id) {
  const s = ownerStations.find((x) => x.id === id);
  if (!s || stationBusy.has(id)) return;
  const starting = !s.broadcasting;
  stationBusy.add(id);
  // Optimistic: the card flips now; the response, the SSE `stations`
  // nudge and the next /now.json reconcile a lie.
  setBroadcasting(s, starting);
  repaintStations();
  try {
    const { ok, status, data } = await apiPost(
      `/stations/${starting ? 'start' : 'stop'}`, { token: ownerKey(), station: id });
    if (!ok) {
      setBroadcasting(s, !starting);
      stationNote(id, friendlyError(status, data));
    }
  } catch {
    setBroadcasting(s, !starting);
    stationNote(id, 'Couldn’t reach the broadcaster');
  }
  stationBusy.delete(id);
  repaintStations();
  loadOwnerStations();
}

// The roster row and the open editor hold the same fact twice — the
// editor's copy drives its Start/Stop label — so they flip together.
function setBroadcasting(s, on) {
  s.broadcasting = on;
  if (editor && editor.id === s.id) editor.broadcasting = on;
}

async function toggleAutostart(id) {
  const s = ownerStations.find((x) => x.id === id);
  if (!s) return;
  const enabled = !s.autoStart;
  s.autoStart = enabled;
  if (editor && editor.id === id) editor.autoStart = enabled;
  repaintStations();
  try {
    const { ok, status, data } = await apiPost('/stations/autostart',
      { token: ownerKey(), station: id, enabled });
    if (!ok) {
      s.autoStart = !enabled;
      if (editor && editor.id === id) editor.autoStart = !enabled;
      stationNote(id, friendlyError(status, data));
    }
  } catch {
    s.autoStart = !enabled;
    if (editor && editor.id === id) editor.autoStart = !enabled;
    stationNote(id, 'Couldn’t reach the broadcaster');
  }
  repaintStations();
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
  renderTopbar();
}

// Optimistic set with reconcile: patch locally, POST only the changed
// keys, adopt the server's authoritative echo on 2xx, revert on refusal.
async function setPolicy(patch) {
  if (!policy) return;
  const prev = { ...policy };
  Object.assign(policy, patch);
  if (policy.newMusicShare != null) policyShareMemory = policy.newMusicShare;
  renderTopbar();
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
  renderTopbar();
}

// The panel is titled Selection, so the section inside it isn't — one
// heading, not an echo.
// One row of controls, not a section of fields: the checkbox, its dial,
// the mix-set toggle and whatever the server last said, side by side.
// The explanations ride as tooltips — the row has to stay one line.
function policyRowHTML() {
  if (!policy) {
    return policyError
      ? `<span class="ferror" role="alert">${escapeHtml(policyError)}</span>`
      : '<span class="tnote">Loading selection…</span>';
  }
  const on = policy.newMusicShare != null;
  const pct = Math.round((on ? policy.newMusicShare : policyShareMemory) * 100);
  const minDur = policy.mixSetMinimumDuration;
  return `
    <label class="check" title="“New” means an artist not in your library.">
      <input type="checkbox" class="pol-share-on"${on ? ' checked' : ''}> New music
    </label>
    <input type="range" class="pol-share" min="0" max="100" value="${pct}"${on ? '' : ' disabled'}
      aria-label="Share of new music">
    <span class="pol-share-label">${on ? `${pct}%` : 'off'}</span>
    <label class="check"${minDur != null
      ? ` title="A mix set is anything longer than ${escapeHtml(fmtSpan(minDur))}."` : ''}>
      <input type="checkbox" class="pol-mixsets"${policy.excludeMixSets ? ' checked' : ''}> Skip mix sets
    </label>
    ${policyError ? `<span class="ferror" role="alert">${escapeHtml(policyError)}</span>` : ''}`;
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
  return `<div class="psec pol">${inner}</div>`;
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
  repaintStations();
  try {
    const { ok, status, data } = await apiPost('/stations/delete',
      { token: ownerKey(), station: id });
    if (ok) {
      // The server stops a broadcasting station before deleting it —
      // no client-side stop dance needed. The card leaving the grid is
      // the confirmation; there is no list left to put a note in.
      ownerStations = ownerStations.filter((x) => x.id !== id);
      stationBusy.delete(id);
      if (editor && editor.id === id) closeEditor(); else render();
      loadOwnerStations();
      return;
    }
    stationNote(id, friendlyError(status, data));
  } catch {
    stationNote(id, 'Couldn’t reach the broadcaster');
  }
  stationBusy.delete(id);
  repaintStations();
}

// --- Station editor ---------------------------------------------------
//
// One editor at a time, open inside its own station card. app.js paints
// the card (it owns #stations) and freezes the grid while this is open;
// everything below owns the form's state and repaints ONLY the form's
// own subtree, because the caret and the half-typed name live in there.

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
    broadcasting: !!s.broadcasting, autoStart: !!s.autoStart,
    error: null, saving: false,
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
    // Library radio plays ONLY owned tracks, so excludeOwnedLibrary is
    // meaningless there — the server ignores/normalizes it, and the
    // client sends the normalized value so a kind switched in the
    // picker never smuggles a stale checkbox onto the wire.
    excludeOwnedLibrary: ed.kind === 'libraryRadio' ? false : !!ed.excludeOwnedLibrary,
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
  // always-sent null would be an error, not a no-op. libraryRadio
  // deliberately has neither branch: its whole body is
  // name + query + shufflePool, and exploration/sort stay wrongKind.
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
  // Library radio facets over the OWNED library, where empty tags mean
  // "everything I own" — the primary use. Blocking it client-side would
  // forbid the whole-library station; if the server still 422s, its
  // specific message surfaces through submitEditor.
  if (!ed.tags.length && ed.kind !== 'libraryRadio') return 'Pick at least one tag';
  if (ed.yearMin != null && ed.yearMax != null && ed.yearMin > ed.yearMax) {
    return 'Year range is inside out';
  }
  return null;
}

// --- Opening and closing the inline editor ---------------------------
//
// Opening sets app.js's inlineEditorId (which freezes the grid) and then
// paints ONCE so the form exists inside its card. From that moment
// renderEditor() is the only thing allowed to touch it; closing hands
// the grid back with a full paint.

// Repaint the form's own subtree and nothing else. The card around it
// stays exactly as painted, so the input the owner is typing in is the
// same DOM node it was a moment ago.
function renderEditor() {
  if (!editor) return;
  const host = $stations && typeof $stations.querySelector === 'function'
    ? $stations.querySelector('.editor')
    : null;
  if (host) {
    host.innerHTML = editorHTML(editor);
    return;
  }
  // No host yet — the first paint, or a DOM that can't query. The full
  // paint draws the editor into its card from this same state.
  renderGrid();
}

// Entry point for the grid's per-card ✎ (app.js calls this, guarded).
async function openStationEditorById(id) {
  if (!canManageStations()) return;
  // The ✎ can be on a card the roster hasn't described yet (broadcasting
  // but listed only in /now.json) — there is nothing to edit until it
  // has.
  if (!ownerStations.some((x) => x.id === id)) await loadOwnerStations();
  const s = ownerStations.find((x) => x.id === id);
  if (!s || s.kind === 'playlist') return;
  editor = editorFrom(s);
  inlineEditorId = id;
  renderGrid();
  // The tag palette and region list come from /vocab; the form is usable
  // (free-text tags) before they land and gains the chips when they do.
  loadVocab().then(() => { if (inlineEditorId === id) renderEditor(); });
}

// Entry point for the ghost card (app.js calls this, guarded): a blank
// create form, inline in the empty slot it will fill.
function openNewStationFlow() {
  if (!canManageStations()) return;
  editor = newEditor((vocab && vocab.kinds && vocab.kinds[0]) || 'nts');
  inlineEditorId = NEW_CARD_ID;
  renderGrid();
  loadVocab().then(() => {
    if (inlineEditorId !== NEW_CARD_ID || !editor) return;
    // vocab.kinds is what THIS server can create — re-seed the blank
    // form's kind if the fallback guess isn't on the menu.
    const kinds = (vocab && vocab.kinds) || [];
    if (kinds.length && !kinds.includes(editor.kind)) editor.kind = kinds[0];
    renderEditor();
  });
}

// Cancel, save and delete all land here: the grid has been frozen for as
// long as the form was open, so leaving it repaints everything.
function closeEditor() {
  editor = null;
  inlineEditorId = null;
  render();
}

async function submitEditor(applyNow) {
  const ed = editor;
  if (!ed || ed.saving) return;
  const err = validateEditor(ed);
  if (err) {
    ed.error = err;
    renderEditor();
    return;
  }
  ed.saving = true;
  ed.error = null;
  renderEditor();
  const path = ed.mode === 'create' ? '/stations/create' : '/stations/update';
  try {
    const { ok, status, data } = await apiPost(path, buildStationBody(ed, applyNow));
    if (ok && data.station) {
      // The response is authoritative — the server may uniquify the
      // name ("(2)") — so adopt it, then re-fetch the list anyway; the
      // optimistic patch just makes the grid honest immediately.
      const s = data.station;
      const i = ownerStations.findIndex((x) => x.id === s.id);
      if (i >= 0) ownerStations[i] = s; else ownerStations.push(s);
      closeEditor();
      // The note lands on the station's own card — including a brand new
      // one, which the optimistic patch above just put in the grid.
      showNote(s.id, ed.mode === 'create'
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
    renderEditor();
  }
}

function editorHTML(ed) {
  // vocab.kinds doubles as the capability signal for what THIS server
  // can create — libraryRadio is deliberately absent from the fallback,
  // so a v2 server (or no vocab at all) never offers a kind whose
  // create would 422 as "unknown kind".
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
  // 250-odd countries in one alphabetical list means scrolling past
  // Afghanistan to reach the handful any of these stations ever use.
  // The common ones ride at the top; the full list stays underneath,
  // because "common" is a shortcut, never a limit.
  const opt = (c) => `<option value="${escapeHtml(c)}">${escapeHtml(regionName(c))}</option>`;
  const free = (c) => !ed.regions.includes(c);
  const common = COMMON_REGIONS.filter((c) => regionCodes.includes(c)).filter(free);
  const rest = regionCodes
    .filter((c) => free(c) && !common.includes(c))
    .map((c) => ({ c, n: regionName(c) }))
    .sort((a, b) => a.n.localeCompare(b.n))
    .map(({ c }) => c);
  const regionOptions = [
    common.length ? `<optgroup label="Common">${common.map(opt).join('')}</optgroup>` : '',
    rest.length ? `<optgroup label="All">${rest.map(opt).join('')}</optgroup>` : '',
  ].join('');
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
      : `<p class="fkind field--wide">${escapeHtml(KIND_LABELS[ed.kind] || ed.kind)} station</p>`}
    <div class="field"><label>Name</label>
      <input type="text" class="f-name" value="${escapeHtml(ed.name)}" autocomplete="off"></div>
    <div class="field field--wide"><label>Tags</label>
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
    <div class="field field--wide"><label>Regions</label>
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
    <div class="field field--wide">
      <label class="check"><input type="checkbox" class="f-shuffle"${ed.shufflePool ? ' checked' : ''}> Shuffle the pool</label>
      ${ed.kind === 'libraryRadio'
        // excludeOwnedLibrary is meaningless here (buildQuery sends it
        // normalized to false) — say why the checkbox is gone instead
        // of leaving a silent hole in the form.
        ? '<p class="fhint">Library radio plays only tracks you own.</p>'
        : `<label class="check"><input type="checkbox" class="f-excludeowned"${ed.excludeOwnedLibrary ? ' checked' : ''}> Only music I don’t own</label>`}
    </div>
    ${ed.error ? `<p class="ferror field--wide" role="alert">${escapeHtml(ed.error)}</p>` : ''}`;
}

// The editor's actions, rendered into the card's HEAD rather than the
// foot of the form: the × lands exactly where the cog was, so the same
// spot opens the settings and closes them again. Icons, because the row
// has to share a line with the station's name — every one of them
// carries its words in title + aria-label, which is also what makes
// them findable to anyone not looking at the glyph.
//
// Called from app.js's card builders (typeof-guarded there: this file
// evaluates second). It reads ICON_* and escapeHtml from app.js, the
// same shared global scope everything else here uses.
function editorNavHTML() {
  const ed = editor;
  if (!ed) return '';
  const saving = ed.saving ? 'disabled' : '';
  const creating = ed.mode === 'create';
  const act = (cls, label, icon, extra = '') =>
    `<button type="button" class="act ${cls}${extra}" ${saving}
      title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
  return `<span class="editnav">
    ${ed.mode === 'edit' ? act('f-delete', 'Delete station', ICON_TRASH, ' act--danger') : ''}
    ${ed.mode === 'edit' && ed.broadcasting
      ? act('f-saverestart',
          'Save and restart the station — this cuts the track playing now, for every listener',
          ICON_RESTART) : ''}
    ${act('f-save', creating ? 'Create station' : 'Save changes', ICON_CHECK)}
    ${act('f-cancel', creating ? 'Discard this station' : 'Close settings', ICON_CLOSE)}
  </span>`;
}

function toggleTag(tag) {
  if (!editor) return;
  const i = editor.tags.indexOf(tag);
  if (i >= 0) editor.tags.splice(i, 1); else editor.tags.push(tag);
  renderEditor();
}

function addTagFromInput() {
  // The form is in a card, so the input is found in the grid — $panel
  // stopped existing when the sheet did.
  if (!editor || !$stations || typeof $stations.querySelector !== 'function') return;
  const input = $stations.querySelector('.f-newtag');
  if (!input) return;
  const tag = input.value.trim();
  if (tag && !editor.tags.includes(tag)) editor.tags.push(tag);
  renderEditor();
}

function addRegion(code) {
  if (!editor || editor.regions.includes(code)) return;
  editor.regions.push(code);
  renderEditor();
}

function removeRegion(code) {
  if (!editor) return;
  editor.regions = editor.regions.filter((c) => c !== code);
  renderEditor();
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
  renderHistorySection();
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
  renderHistorySection();
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

function renderHistorySection() {
  if (!$historySection) return;
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
  $historySection.innerHTML = `
    <h2>Play history</h2>
    ${historyFilterChips()}
    <ul class="hlist">${rows || '<li class="hempty">No history yet.</li>'}</ul>
    ${more}`;
}

// --- Hooks app.js pokes (guarded there with typeof) -------------------

function onOwnerChange() { renderTopbar(); }

function onHealthChange() { renderTopbar(); }

// SSE `stations` is a notification, never data — /events is public, so
// owner state re-fetches its token-gated route here instead of trusting
// the event body.
function onStationsChanged() {
  // The roster feeds the GRID now, not a panel, so it refreshes whenever
  // the server says the catalogue moved — no panel needs to be open.
  maybeLoadOwnerStations();
}

// --- Wiring -----------------------------------------------------------

function onControlClick(e) {
  if (e.target.closest('a')) return;
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.classList.contains('vol-mute')) return setVolume(null, !muted);
  // History
  if (btn.classList.contains('h-more')) return void loadHistory(true);
  if (btn.classList.contains('h-filter')) {
    historyFilter = btn.dataset.sid || null;
    return renderHistorySection();
  }
  // Editor
  if (btn.classList.contains('f-chip')) return toggleTag(btn.dataset.tag);
  if (btn.classList.contains('f-tagmatch')) {
    if (editor) { editor.tagMatch = btn.dataset.match; renderEditor(); }
    return;
  }
  if (btn.classList.contains('f-region-remove')) return removeRegion(btn.dataset.code);
  if (btn.classList.contains('f-addtag')) return addTagFromInput();
  if (btn.classList.contains('f-cancel')) return closeEditor();
  if (btn.classList.contains('f-delete')) return void deleteStationFlow(editor && editor.id);
  if (btn.classList.contains('f-save')) return void submitEditor(false);
  if (btn.classList.contains('f-saverestart')) return void submitEditor(true);
}

// Text fields sync DOM → state without re-rendering (a re-render per
// keystroke would drop focus); structural changes (chips, selects)
// re-render from state.
function onControlInput(e) {
  const t = e.target;
  // Policy dial: drag patches the % label in place (a re-render would
  // drop the drag); the commit happens on `change`.
  if (t.classList.contains('vol-range')) {
    // Live while dragging, and cheap: no re-render, just the element.
    setVolume(Number(t.value) / 100, Number(t.value) > 0 ? false : null);
    return;
  }
  if (t.classList.contains('pol-share')) {
    // The dial lives on the header row now — $panel is long gone, and
    // reaching for it here threw the moment anyone dragged it.
    const label = $topbar && typeof $topbar.querySelector === 'function'
      ? $topbar.querySelector('.pol-share-label') : null;
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
    const label = $stations && typeof $stations.querySelector === 'function'
      ? $stations.querySelector('.f-exploration-label') : null;
    if (label) label.textContent = `${t.value}%`;
  }
}

function onControlChange(e) {
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
    return renderEditor();
  }
  if (t.classList.contains('f-popularity')) editor.popularity = t.value;
  if (t.classList.contains('f-sort')) editor.sort = t.value;
  if (t.classList.contains('f-shuffle')) editor.shufflePool = t.checked;
  if (t.classList.contains('f-excludeowned')) editor.excludeOwnedLibrary = t.checked;
  if (t.classList.contains('f-region-add') && t.value) addRegion(t.value);
}

function onControlKeydown(e) {
  if (e.key !== 'Enter') return;
  if (e.target.classList && e.target.classList.contains('f-newtag')) {
    e.preventDefault();
    addTagFromInput();
  }
}

// The header row and the history section are always on screen, so each
// listens on itself. There is no sheet to open, close or escape from.
if ($topbar) {
  $topbar.addEventListener('click', onControlClick);
  $topbar.addEventListener('input', onControlInput);
  $topbar.addEventListener('change', onControlChange);
  renderTopbar();
}

if ($historySection) {
  $historySection.addEventListener('click', onControlClick);
  renderHistorySection();
  // Public, and below the fold: fetch it once at boot so scrolling down
  // always lands on something.
  loadHistory(false);
}
