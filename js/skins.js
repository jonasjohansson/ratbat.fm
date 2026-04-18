// Winamp classic .wsz skin loader.
// Parses VISCOLOR.TXT + PLEDIT.TXT from a .wsz (zip) and maps the palette
// onto the site's CSS custom properties, so a skin "themes" the player
// without us having to render Winamp's actual UI. No React, just fflate.

(function () {
  const SKIN_KEY = 'ratbat-skin';
  const BUNDLED_DEFAULT = '/skins/base.wsz';
  const THEMED_VARS = [
    '--bg', '--fg', '--muted', '--border', '--border-strong',
    '--hover', '--active', '--dot', '--player-bg',
  ];

  const td = new TextDecoder('latin1'); // classic skins are latin1

  const parseHex = (h) => {
    const m = String(h).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = ([r, g, b]) =>
    '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  // Find a file in the unzipped dict by case-insensitive basename.
  const findFile = (files, name) => {
    const lower = name.toLowerCase();
    const key = Object.keys(files).find(
      (k) => k.toLowerCase().split('/').pop() === lower
    );
    return key ? files[key] : null;
  };

  // VISCOLOR.TXT: first 24 non-empty lines start with "r,g,b,..."
  const parseVisColor = (text) => {
    const colors = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
      if (m) colors.push([+m[1], +m[2], +m[3]]);
      if (colors.length >= 24) break;
    }
    return colors;
  };

  // PLEDIT.TXT: INI-ish, Normal=#RRGGBB, NormalBG=#RRGGBB, etc.
  const parsePlEdit = (text) => {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  };

  const unzipWsz = (buffer) =>
    new Promise((resolve, reject) => {
      fflate.unzip(buffer, (err, out) => (err ? reject(err) : resolve(out)));
    });

  const loadBuffer = async (source) => {
    if (source instanceof File || source instanceof Blob) {
      return new Uint8Array(await source.arrayBuffer());
    }
    const res = await fetch(source, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`fetch ${source}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  function applyPalette({ bgRGB, fgRGB, selectedRGB, accentRGB }) {
    const root = document.documentElement.style;
    const bg = bgRGB;
    const fg = fgRGB;
    root.setProperty('--bg', toHex(bg));
    root.setProperty('--fg', toHex(fg));
    root.setProperty('--muted', toHex(mix(bg, fg, 0.55)));
    root.setProperty('--border', toHex(mix(bg, fg, 0.22)));
    root.setProperty('--border-strong', toHex(fg));
    root.setProperty('--hover', toHex(mix(bg, fg, 0.1)));
    root.setProperty(
      '--active',
      toHex(selectedRGB ? mix(bg, selectedRGB, 0.5) : mix(bg, fg, 0.18))
    );
    if (accentRGB) root.setProperty('--dot', toHex(accentRGB));
    root.setProperty('--player-bg', toHex(bg));

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', toHex(bg));
  }

  async function applySkin(source) {
    const buf = await loadBuffer(source);
    const files = await unzipWsz(buf);
    const visBytes = findFile(files, 'viscolor.txt');
    const plBytes = findFile(files, 'pledit.txt');
    const vis = visBytes ? parseVisColor(td.decode(visBytes)) : [];
    const pl = plBytes ? parsePlEdit(td.decode(plBytes)) : {};

    const bgRGB = parseHex(pl.NormalBG || '#000000') || [0, 0, 0];
    const fgRGB = parseHex(pl.Normal || '#00ff00') || [0, 255, 0];
    const selectedRGB = parseHex(pl.SelectedBG || '') || null;
    const accentRGB = vis[2] || null; // red top-of-spectrum is the classic accent

    applyPalette({ bgRGB, fgRGB, selectedRGB, accentRGB });
  }

  function resetSkin() {
    const root = document.documentElement.style;
    THEMED_VARS.forEach((v) => root.removeProperty(v));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#ffffff');
  }

  // spec: { kind: 'reset' } | { kind: 'url', url } | { kind: 'file', file }
  async function applyAndSave(spec) {
    if (spec.kind === 'reset') {
      resetSkin();
      localStorage.removeItem(SKIN_KEY);
      return;
    }
    const source = spec.kind === 'file' ? spec.file : spec.url;
    await applySkin(source);
    if (spec.kind === 'url') localStorage.setItem(SKIN_KEY, spec.url);
    else localStorage.removeItem(SKIN_KEY);
  }

  async function initialLoad() {
    const params = new URLSearchParams(window.location.search);
    const initial = params.get('skin') || localStorage.getItem(SKIN_KEY) || BUNDLED_DEFAULT;
    try {
      await applySkin(initial);
    } catch (e) {
      console.warn('skin load failed:', e);
      resetSkin();
    }
  }

  window.ratbatSkins = { applySkin, resetSkin, applyAndSave, initialLoad };
})();
