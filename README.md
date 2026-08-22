# ratbat.fm

Static web frontend for **Ratbat**, a personal radio broadcasting app.

- **Live site:** https://ratbat.jonasjohansson.se
- **Stream API:** https://radio.jonasjohansson.se
- **Mac app:** private repo [jonasjohansson/ratbat](https://github.com/jonasjohansson/ratbat)

## What this is

HTML/CSS/JS only — no build step, no framework. Hosted on GitHub Pages. Live now-playing via the broadcaster's SSE `/events` stream (falling back to polling `/now.json`); audio streams directly from the broadcaster's HTTPS endpoint. A persistent play-history panel reads `/history`.

When the Mac app is broadcasting, this page shows live stations. When it's not, "Broadcaster offline".

### Owner mode

The lock button logs in with the broadcaster's owner passcode (validated against `POST /auth`, stored locally). A logged-in owner gets, on top of the listener actions (♥ / skip / next / boost):

- **Station editor** — create, edit, start, stop, auto-start, and delete stations (NTS / Last.fm / Bandcamp, plus Library Radio when the backend advertises it in `vocab.kinds`) from the browser; forms are built from the server's `/vocab` so tag palettes and options never go stale.
- **Selection controls** — the global new-music share dial and mix-set filter (`/policy`).
- **Taste panel** — what the selection pipeline believes about your taste (`/taste`).
- **About this track** — public artist/track enrichment on the now-playing card (`/trackinfo`).
- A health strip (on-air / uptime / most recent gap) from `/health`.

### Feature detection

The site feature-detects against the backend via `GET /health`: the server advertises a `capabilities` array (`stations`, `policy`, `taste`, `exclusions`, …) and each owner panel renders only when its capability is present. Against an older backend (or when `/health` 404s) the page degrades to the plain listener experience — deploys of site and backend never need to be coordinated. The API is documented in the Mac app repo's `docs/http-api.md`.

Domain `ratbat.fm` aspirational for future.

## Use it for your own station

This frontend isn't bound to Jonas's backend. Fork the repo, point it at your own Ratbat Mac app.

**Option 1: convention-based DNS (recommended)**
If the page is served from `ratbat.YOUR-DOMAIN`, the JS auto-discovers the API at `radio.YOUR-DOMAIN`.
1. Fork this repo to `you/ratbat.fm`
2. Enable GitHub Pages on main branch, root
3. Update the `CNAME` file to `ratbat.yourdomain.com` and configure your DNS (CNAME to `YOUR-USERNAME.github.io`)
4. Run Ratbat on your Mac with a Cloudflare Tunnel exposing `radio.yourdomain.com`
5. Open `https://ratbat.yourdomain.com` — the page finds your backend automatically

**Option 2: explicit override**
- Query param: append `?api=https://radio.yourdomain.com` to any URL
- Or set `window.RATBAT_API = 'https://radio.yourdomain.com'` in a `<script>` before `app.js` loads
