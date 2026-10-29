# Geocoder Compare

Side-by-side geocoding comparison of **Radar**, **Pelias**, **OpenStreetMap (Nominatim)**,
**Google Maps**, **Mapbox**, **HERE**, **TomTom**, **Esri ArcGIS**, **Azure Maps**, **OpenCage**,
**Geoapify**, **LocationIQ** and **MapTiler** on a Leaflet map. Bring your own API keys (OpenStreetMap works
without one), run single searches or benchmarks, and get a report with latency, coverage,
positional error and precision — exportable as CSV / JSON / PDF.

## Features
- Forward and reverse geocoding against all 13 providers in parallel
- Leaflet map: colour + letter pins per provider, all results or top only, error lines to a reference point
- Reference point (type it or click the map) for absolute error; otherwise leave-one-out consensus
- Agreement matrix (pairwise distance between providers' top results)
- Benchmark mode with bundled sample sets (US, international, landmarks, edge cases, reverse) or your own list (`query | lat, lng`)
- Report: KPIs, auto-generated findings, scorecard, latency / coverage / error / precision charts, per-query table
- Options: result limit, country filter, language, map-centre bias, timeout
- Raw request URL (keys redacted) + raw JSON per provider
- Optional same-origin proxy (Cloudflare Pages Function, host allow-list) for providers that block CORS
- Keys stay in memory unless you opt into localStorage; light/dark theme; print stylesheet

## Structure
```
public/            static site (index.html, app.js, providers.js, samples.js, styles.css)
functions/api/     proxy.js — Pages Function relaying GETs to the allow-listed provider hosts only
```

## Run locally
```sh
wrangler pages dev public
```

## Deploy
```sh
wrangler pages deploy public --project-name geocoder-compare
```

Live demo: https://geocoder-compare.pages.dev
