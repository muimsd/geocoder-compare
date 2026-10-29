/* Provider adapters.
 * Each adapter builds a request for forward/reverse geocoding and normalizes the
 * response into: { lat, lng, label, tier, providerConfidence, type, raw }.
 *
 * `tier` is a cross-provider precision bucket derived from each API's own
 * type / layer / accuracy fields so results can be compared like-for-like.
 */
(function () {
  'use strict';

  const TIERS = [
    { id: 'rooftop', label: 'Rooftop / POI', rank: 6 },
    { id: 'interpolated', label: 'Interpolated address', rank: 5 },
    { id: 'street', label: 'Street / intersection', rank: 4 },
    { id: 'locality', label: 'Locality / postal', rank: 3 },
    { id: 'region', label: 'Region / county', rank: 2 },
    { id: 'country', label: 'Country', rank: 1 },
    { id: 'other', label: 'Other / unknown', rank: 0 },
  ];

  const LOCALITY = ['locality', 'localadmin', 'neighbourhood', 'neighborhood', 'borough', 'macrohood',
    'postalcode', 'postalCode', 'postcode', 'place', 'district', 'sublocality', 'postal_code',
    'administrative_area_level_3', 'administrative_area_level_4', 'colloquial_area', 'postal_town', 'city', 'town', 'village', 'suburb', 'hamlet'];
  const REGION = ['county', 'macrocounty', 'region', 'macroregion', 'dependency', 'state',
    'administrative_area_level_1', 'administrative_area_level_2'];

  function tierFromType(t) {
    if (!t) return 'other';
    if (LOCALITY.includes(t)) return 'locality';
    if (REGION.includes(t)) return 'region';
    if (t === 'country') return 'country';
    if (['street', 'route', 'intersection', 'block'].includes(t)) return 'street';
    return null;
  }

  function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.set(k, v);
    }
    return u.toString();
  }

  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

  /** Nominatim-style JSON (Nominatim, LocationIQ). Uses place_rank when present, else class/type heuristics. */
  function parseNominatimLike(json) {
    if (json?.error) {
      // Reverse returns {error:"Unable to geocode"} when nothing is found.
      const msg = typeof json.error === 'string' ? json.error : json.error.message;
      if (/unable to geocode|no.*found/i.test(msg)) return [];
      throw new Error(msg);
    }
    const arr = Array.isArray(json) ? json : [json];
    return arr.filter((r) => r && r.lat).map((r) => {
      let tier = 'other';
      if (r.place_rank != null) {
        const rank = Number(r.place_rank);
        if (rank >= 28) tier = 'rooftop';
        else if (rank >= 26) tier = 'street';
        else if (rank >= 13) tier = 'locality';
        else if (rank >= 5) tier = 'region';
        else if (rank >= 4) tier = 'country';
      } else {
        const cls = r.class || r.category, type = r.addresstype || r.type;
        if (r.address?.house_number || ['house', 'building', 'amenity', 'tourism', 'shop', 'office'].includes(cls) || type === 'house') tier = 'rooftop';
        else if (cls === 'highway') tier = 'street';
        else tier = tierFromType(type) || (type === 'administrative' ? 'region' : 'other');
      }
      return {
        lat: num(r.lat), lng: num(r.lon), label: r.display_name,
        type: r.addresstype || r.type, tier,
        providerConfidence: r.importance != null ? `importance ${Number(r.importance).toFixed(2)}` : (r.place_rank != null ? `rank ${r.place_rank}` : ''),
        raw: r,
      };
    });
  }

  // ---------------------------------------------------------------- Radar
  const radar = {
    id: 'radar',
    slot: 1,
    about: { endpoint: '<code>/v1/geocode/forward</code>, <code>/reverse</code>', auth: '<code>Authorization</code> header (publishable key OK in browser)', data: 'Proprietary + open data blend', oss: 'No', limits: 'Free tier, then metered', precision: '<code>confidence</code>: exact / interpolated / fallback' },
    name: 'Radar',
    letter: 'R',
    needsKey: true,
    keyLabel: 'Publishable or secret key',
    keyPlaceholder: 'prj_live_pk_…',
    docs: 'https://radar.com/documentation/api#geocoding',
    signup: 'https://radar.com/signup',
    build(mode, input, opt, cfg) {
      const base = 'https://api.radar.io/v1';
      const headers = { Authorization: cfg.key };
      if (mode === 'forward') {
        return {
          url: `${base}/geocode/forward?` + qs({ query: input.text, country: opt.country?.toUpperCase(), lang: opt.lang }),
          headers,
        };
      }
      return { url: `${base}/geocode/reverse?` + qs({ coordinates: `${input.lat},${input.lng}` }), headers };
    },
    parse(json) {
      if (json?.meta && json.meta.code !== 200) throw new Error(json.meta.message || `Radar error ${json.meta.code}`);
      return (json.addresses || []).map((a) => {
        let tier = tierFromType(a.layer);
        if (!tier) {
          if (a.layer === 'address') tier = a.confidence === 'exact' ? 'rooftop' : 'interpolated';
          else if (a.layer === 'place' || a.layer === 'fine') tier = 'rooftop';
          else if (a.layer === 'coarse') tier = 'locality';
          else tier = 'other';
        }
        return {
          lat: num(a.latitude), lng: num(a.longitude),
          label: a.formattedAddress || [a.placeLabel, a.addressLabel].filter(Boolean).join(', '),
          type: a.layer, tier, providerConfidence: a.confidence, raw: a,
        };
      });
    },
  };

  // ---------------------------------------------------------------- Pelias
  const pelias = {
    id: 'pelias',
    slot: 2,
    about: { endpoint: '<code>/v1/search</code>, <code>/v1/reverse</code>', auth: '<code>api_key</code> param (hosted) or none (self-hosted)', data: 'Open: OSM, OpenAddresses, Who’s On First, GeoNames', oss: 'Yes (MIT), self-hostable', limits: 'Depends on host/plan; unlimited if self-hosted', precision: '<code>confidence</code> 0–1, <code>match_type</code>, <code>accuracy</code>' },
    name: 'Pelias',
    letter: 'P',
    needsKey: false,
    keyLabel: 'API key (geocode.earth or your host; blank for open self-hosted)',
    keyPlaceholder: 'ge-…',
    hasBaseUrl: true,
    defaultBaseUrl: 'https://api.geocode.earth/v1',
    docs: 'https://github.com/pelias/documentation',
    signup: 'https://geocode.earth/',
    build(mode, input, opt, cfg) {
      const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const common = { api_key: cfg.key, lang: opt.lang, size: opt.limit };
      if (mode === 'forward') {
        return {
          url: `${base}/search?` + qs({
            text: input.text, ...common,
            'boundary.country': opt.country?.toUpperCase(),
            'focus.point.lat': opt.bias?.lat, 'focus.point.lon': opt.bias?.lng,
          }),
        };
      }
      return { url: `${base}/reverse?` + qs({ 'point.lat': input.lat, 'point.lon': input.lng, ...common }) };
    },
    parse(json) {
      if (json?.geocoding?.errors?.length) throw new Error(json.geocoding.errors.join('; '));
      return (json.features || []).map((f) => {
        const p = f.properties || {};
        let tier = tierFromType(p.layer);
        if (!tier) {
          if (p.layer === 'venue') tier = 'rooftop';
          else if (p.layer === 'address') tier = p.match_type === 'interpolated' || p.accuracy === 'centroid' ? 'interpolated' : 'rooftop';
          else tier = 'other';
        }
        const conf = typeof p.confidence === 'number' ? p.confidence.toFixed(2) : '';
        return {
          lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0],
          label: p.label || p.name, type: p.layer, tier,
          providerConfidence: [conf, p.match_type].filter(Boolean).join(' · '), raw: f,
        };
      });
    },
  };

  // ---------------------------------------------------------------- Nominatim
  const nominatim = {
    id: 'nominatim',
    slot: 3,
    about: { endpoint: '<code>/search</code>, <code>/reverse</code> (jsonv2)', auth: 'None; identify with <code>email=</code>', data: 'OpenStreetMap', oss: 'Yes (GPL), self-hostable', limits: 'Public server: max 1 req/s, no bulk use, attribution required', precision: '<code>place_rank</code>, <code>importance</code>' },
    name: 'OpenStreetMap',
    subtitle: 'Nominatim',
    letter: 'O',
    needsKey: false,
    keyLabel: 'Contact email (optional, sent as email= per usage policy)',
    keyPlaceholder: 'you@example.com',
    keyIsEmail: true,
    hasBaseUrl: true,
    defaultBaseUrl: 'https://nominatim.openstreetmap.org',
    minIntervalMs: 1100,
    docs: 'https://nominatim.org/release-docs/latest/api/Overview/',
    signup: 'https://operations.osmfoundation.org/policies/nominatim/',
    build(mode, input, opt, cfg) {
      const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const common = { format: 'jsonv2', addressdetails: 1, 'accept-language': opt.lang, email: cfg.key };
      if (mode === 'forward') {
        let viewbox;
        if (opt.bias) {
          const d = 0.5;
          viewbox = [opt.bias.lng - d, opt.bias.lat + d, opt.bias.lng + d, opt.bias.lat - d].map((n) => n.toFixed(5)).join(',');
        }
        return {
          url: `${base}/search?` + qs({ q: input.text, limit: opt.limit, countrycodes: opt.country?.toLowerCase(), viewbox, ...common }),
        };
      }
      return { url: `${base}/reverse?` + qs({ lat: input.lat, lon: input.lng, ...common }) };
    },
    parse: parseNominatimLike,
  };

  // ---------------------------------------------------------------- Google
  const google = {
    id: 'google',
    slot: 4,
    about: { endpoint: 'Geocoding API <code>/geocode/json</code>', auth: '<code>key</code> param', data: 'Proprietary', oss: 'No', limits: 'Metered; results generally must be shown on a Google map per ToS', precision: '<code>location_type</code> ROOFTOP…APPROXIMATE, <code>partial_match</code>' },
    name: 'Google Maps',
    letter: 'G',
    needsKey: true,
    keyLabel: 'API key (Geocoding API enabled)',
    keyPlaceholder: 'AIza…',
    docs: 'https://developers.google.com/maps/documentation/geocoding/requests-geocoding',
    signup: 'https://console.cloud.google.com/google/maps-apis/credentials',
    build(mode, input, opt, cfg) {
      const base = 'https://maps.googleapis.com/maps/api/geocode/json';
      if (mode === 'forward') {
        let bounds;
        if (opt.bias) {
          const d = 0.5;
          bounds = `${opt.bias.lat - d},${opt.bias.lng - d}|${opt.bias.lat + d},${opt.bias.lng + d}`;
        }
        return {
          url: `${base}?` + qs({
            address: input.text, key: cfg.key, language: opt.lang,
            region: opt.country?.toLowerCase(),
            components: opt.country ? `country:${opt.country.toUpperCase()}` : '',
            bounds,
          }),
        };
      }
      return { url: `${base}?` + qs({ latlng: `${input.lat},${input.lng}`, key: cfg.key, language: opt.lang }) };
    },
    parse(json) {
      if (json.status === 'ZERO_RESULTS') return [];
      if (json.status !== 'OK') throw new Error(`${json.status}${json.error_message ? ': ' + json.error_message : ''}`);
      return json.results.map((r) => {
        const lt = r.geometry?.location_type;
        const types = r.types || [];
        let tier;
        if (lt === 'ROOFTOP') tier = 'rooftop';
        else if (lt === 'RANGE_INTERPOLATED') tier = 'interpolated';
        else if (types.some((t) => ['premise', 'subpremise', 'establishment', 'point_of_interest', 'street_address'].includes(t))) tier = 'rooftop';
        else tier = types.map(tierFromType).find(Boolean) || 'other';
        return {
          lat: r.geometry.location.lat, lng: r.geometry.location.lng,
          label: r.formatted_address, type: types[0], tier,
          providerConfidence: [lt, r.partial_match ? 'partial match' : ''].filter(Boolean).join(' · '),
          raw: r,
        };
      });
    },
  };

  // ---------------------------------------------------------------- Mapbox
  const mapbox = {
    id: 'mapbox',
    slot: 5,
    about: { endpoint: 'Geocoding v6 <code>/forward</code>, <code>/reverse</code>', auth: '<code>access_token</code> param', data: 'Proprietary + open data', oss: 'No', limits: 'Metered; default results are “temporary”, storing needs <code>permanent=true</code>', precision: '<code>match_code.confidence</code>, <code>coordinates.accuracy</code>' },
    name: 'Mapbox',
    letter: 'M',
    needsKey: true,
    keyLabel: 'Access token (Geocoding v6)',
    keyPlaceholder: 'pk.eyJ…',
    docs: 'https://docs.mapbox.com/api/search/geocoding/',
    signup: 'https://account.mapbox.com/access-tokens/',
    build(mode, input, opt, cfg) {
      const base = 'https://api.mapbox.com/search/geocode/v6';
      if (mode === 'forward') {
        return {
          url: `${base}/forward?` + qs({
            q: input.text, access_token: cfg.key, limit: opt.limit, autocomplete: 'false',
            country: opt.country?.toLowerCase(), language: opt.lang,
            proximity: opt.bias ? `${opt.bias.lng},${opt.bias.lat}` : '',
          }),
        };
      }
      return {
        url: `${base}/reverse?` + qs({ longitude: input.lng, latitude: input.lat, access_token: cfg.key, language: opt.lang }),
      };
    },
    parse(json) {
      if (json?.message && !json.features) throw new Error(json.message);
      return (json.features || []).map((f) => {
        const p = f.properties || {};
        const acc = p.coordinates?.accuracy;
        let tier = tierFromType(p.feature_type);
        if (!tier) {
          if (p.feature_type === 'address' || p.feature_type === 'secondary_address') {
            tier = ['rooftop', 'parcel', 'point'].includes(acc) ? 'rooftop' : 'interpolated';
          } else if (p.feature_type === 'poi') tier = 'rooftop';
          else tier = 'other';
        }
        return {
          lat: p.coordinates?.latitude ?? f.geometry?.coordinates?.[1],
          lng: p.coordinates?.longitude ?? f.geometry?.coordinates?.[0],
          label: p.full_address || [p.name, p.place_formatted].filter(Boolean).join(', '),
          type: p.feature_type, tier,
          providerConfidence: [p.match_code?.confidence, acc].filter(Boolean).join(' · '),
          raw: f,
        };
      });
    },
  };

  // ---------------------------------------------------------------- HERE
  // HERE's `in=countryCode:` filter needs ISO-3166 alpha-3.
  const ISO3 = {
    us: 'USA', ca: 'CAN', mx: 'MEX', br: 'BRA', ar: 'ARG', cl: 'CHL', co: 'COL', pe: 'PER', gb: 'GBR', uk: 'GBR', ie: 'IRL',
    fr: 'FRA', de: 'DEU', es: 'ESP', pt: 'PRT', it: 'ITA', nl: 'NLD', be: 'BEL', lu: 'LUX', ch: 'CHE', at: 'AUT', dk: 'DNK',
    se: 'SWE', no: 'NOR', fi: 'FIN', is: 'ISL', pl: 'POL', cz: 'CZE', sk: 'SVK', hu: 'HUN', ro: 'ROU', bg: 'BGR', gr: 'GRC',
    hr: 'HRV', si: 'SVN', rs: 'SRB', ua: 'UKR', ru: 'RUS', tr: 'TUR', il: 'ISR', ae: 'ARE', sa: 'SAU', qa: 'QAT', eg: 'EGY',
    ma: 'MAR', ng: 'NGA', ke: 'KEN', za: 'ZAF', in: 'IND', pk: 'PAK', bd: 'BGD', lk: 'LKA', cn: 'CHN', hk: 'HKG', tw: 'TWN',
    jp: 'JPN', kr: 'KOR', sg: 'SGP', my: 'MYS', th: 'THA', vn: 'VNM', id: 'IDN', ph: 'PHL', au: 'AUS', nz: 'NZL',
  };
  const here = {
    id: 'here',
    name: 'HERE',
    letter: 'H',
    slot: 6,
    needsKey: true,
    keyLabel: 'API key (Geocoding & Search v7)',
    keyPlaceholder: 'API key',
    docs: 'https://www.here.com/docs/bundle/geocoding-and-search-api-developer-guide/page/README.html',
    signup: 'https://platform.here.com/',
    about: { endpoint: '<code>/v1/geocode</code>, <code>/v1/revgeocode</code>', auth: '<code>apiKey</code> param', data: 'Proprietary (automotive-grade)', oss: 'No', limits: 'Free tier, then metered', precision: '<code>resultType</code>, <code>houseNumberType</code> (PA/interpolated), <code>scoring.queryScore</code>' },
    build(mode, input, opt, cfg) {
      const common = { apiKey: cfg.key, lang: opt.lang, limit: opt.limit };
      if (mode === 'forward') {
        const c3 = opt.country ? ISO3[opt.country.toLowerCase()] : null;
        return {
          url: 'https://geocode.search.hereapi.com/v1/geocode?' + qs({
            q: input.text, ...common, in: c3 ? `countryCode:${c3}` : '', at: opt.bias ? `${opt.bias.lat},${opt.bias.lng}` : '',
          }),
        };
      }
      return { url: 'https://revgeocode.search.hereapi.com/v1/revgeocode?' + qs({ at: `${input.lat},${input.lng}`, ...common }) };
    },
    parse(json) {
      if (json?.error || json?.title && !json.items) throw new Error(json.error_description || json.title || json.error);
      return (json.items || []).map((it) => {
        const rt = it.resultType;
        let tier = 'other';
        if (rt === 'houseNumber') tier = it.houseNumberType === 'interpolated' ? 'interpolated' : 'rooftop';
        else if (rt === 'place') tier = 'rooftop';
        else if (['street', 'intersection', 'addressBlock'].includes(rt)) tier = 'street';
        else if (['locality', 'postalCodePoint'].includes(rt)) tier = 'locality';
        else if (rt === 'administrativeArea') tier = it.administrativeAreaType === 'country' ? 'country' : 'region';
        const pos = it.position;
        return {
          lat: pos?.lat, lng: pos?.lng, label: it.address?.label || it.title, type: rt + (it.houseNumberType ? `/${it.houseNumberType}` : ''), tier,
          providerConfidence: it.scoring?.queryScore != null ? `score ${Number(it.scoring.queryScore).toFixed(2)}` : '',
          raw: it,
        };
      });
    },
  };

  // ---------------------------------------------------------------- TomTom
  function tomtomTier(type, entityType, matchType) {
    if (type === 'Point Address' || type === 'POI' || matchType === 'AddressPoint') return 'rooftop';
    if (type === 'Address Range' || matchType === 'HouseNumberRange') return 'interpolated';
    if (type === 'Street' || type === 'Cross Street' || matchType === 'Street') return 'street';
    if (entityType === 'Country') return 'country';
    if (/CountrySubdivision|CountrySecondarySubdivision|CountryTertiarySubdivision/.test(entityType || '')) return 'region';
    if (type === 'Geography' || entityType) return 'locality';
    return 'other';
  }
  const tomtom = {
    id: 'tomtom',
    name: 'TomTom',
    letter: 'T',
    slot: 7,
    needsKey: true,
    keyLabel: 'API key (Search API)',
    keyPlaceholder: 'API key',
    docs: 'https://developer.tomtom.com/geocoding-api/documentation/geocode',
    signup: 'https://developer.tomtom.com/user/register',
    about: { endpoint: '<code>/search/2/geocode</code>, <code>/reverseGeocode</code>', auth: '<code>key</code> param', data: 'Proprietary (automotive-grade)', oss: 'No', limits: 'Free daily allowance, then metered', precision: '<code>type</code> (Point Address, Address Range…), <code>matchConfidence.score</code>' },
    build(mode, input, opt, cfg) {
      const base = 'https://api.tomtom.com/search/2';
      if (mode === 'forward') {
        return {
          url: `${base}/geocode/${encodeURIComponent(input.text)}.json?` + qs({
            key: cfg.key, limit: opt.limit, countrySet: opt.country?.toUpperCase(), language: opt.lang,
            lat: opt.bias?.lat, lon: opt.bias?.lng,
          }),
        };
      }
      return { url: `${base}/reverseGeocode/${input.lat},${input.lng}.json?` + qs({ key: cfg.key, language: opt.lang }) };
    },
    parse(json) {
      if (json?.errorText || json?.detailedError || json?.error) throw new Error(json.errorText || json.detailedError?.message || json.error?.description || 'TomTom error');
      if (json.addresses) {
        return json.addresses.map((a) => {
          const [lat, lng] = String(a.position).split(',').map(Number);
          return { lat, lng, label: a.address?.freeformAddress, type: a.matchType || a.entityType, tier: tomtomTier(null, a.entityType, a.matchType), providerConfidence: '', raw: a };
        });
      }
      return (json.results || []).map((r) => ({
        lat: r.position?.lat, lng: r.position?.lon,
        label: [r.poi?.name, r.address?.freeformAddress].filter(Boolean).join(', '),
        type: r.type + (r.entityType ? `/${r.entityType}` : ''), tier: tomtomTier(r.type, r.entityType),
        providerConfidence: r.matchConfidence?.score != null ? `match ${Number(r.matchConfidence.score).toFixed(2)}` : `score ${Number(r.score || 0).toFixed(2)}`,
        raw: r,
      }));
    },
  };

  // ---------------------------------------------------------------- Esri
  function esriTier(t) {
    if (['PointAddress', 'Subaddress', 'POI', 'ParcelAddress'].includes(t)) return 'rooftop';
    if (['StreetAddress', 'StreetAddressExt', 'DistanceMarker'].includes(t)) return 'interpolated';
    if (['StreetInt', 'StreetName', 'StreetMidBlock', 'StreetBetween'].includes(t)) return 'street';
    if (['Locality', 'Postal', 'PostalExt', 'PostalLoc'].includes(t)) return 'locality';
    if (['Subregion', 'Region', 'Zone'].includes(t)) return 'region';
    if (t === 'Country') return 'country';
    return 'other';
  }
  const esri = {
    id: 'esri',
    name: 'Esri ArcGIS',
    letter: 'E',
    slot: 8,
    needsKey: true,
    keyLabel: 'ArcGIS API key / access token (Geocoding)',
    keyPlaceholder: 'AAPK… / AAPT…',
    docs: 'https://developers.arcgis.com/rest/geocode/api-reference/geocoding-find-address-candidates.htm',
    signup: 'https://location.arcgis.com/sign-up/',
    about: { endpoint: '<code>findAddressCandidates</code>, <code>reverseGeocode</code>', auth: '<code>token</code> param', data: 'Proprietary (HERE, TomTom, OSM & authoritative sources)', oss: 'No', limits: 'Free tier for non-stored results; storing needs <code>forStorage=true</code> (billed)', precision: '<code>Addr_type</code> (PointAddress, StreetAddress…), <code>score</code> 0–100' },
    build(mode, input, opt, cfg) {
      const base = 'https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer';
      if (mode === 'forward') {
        return {
          url: `${base}/findAddressCandidates?` + qs({
            SingleLine: input.text, f: 'json', token: cfg.key, outFields: 'Addr_type,LongLabel,Match_addr,Type',
            maxLocations: opt.limit, countryCode: opt.country?.toUpperCase(), langCode: opt.lang,
            location: opt.bias ? `${opt.bias.lng},${opt.bias.lat}` : '',
          }),
        };
      }
      return { url: `${base}/reverseGeocode?` + qs({ location: `${input.lng},${input.lat}`, f: 'json', token: cfg.key, langCode: opt.lang }) };
    },
    parse(json) {
      if (json?.error) {
        if (json.error.code === 400 && /unable to find address/i.test(json.error.details?.join(' ') || json.error.message)) return [];
        throw new Error(`${json.error.code}: ${json.error.message}${json.error.details?.length ? ' — ' + json.error.details.join(' ') : ''}`);
      }
      if (json.address) {
        const a = json.address;
        return [{ lat: json.location?.y, lng: json.location?.x, label: a.LongLabel || a.Match_addr, type: a.Addr_type, tier: esriTier(a.Addr_type), providerConfidence: '', raw: json }];
      }
      return (json.candidates || []).map((c) => ({
        lat: c.location?.y, lng: c.location?.x, label: c.attributes?.LongLabel || c.address,
        type: c.attributes?.Addr_type + (c.attributes?.Type ? `/${c.attributes.Type}` : ''), tier: esriTier(c.attributes?.Addr_type),
        providerConfidence: `score ${c.score}`, raw: c,
      }));
    },
  };

  // ---------------------------------------------------------------- Azure Maps
  const azure = {
    id: 'azure',
    name: 'Azure Maps',
    letter: 'Az',
    slot: 1,
    hollow: true,
    needsKey: true,
    keyLabel: 'Subscription key (Geocoding 2025-01-01)',
    keyPlaceholder: 'subscription key',
    docs: 'https://learn.microsoft.com/rest/api/maps/search/get-geocoding',
    signup: 'https://portal.azure.com/#create/Microsoft.Maps',
    about: { endpoint: '<code>/geocode</code>, <code>/reverseGeocode</code> (api-version 2025-01-01)', auth: '<code>subscription-key</code> param', data: 'Proprietary (Bing Maps / TomTom heritage)', oss: 'No', limits: 'Free monthly allowance, then metered', precision: '<code>type</code>, <code>confidence</code> High/Medium/Low, <code>geocodePoints.calculationMethod</code>' },
    build(mode, input, opt, cfg) {
      const base = 'https://atlas.microsoft.com';
      const headers = opt.lang ? { 'Accept-Language': opt.lang } : {};
      if (mode === 'forward') {
        return {
          url: `${base}/geocode?` + qs({
            'api-version': '2025-01-01', query: input.text, top: opt.limit, 'subscription-key': cfg.key,
            coordinates: opt.bias ? `${opt.bias.lng},${opt.bias.lat}` : '',
          }),
          headers,
        };
      }
      return { url: `${base}/reverseGeocode?` + qs({ 'api-version': '2025-01-01', coordinates: `${input.lng},${input.lat}`, 'subscription-key': cfg.key }), headers };
    },
    parse(json) {
      if (json?.error) throw new Error(`${json.error.code}: ${json.error.message}`);
      return (json.features || []).map((f) => {
        const p = f.properties || {};
        const t = p.type;
        const method = p.geocodePoints?.[0]?.calculationMethod;
        let tier = 'other';
        if (t === 'Address') tier = method === 'Rooftop' || method === 'Parcel' ? 'rooftop' : 'interpolated';
        else if (/^Road|Intersection/.test(t || '')) tier = 'street';
        else if (['PopulatedPlace', 'Postcode1', 'Postcode', 'Neighborhood'].includes(t)) tier = 'locality';
        else if (/^AdminDivision/.test(t || '')) tier = 'region';
        else if (t === 'CountryRegion') tier = 'country';
        else if (t) tier = 'rooftop'; // landmarks / POI entity types
        return {
          lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0],
          label: p.address?.formattedAddress || p.name, type: t + (method ? `/${method}` : ''), tier,
          providerConfidence: [p.confidence, (p.matchCodes || []).join('+')].filter(Boolean).join(' · '),
          raw: f,
        };
      });
    },
  };

  // ---------------------------------------------------------------- OpenCage
  const opencage = {
    id: 'opencage',
    name: 'OpenCage',
    letter: 'OC',
    slot: 2,
    hollow: true,
    needsKey: true,
    keyLabel: 'API key',
    keyPlaceholder: 'API key',
    minIntervalMs: 1050,
    docs: 'https://opencagedata.com/api',
    signup: 'https://opencagedata.com/users/sign_up',
    about: { endpoint: '<code>/geocode/v1/json</code> (forward &amp; reverse)', auth: '<code>key</code> param', data: 'Open: OSM, OpenAddresses, GeoNames and others aggregated', oss: 'No (open data, permissive storage terms)', limits: 'Free trial 2,500/day at 1 req/s, paid plans', precision: '<code>confidence</code> 1–10 (bbox size), <code>components._type</code>' },
    build(mode, input, opt, cfg) {
      const base = 'https://api.opencagedata.com/geocode/v1/json';
      const common = { key: cfg.key, language: opt.lang, no_annotations: 1 };
      if (mode === 'forward') {
        return {
          url: `${base}?` + qs({
            q: input.text, ...common, limit: opt.limit, countrycode: opt.country?.toLowerCase(),
            proximity: opt.bias ? `${opt.bias.lat},${opt.bias.lng}` : '',
          }),
        };
      }
      return { url: `${base}?` + qs({ q: `${input.lat},${input.lng}`, ...common, limit: 1 }) };
    },
    parse(json) {
      if (json?.status && json.status.code !== 200) throw new Error(`${json.status.code}: ${json.status.message}`);
      return (json.results || []).map((r) => {
        const c = r.components || {};
        const t = c._type;
        let tier;
        if (c.house_number || t === 'building') tier = 'rooftop';
        else if (t === 'road') tier = 'street';
        else tier = tierFromType(t) || (['state_district'].includes(t) ? 'region' : ['postcode', 'municipality'].includes(t) ? 'locality' : c._category && t ? 'rooftop' : 'other');
        return {
          lat: r.geometry?.lat, lng: r.geometry?.lng, label: r.formatted, type: t, tier,
          providerConfidence: r.confidence != null ? `confidence ${r.confidence}/10` : '', raw: r,
        };
      });
    },
  };

  // ---------------------------------------------------------------- Geoapify
  const geoapify = {
    id: 'geoapify',
    name: 'Geoapify',
    letter: 'Ga',
    slot: 3,
    hollow: true,
    needsKey: true,
    keyLabel: 'API key',
    keyPlaceholder: 'API key',
    docs: 'https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/',
    signup: 'https://myprojects.geoapify.com/',
    about: { endpoint: '<code>/v1/geocode/search</code>, <code>/reverse</code>', auth: '<code>apiKey</code> param', data: 'Open: OSM, OpenAddresses, Who’s On First…', oss: 'No (open data, storage allowed)', limits: 'Free 3,000 credits/day, then paid', precision: '<code>result_type</code>, <code>rank.confidence</code> 0–1, <code>rank.match_type</code>' },
    build(mode, input, opt, cfg) {
      const base = 'https://api.geoapify.com/v1/geocode';
      const common = { apiKey: cfg.key, lang: opt.lang, format: 'json', limit: opt.limit };
      if (mode === 'forward') {
        return {
          url: `${base}/search?` + qs({
            text: input.text, ...common, filter: opt.country ? `countrycode:${opt.country.toLowerCase()}` : '',
            bias: opt.bias ? `proximity:${opt.bias.lng},${opt.bias.lat}` : '',
          }),
        };
      }
      return { url: `${base}/reverse?` + qs({ lat: input.lat, lon: input.lng, ...common }) };
    },
    parse(json) {
      if (json?.error || json?.statusCode >= 400) throw new Error(`${json.statusCode || ''} ${json.message || json.error}`.trim());
      return (json.results || []).map((r) => {
        const t = r.result_type;
        let tier;
        if (t === 'building' || t === 'amenity') tier = 'rooftop';
        else if (t === 'street') tier = r.housenumber ? 'interpolated' : 'street';
        else if (['suburb', 'city', 'postcode', 'district'].includes(t)) tier = 'locality';
        else tier = tierFromType(t) || 'other';
        return {
          lat: r.lat, lng: r.lon, label: r.formatted, type: t, tier,
          providerConfidence: [r.rank?.confidence != null ? `conf ${Number(r.rank.confidence).toFixed(2)}` : '', r.rank?.match_type].filter(Boolean).join(' · '),
          raw: r,
        };
      });
    },
  };

  // ---------------------------------------------------------------- LocationIQ
  const locationiq = {
    id: 'locationiq',
    name: 'LocationIQ',
    letter: 'LQ',
    slot: 4,
    hollow: true,
    needsKey: true,
    keyLabel: 'Access token',
    keyPlaceholder: 'pk.…',
    hasBaseUrl: true,
    defaultBaseUrl: 'https://us1.locationiq.com/v1',
    minIntervalMs: 520,
    docs: 'https://docs.locationiq.com/reference/search',
    signup: 'https://locationiq.com/register',
    about: { endpoint: '<code>/v1/search</code>, <code>/v1/reverse</code> (Nominatim-compatible)', auth: '<code>key</code> param', data: 'OpenStreetMap + other open data', oss: 'No (hosted Nominatim-style)', limits: 'Free 5,000/day at 2 req/s, then paid', precision: '<code>class/type</code>, <code>importance</code>' },
    build(mode, input, opt, cfg) {
      const base = (cfg.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
      const common = { key: cfg.key, format: 'json', addressdetails: 1, 'accept-language': opt.lang };
      if (mode === 'forward') {
        let viewbox;
        if (opt.bias) {
          const d = 0.5;
          viewbox = [opt.bias.lng - d, opt.bias.lat + d, opt.bias.lng + d, opt.bias.lat - d].map((n) => n.toFixed(5)).join(',');
        }
        return { url: `${base}/search?` + qs({ q: input.text, limit: opt.limit, countrycodes: opt.country?.toLowerCase(), viewbox, ...common }) };
      }
      return { url: `${base}/reverse?` + qs({ lat: input.lat, lon: input.lng, ...common }) };
    },
    parse: parseNominatimLike,
  };

  // ---------------------------------------------------------------- MapTiler
  const maptiler = {
    id: 'maptiler',
    name: 'MapTiler',
    letter: 'MT',
    slot: 5,
    hollow: true,
    needsKey: true,
    keyLabel: 'API key',
    keyPlaceholder: 'API key',
    docs: 'https://docs.maptiler.com/cloud/api/geocoding/',
    signup: 'https://cloud.maptiler.com/account/keys/',
    about: { endpoint: '<code>/geocoding/{query}.json</code>, <code>/geocoding/{lng},{lat}.json</code>', auth: '<code>key</code> param', data: 'OpenStreetMap + open/authoritative data', oss: 'No', limits: 'Free tier (non-commercial), then paid', precision: '<code>place_type</code>, <code>relevance</code> 0–1' },
    build(mode, input, opt, cfg) {
      const base = 'https://api.maptiler.com/geocoding';
      if (mode === 'forward') {
        return {
          url: `${base}/${encodeURIComponent(input.text)}.json?` + qs({
            key: cfg.key, limit: opt.limit, country: opt.country?.toLowerCase(), language: opt.lang,
            proximity: opt.bias ? `${opt.bias.lng},${opt.bias.lat}` : '',
          }),
        };
      }
      return { url: `${base}/${input.lng},${input.lat}.json?` + qs({ key: cfg.key, language: opt.lang }) };
    },
    parse(json) {
      if (json?.message && !json.features) throw new Error(json.message);
      return (json.features || []).map((f) => {
        const t = f.place_type?.[0];
        let tier;
        if (t === 'address' || t === 'poi') tier = 'rooftop';
        else if (t === 'road' || t === 'street') tier = 'street';
        else if (['municipality', 'municipal_district', 'locality', 'neighbourhood', 'place', 'postal_code'].includes(t)) tier = 'locality';
        else if (['county', 'region', 'subregion', 'joint_municipality', 'joint_submunicipality'].includes(t)) tier = 'region';
        else tier = tierFromType(t) || 'other';
        return {
          lat: f.center?.[1] ?? f.geometry?.coordinates?.[1], lng: f.center?.[0] ?? f.geometry?.coordinates?.[0],
          label: f.place_name || f.text, type: t, tier,
          providerConfidence: f.relevance != null ? `relevance ${Number(f.relevance).toFixed(2)}` : '', raw: f,
        };
      });
    },
  };

  window.GEO = { PROVIDERS: [radar, pelias, nominatim, google, mapbox, here, tomtom, esri, azure, opencage, geoapify, locationiq, maptiler], TIERS };
})();
