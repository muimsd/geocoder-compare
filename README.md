# Geocoder Compare

Side-by-side geocoding comparison of **Radar**, **Pelias**, **OpenStreetMap (Nominatim)**,
**Google Maps**, **Mapbox**, **HERE**, **TomTom**, **Esri ArcGIS**, **Azure Maps**, **OpenCage**,
**Geoapify**, **LocationIQ** and **MapTiler** on a Leaflet map. Bring your own API keys (OpenStreetMap works
without one), run single searches or benchmarks, and get a report with latency, coverage,
positional error and precision — exportable as CSV / JSON / PDF.

**▶ Try it now: https://geocoder-compare.pages.dev** — free, no sign-up. OpenStreetMap works
immediately; add keys for any other provider you want to compare.

## How to use
1. Open the site and click **⚙ Keys**. Expand a provider and paste your API key (links to sign up
   are next to each field). Press **Test** to check it.
2. **Search** tab: type an address or place and press **Geocode**. Each provider's results appear on
   the map and in cards. Optionally enter a known `lat, lng` (or click the map) to measure each
   provider's error in metres. Switch to **Reverse** and click the map to reverse-geocode.
3. **Benchmark** tab: load a sample set or paste your own list (one query per line, optionally
   `query | lat, lng`), then **Run benchmark**.
4. **Report** tab: scorecard, charts and per-query detail. Export CSV / JSON or print to PDF.

### Your keys are private
The app is a static page: keys live in your browser's memory and are sent only to the provider
you are testing (they're saved in localStorage only if you tick *Remember keys*). There is no
database, account or analytics. Use restricted or test keys anyway — e.g. restrict a Google key to
the Geocoding API and the `geocoder-compare.pages.dev` referrer.

| Provider | Key needed | Get one |
|---|---|---|
| OpenStreetMap (Nominatim) | No | — (public server is limited to 1 request/s) |
| Radar | Yes | https://radar.com/signup |
| Pelias | geocode.earth key, or your own server URL | https://geocode.earth/ |
| Google Maps | Yes (enable Geocoding API) | https://console.cloud.google.com/google/maps-apis/credentials |
| Mapbox | Yes | https://account.mapbox.com/access-tokens/ |
| HERE | Yes | https://platform.here.com/ |
| TomTom | Yes | https://developer.tomtom.com/user/register |
| Esri ArcGIS | Yes | https://location.arcgis.com/sign-up/ |
| Azure Maps | Yes | https://portal.azure.com/#create/Microsoft.Maps |
| OpenCage | Yes | https://opencagedata.com/users/sign_up |
| Geoapify | Yes | https://myprojects.geoapify.com/ |
| LocationIQ | Yes | https://locationiq.com/register |
| MapTiler | Yes | https://cloud.maptiler.com/account/keys/ |

## Features
- Forward and reverse geocoding against all 13 providers in parallel
- Leaflet map: colour + letter pins per provider, all results or top only, error lines to a reference point
- Reference point (type it or click the map) for absolute error; otherwise leave-one-out consensus
- Agreement matrix (pairwise distance between providers' top results)
- Benchmark mode with bundled sample sets (US, international, landmarks, edge cases, reverse) or your own list (`query | lat, lng`)
- Report: KPIs, auto-generated findings, scorecard, latency / coverage / error / precision charts, per-query table
- Options: result limit, country filter, language, map-centre bias, timeout
- Raw request URL (keys redacted) + raw JSON per provider
- Optional same-origin proxy (Cloudflare Pages Function, host allow-list, only answers this site's own pages) for providers that block CORS
- Keys stay in memory unless you opt into localStorage; light/dark theme; print stylesheet

## Structure
```
public/            static site (index.html, app.js, providers.js, samples.js, styles.css)
functions/api/     proxy.js — Pages Function relaying GETs to the allow-listed provider hosts only
```

## Run locally
No build step. Any static server works for the site; use Wrangler to include the proxy:
```sh
git clone https://github.com/muimsd/geocoder-compare.git
cd geocoder-compare
npx wrangler pages dev public
```

## Deploy your own copy
```sh
npx wrangler pages deploy public --project-name <your-project-name>
```

## Contributing
Issues and PRs welcome. A provider is one adapter object in `public/providers.js`
(`build()` returns the request, `parse()` normalises the response).

## License
[MIT](LICENSE)
