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
    '--skin-main', '--skin-cbuttons',
  ];

  // Live blob URLs for the current skin's bitmaps; revoked on next apply.
  let assets = { mainUrl: null, cbuttonsUrl: null };

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
  const luminance = ([r, g, b]) =>
    0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
  // Skin palettes target Winamp's tiny playlist, so fg can be near-bg.
  // Nudge toward white/black when contrast is too low to read.
  const ensureContrast = (bg, fg, min = 0.35) => {
    if (Math.abs(luminance(bg) - luminance(fg)) >= min) return fg;
    return luminance(bg) < 0.5 ? [240, 240, 240] : [20, 20, 20];
  };

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

  // Decode a BMP (browsers do this natively) to ImageData.
  async function decodeBmp(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/bmp' }));
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('BMP decode failed'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Find the dominant saturated color — bucket to 5 bits/channel, drop
  // greys, return the most frequent bucket.
  function pickAccent(imageData) {
    const { data } = imageData;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
      if (sat < 0.3 || max < 40) continue;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    let bestKey = null, bestCount = 0;
    for (const [k, c] of buckets) {
      if (c > bestCount) { bestCount = c; bestKey = k; }
    }
    if (bestKey === null) return null;
    return [
      ((bestKey >> 10) & 31) * 8 + 4,
      ((bestKey >> 5) & 31) * 8 + 4,
      (bestKey & 31) * 8 + 4,
    ];
  }

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
    const fg = ensureContrast(bgRGB, fgRGB);
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

  function revokeAssets() {
    if (assets.mainUrl) URL.revokeObjectURL(assets.mainUrl);
    if (assets.cbuttonsUrl) URL.revokeObjectURL(assets.cbuttonsUrl);
    assets = { mainUrl: null, cbuttonsUrl: null };
  }

  async function applySkin(source) {
    const buf = await loadBuffer(source);
    const files = await unzipWsz(buf);
    const visBytes = findFile(files, 'viscolor.txt');
    const plBytes = findFile(files, 'pledit.txt');
    const mainBytes = findFile(files, 'main.bmp');
    const cbBytes = findFile(files, 'cbuttons.bmp');
    const vis = visBytes ? parseVisColor(td.decode(visBytes)) : [];
    const pl = plBytes ? parsePlEdit(td.decode(plBytes)) : {};

    const bgRGB = parseHex(pl.NormalBG || '#000000') || [0, 0, 0];
    const fgRGB = parseHex(pl.Normal || '#00ff00') || [0, 255, 0];
    const selectedRGB = parseHex(pl.SelectedBG || '') || null;

    let accentRGB = null;
    if (mainBytes) {
      try {
        const imageData = await decodeBmp(mainBytes);
        accentRGB = pickAccent(imageData);
      } catch (_) { /* fall through */ }
    }
    if (!accentRGB) accentRGB = vis[2] || null;

    applyPalette({ bgRGB, fgRGB, selectedRGB, accentRGB });

    revokeAssets();
    assets.mainUrl = mainBytes
      ? URL.createObjectURL(new Blob([mainBytes], { type: 'image/bmp' }))
      : null;
    assets.cbuttonsUrl = cbBytes
      ? URL.createObjectURL(new Blob([cbBytes], { type: 'image/bmp' }))
      : null;

    const rootStyle = document.documentElement.style;
    if (assets.mainUrl) rootStyle.setProperty('--skin-main', `url(${assets.mainUrl})`);
    else rootStyle.removeProperty('--skin-main');
    if (assets.cbuttonsUrl) rootStyle.setProperty('--skin-cbuttons', `url(${assets.cbuttonsUrl})`);
    else rootStyle.removeProperty('--skin-cbuttons');

    document.body.classList.toggle('has-skin-panel', !!(assets.mainUrl && assets.cbuttonsUrl));

    window.dispatchEvent(new CustomEvent('ratbat:skin-applied', {
      detail: { viscolors: vis.map(([r, g, b]) => `rgb(${r},${g},${b})`) },
    }));
  }

  function resetSkin() {
    const root = document.documentElement.style;
    THEMED_VARS.forEach((v) => root.removeProperty(v));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#ffffff');
    revokeAssets();
    document.body.classList.remove('has-skin-panel');
    window.dispatchEvent(new CustomEvent('ratbat:skin-applied', { detail: { viscolors: [] } }));
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
