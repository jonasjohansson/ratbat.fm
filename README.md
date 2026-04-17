# ratbat.fm

Static web frontend for **Ratbat**, a personal radio broadcasting app.

- **Live site:** https://ratbat.jonasjohansson.se
- **Stream API:** https://radio.jonasjohansson.se
- **Mac app:** private repo [jonasjohansson/ratbat](https://github.com/jonasjohansson/ratbat)

## What this is

HTML/CSS/JS only. Hosted on GitHub Pages. Polls the Ratbat broadcaster's `/now.json` to show what's playing; audio streams directly from the broadcaster's HTTPS endpoint.

When the Mac app is broadcasting, this page shows live stations. When it's not, "Broadcaster offline".

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
