// Same-origin relay for geocoding providers that block browser (CORS) requests.
// Only forwards GET requests from this site's own pages to an allow-list of provider hosts;
// nothing is logged or stored.
const ALLOWED_HOSTS = new Set([
  'api.radar.io',
  'api.geocode.earth',
  'nominatim.openstreetmap.org',
  'maps.googleapis.com',
  'api.mapbox.com',
  'geocode.search.hereapi.com',
  'revgeocode.search.hereapi.com',
  'api.tomtom.com',
  'geocode-api.arcgis.com',
  'atlas.microsoft.com',
  'api.opencagedata.com',
  'api.geoapify.com',
  'us1.locationiq.com',
  'eu1.locationiq.com',
  'api.maptiler.com',
]);

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Accept only requests made by pages on this same origin, so other sites can't use the relay.
// (Non-browser clients can forge these headers; this stops cross-site browser abuse, not determined scripts.)
function isSameOrigin(request, selfOrigin) {
  if (request.headers.get('Sec-Fetch-Site') === 'same-origin') return true;
  const ref = request.headers.get('Referer') || request.headers.get('Origin');
  try {
    return !!ref && new URL(ref).origin === selfOrigin;
  } catch {
    return false;
  }
}

export async function onRequestGet({ request }) {
  const self = new URL(request.url);
  if (!isSameOrigin(request, self.origin)) return json(403, { error: 'The proxy only serves requests from this site.' });

  const target = self.searchParams.get('url');
  if (!target) return json(400, { error: 'Missing ?url=' });

  let url;
  try {
    url = new URL(target);
  } catch {
    return json(400, { error: 'Invalid url' });
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    return json(403, { error: `Host not allowed: ${url.hostname}` });
  }

  const headers = new Headers({ Accept: 'application/json', 'User-Agent': 'geocoder-compare (+https://pages.dev)' });
  const auth = request.headers.get('Authorization');
  if (auth) headers.set('Authorization', auth);
  const lang = request.headers.get('Accept-Language');
  if (lang) headers.set('Accept-Language', lang);
  // Forward the page's referrer so HTTP-referrer-restricted keys keep working.
  const referer = request.headers.get('Referer');
  if (referer) headers.set('Referer', referer);

  try {
    const upstream = await fetch(url.toString(), { headers, cf: { cacheTtl: 0 } });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return json(502, { error: `Upstream fetch failed: ${e.message}` });
  }
}
