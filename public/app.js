/* Geocoder Compare — main application. */
(function () {
  'use strict';

  const { PROVIDERS, TIERS } = window.GEO;
  const SAMPLES = window.SAMPLES;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
  const TIER_BY_ID = Object.fromEntries(TIERS.map((t) => [t.id, t]));
  const ERROR_BINS = [
    { id: 'b1', label: '≤ 50 m', max: 50 },
    { id: 'b2', label: '50–250 m', max: 250 },
    { id: 'b3', label: '250 m–1 km', max: 1000 },
    { id: 'b4', label: '1–10 km', max: 10000 },
    { id: 'b5', label: '> 10 km', max: Infinity },
    { id: 'none', label: 'No result / error' },
  ];

  // ------------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
  };

  // ------------------------------------------------------------------ state
  const state = {
    cfg: Object.fromEntries(PROVIDERS.map((p) => [p.id, { enabled: true, key: '', baseUrl: '' }])),
    remember: store.get('gc.remember', false),
    history: [],
    current: null,
    report: null,
    batchAbort: false,
    lastCall: {},
  };
  if (state.remember) {
    const saved = store.get('gc.cfg', null);
    if (saved) for (const id of Object.keys(state.cfg)) Object.assign(state.cfg[id], saved[id] || {});
  }

  // ------------------------------------------------------------------ utils
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = (id) => getComputedStyle(document.documentElement).getPropertyValue(`--s-${id}`).trim() || '#888';
  /** Provider identity glyph: slot colour + letter code; providers past slot 8 reuse a hue as a hollow ring. */
  function pin(id, size = 'sm', text) {
    const p = byId[id];
    const t = text ?? p.letter;
    return `<span class="pin ${size}${p.hollow ? ' hollow' : ''}${String(t).length > 1 ? ' two' : ''}" style="--c:var(--s-${id})">${t}</span>`;
  }
  // Map each provider to its categorical slot.
  (function injectProviderColors() {
    const st = document.createElement('style');
    st.textContent = `:root{${PROVIDERS.map((p) => `--s-${p.id}:var(--c${p.slot});`).join('')}}`;
    document.head.appendChild(st);
  })();

  function haversine(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return null;
    const R = 6371008.8, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function median(arr) {
    const a = arr.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function quantile(arr, q) {
    const a = arr.filter((x) => x != null).sort((x, y) => x - y);
    if (!a.length) return null;
    const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  const mean = (arr) => { const a = arr.filter((x) => x != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
  function fmtDist(m) {
    if (m == null) return '—';
    if (m < 1000) return `${Math.round(m)} m`;
    if (m < 100000) return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
    return `${Math.round(m / 1000).toLocaleString()} km`;
  }
  const fmtMs = (ms) => (ms == null ? '—' : `${Math.round(ms)} ms`);
  const fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  function parseLatLng(s) {
    const m = String(s || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }
  function redact(url) {
    return url.replace(/([?&](?:key|access_token|api_key|email)=)[^&]+/g, '$1•••');
  }
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function persistCfg() {
    if (state.remember) store.set('gc.cfg', state.cfg); else store.del('gc.cfg');
  }

  // ------------------------------------------------------------------ provider calls
  function readOptions() {
    const limit = Math.max(1, Math.min(10, Number($('#optLimit').value) || 5));
    const bias = $('#optBias').checked && map ? map.getCenter() : null;
    return {
      limit,
      country: $('#optCountry').value.trim(),
      lang: $('#optLang').value.trim(),
      timeoutMs: Math.max(3, Number($('#optTimeout').value) || 15) * 1000,
      bias: bias ? { lat: +bias.lat.toFixed(5), lng: +bias.lng.toFixed(5) } : null,
    };
  }

  /** Why a provider can't be called right now, or null if it can. */
  function skipReason(p) {
    const c = state.cfg[p.id];
    if (!c.enabled) return 'disabled';
    if (p.needsKey && !c.key) return 'no key';
    if (p.id === 'pelias' && !c.key && (!c.baseUrl || c.baseUrl === p.defaultBaseUrl)) return 'no key';
    return null;
  }

  async function callProvider(p, mode, input, opt) {
    const cfg = state.cfg[p.id];
    if (p.minIntervalMs) {
      // Serialize calls for rate-limited providers (Nominatim: 1 req/s).
      const prev = state.lastCall[p.id] || Promise.resolve(0);
      let release;
      state.lastCall[p.id] = new Promise((r) => (release = r));
      const last = await prev;
      const wait = last + p.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      setTimeout(() => release(Date.now()), 0);
    }
    const req = p.build(mode, input, opt, cfg);
    const out = { provider: p.id, ok: false, error: null, httpStatus: null, latency: null, results: [], url: redact(req.url), raw: null };
    const useProxy = $('#useProxy').checked;
    const url = useProxy ? `/api/proxy?url=${encodeURIComponent(req.url)}` : req.url;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { headers: req.headers || {}, signal: ctrl.signal, referrerPolicy: 'origin' });
      const text = await res.text();
      out.latency = performance.now() - t0;
      out.httpStatus = res.status;
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: non-JSON response${text ? ' — ' + text.slice(0, 120) : ''}`); }
      out.raw = json;
      const parsed = p.parse(json); // throws with provider's own message on API errors
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out.results = parsed.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)).slice(0, opt.limit);
      out.ok = true;
    } catch (e) {
      if (out.latency == null) out.latency = performance.now() - t0;
      if (e.name === 'AbortError') out.error = `Timed out after ${opt.timeoutMs / 1000}s`;
      else if (e instanceof TypeError) out.error = 'Network/CORS error — check the key’s domain restrictions, or enable “Route via same-origin proxy”.';
      else out.error = e.message;
      if (out.httpStatus && !/HTTP/.test(out.error)) out.error = `HTTP ${out.httpStatus} · ${out.error}`;
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  async function runQuery(mode, input, ref, opt, providerIds) {
    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
      ts: new Date().toISOString(),
      mode, input, ref: ref || null, opts: { ...opt },
      query: mode === 'forward' ? input.text : `${input.lat}, ${input.lng}`,
      responses: {},
    };
    const targets = PROVIDERS.filter((p) => providerIds.includes(p.id));
    await Promise.all(targets.map(async (p) => {
      const why = skipReason(p);
      entry.responses[p.id] = why ? { provider: p.id, skipped: why, results: [] } : await callProvider(p, mode, input, opt);
    }));
    computeMetrics(entry);
    return entry;
  }

  /** Per-provider error vs. reference (or vs. leave-one-out consensus / query point). */
  function computeMetrics(entry) {
    const tops = {};
    for (const [id, r] of Object.entries(entry.responses)) if (r.results?.length) tops[id] = r.results[0];
    const ids = Object.keys(tops);
    const consensusOf = (excl) => {
      const pts = ids.filter((i) => i !== excl).map((i) => tops[i]);
      if (pts.length < 2) return null;
      return { lat: median(pts.map((p) => p.lat)), lng: median(pts.map((p) => p.lng)) };
    };
    entry.consensus = ids.length >= 2 ? { lat: median(ids.map((i) => tops[i].lat)), lng: median(ids.map((i) => tops[i].lng)) } : null;
    let spread = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) spread = Math.max(spread, haversine(tops[ids[i]], tops[ids[j]]));
    entry.spread = ids.length >= 2 ? spread : null;
    for (const [id, r] of Object.entries(entry.responses)) {
      for (const res of r.results || []) {
        if (entry.mode === 'reverse') { res.dist = haversine(entry.input, res); res.basis = 'query point'; }
        else if (entry.ref) { res.dist = haversine(entry.ref, res); res.basis = 'reference'; }
        else { const c = consensusOf(id); res.dist = c ? haversine(c, res) : null; res.basis = 'consensus'; }
      }
      const top = r.results?.[0];
      r.errorM = top ? top.dist : null;
      r.basis = top ? top.basis : null;
      r.tier = top ? top.tier : null;
    }
  }

  // ------------------------------------------------------------------ sidebar
  function keyState(p) {
    const c = state.cfg[p.id];
    const peliasHosted = p.id === 'pelias' && (!c.baseUrl || c.baseUrl === p.defaultBaseUrl);
    if (!c.key && (p.needsKey || peliasHosted)) return '<span class="ks need">needs key</span>';
    if (!c.key) return '<span class="ks free">keyless</span>';
    return '<span class="ks set">key set</span>';
  }

  function renderKeyPanel() {
    $('#providerKeys').innerHTML = PROVIDERS.map((p) => {
      const c = state.cfg[p.id];
      return `
      <details class="pkey" data-pid="${p.id}" ${c.key || c.baseUrl ? 'open' : ''}>
        <summary class="pkey-head">
          <input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''} aria-label="Include ${esc(p.name)}">
          ${pin(p.id, 'sm')}
          <strong title="${esc(p.subtitle || p.name)}">${esc(p.name)}</strong>
          <span class="pkey-status" data-status>${keyState(p)}</span>
        </summary>
        <div class="pkey-row">
          <input type="password" data-f="key" value="${esc(c.key)}" placeholder="${esc(p.keyPlaceholder)}" aria-label="${esc(p.name)} ${esc(p.keyLabel)}" autocomplete="off" spellcheck="false">
          <button class="ghost small" data-act="show" title="Show/hide">👁</button>
          <button class="ghost small" data-act="test" title="Send one test request">Test</button>
        </div>
        <div class="hint">${esc(p.keyLabel)} · <a href="${p.signup}" target="_blank" rel="noopener">get one</a> · <a href="${p.docs}" target="_blank" rel="noopener">docs</a></div>
        ${p.hasBaseUrl ? `<input type="url" data-f="baseUrl" value="${esc(c.baseUrl)}" placeholder="${esc(p.defaultBaseUrl)}" aria-label="${esc(p.name)} base URL" class="base">` : ''}
      </details>`;
    }).join('');
    $('#rememberKeys').checked = state.remember;
  }

  function bindKeyPanel() {
    $('#providerKeys').addEventListener('input', (e) => {
      const box = e.target.closest('.pkey'); if (!box) return;
      const f = e.target.dataset.f; if (!f) return;
      state.cfg[box.dataset.pid][f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
      persistCfg();
      if (f !== 'enabled') $('[data-status]', box).innerHTML = keyState(byId[box.dataset.pid]);
      renderBatchProviders();
    });
    $('#providerKeys').addEventListener('click', (e) => {
      if (e.target.matches('summary input[type=checkbox]')) e.stopPropagation();
    }, true);
    $('#providerKeys').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      const box = btn.closest('.pkey'); const p = byId[box.dataset.pid];
      if (btn.dataset.act === 'show') {
        const inp = $('input[data-f=key]', box); inp.type = inp.type === 'password' ? 'text' : 'password';
      } else if (btn.dataset.act === 'test') {
        const st = $('[data-status]', box);
        const why = skipReason(p);
        if (why && why !== 'disabled') { st.className = 'pkey-status bad'; st.textContent = why; return; }
        st.className = 'pkey-status'; st.textContent = '…';
        const r = await callProvider(p, 'forward', { text: 'Eiffel Tower, Paris' }, { ...readOptions(), country: '', bias: null, limit: 1 });
        if (r.ok) { st.className = 'pkey-status good'; st.textContent = `✓ ${fmtMs(r.latency)}`; }
        else { st.className = 'pkey-status bad'; st.textContent = '✕ failed'; st.title = r.error; toast(`${p.name}: ${r.error}`, 6000); }
      }
    });
    $('#rememberKeys').addEventListener('change', (e) => {
      state.remember = e.target.checked; store.set('gc.remember', state.remember); persistCfg();
      toast(state.remember ? 'Keys will be remembered on this device' : 'Keys will not be saved');
    });
    $('#clearKeys').addEventListener('click', () => {
      store.del('gc.cfg');
      for (const c of Object.values(state.cfg)) { c.key = ''; c.baseUrl = ''; }
      renderKeyPanel(); toast('Saved keys cleared');
    });
    const toggleSidebar = () => { document.body.classList.toggle('sidebar-collapsed'); setTimeout(() => map.invalidateSize(), 50); };
    $('#toggleSidebar').addEventListener('click', toggleSidebar);
    $('#keysBtn').addEventListener('click', toggleSidebar);
  }

  // ------------------------------------------------------------------ map
  let map, layers = {};
  function initMap() {
    map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([30, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    for (const p of PROVIDERS) layers[p.id] = L.layerGroup().addTo(map);
    layers.ref = L.layerGroup().addTo(map);
    layers.lines = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      const ll = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
      if (currentMode() === 'reverse') { $('#query').value = ll; doSearch(); }
      else { $('#refPoint').value = ll; toast('Reference point set from map click'); if (state.current) { state.current.ref = parseLatLng(ll); computeMetrics(state.current); renderEntry(state.current); } }
    });
    renderLegend();
  }

  function renderLegend(entry) {
    $('#mapLegend').innerHTML = PROVIDERS.map((p) => {
      const r = entry?.responses?.[p.id];
      const off = !r || !r.results?.length;
      return `<label class="lgd ${off ? 'off' : ''}"><input type="checkbox" data-layer="${p.id}" ${map.hasLayer(layers[p.id]) ? 'checked' : ''}>
        ${pin(p.id, 'sm')}${esc(p.name)}</label>`;
    }).join('') + '<span class="lgd"><span class="pin sm ref">★</span>Reference</span>';
  }

  function pinIcon(p, idx) {
    const top = idx === 0;
    return L.divIcon({
      className: '',
      html: pin(p.id, top ? 'lg' : 'sm alt', top ? p.letter : idx + 1),
      iconSize: top ? [26, 26] : [18, 18],
      iconAnchor: top ? [13, 13] : [9, 9],
    });
  }

  function drawMap(entry) {
    Object.values(layers).forEach((l) => l.clearLayers());
    const bounds = [];
    const showAll = $('#showAll').checked, showLines = $('#showLines').checked;
    const anchor = entry.mode === 'reverse' ? entry.input : entry.ref;
    if (anchor) {
      L.marker([anchor.lat, anchor.lng], {
        icon: L.divIcon({ className: '', html: '<span class="pin lg ref">★</span>', iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: 1000,
      }).bindPopup(`<strong>${entry.mode === 'reverse' ? 'Query point' : 'Reference'}</strong><br>${anchor.lat.toFixed(6)}, ${anchor.lng.toFixed(6)}`).addTo(layers.ref);
      bounds.push([anchor.lat, anchor.lng]);
    } else if (entry.consensus) {
      L.circleMarker([entry.consensus.lat, entry.consensus.lng], { radius: 6, color: '#898781', weight: 2, dashArray: '3 3', fill: false })
        .bindTooltip('Consensus (median of top results)').addTo(layers.ref);
    }
    for (const p of PROVIDERS) {
      const r = entry.responses[p.id];
      if (!r?.results?.length) continue;
      r.results.forEach((res, i) => {
        if (i > 0 && !showAll) return;
        const m = L.marker([res.lat, res.lng], { icon: pinIcon(p, i), zIndexOffset: i === 0 ? 500 : 0, riseOnHover: true })
          .bindPopup(popupHtml(p, res, i))
          .addTo(layers[p.id]);
        res._marker = m;
        bounds.push([res.lat, res.lng]);
      });
      const top = r.results[0];
      if (showLines && anchor) {
        L.polyline([[anchor.lat, anchor.lng], [top.lat, top.lng]], { color: color(p.id), weight: 2, dashArray: p.hollow ? '1 5' : '5 4', lineCap: 'round', opacity: 0.9 }).addTo(layers.lines);
      }
    }
    if (bounds.length === 1) map.setView(bounds[0], 15);
    else if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    renderLegend(entry);
  }

  function popupHtml(p, res, i) {
    return `<div class="pop"><div class="pop-h">${pin(p.id)}<strong>${esc(p.name)}</strong> #${i + 1}</div>
      <div>${esc(res.label)}</div>
      <div class="hint">${res.lat.toFixed(6)}, ${res.lng.toFixed(6)}</div>
      <div class="hint">${esc(TIER_BY_ID[res.tier]?.label || res.tier)}${res.type ? ` · ${esc(res.type)}` : ''}${res.providerConfidence ? ` · ${esc(res.providerConfidence)}` : ''}</div>
      ${res.dist != null ? `<div><strong>${fmtDist(res.dist)}</strong> from ${esc(res.basis)}</div>` : ''}</div>`;
  }

  // ------------------------------------------------------------------ search tab
  const currentMode = () => $('input[name=mode]:checked').value;

  const EXAMPLES = {
    forward: ['1600 Pennsylvania Ave NW, Washington DC', 'Eiffel Tower', '10 Downing St, London', '東京タワー', 'Springfield', '1600 Pensylvania Av Washingtn'],
    reverse: ['40.7484, -73.9857', '51.5007, -0.1246', '35.6595, 139.7005', '-33.8688, 151.2093'],
  };
  function renderExamples() {
    const mode = currentMode();
    $('#examples').innerHTML = '<span class="hint">Try:</span>' + EXAMPLES[mode].map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('') +
      `<span class="hint">${mode === 'reverse' ? '· or click the map' : '· click the map to set a reference point'}</span>`;
    $('#query').placeholder = mode === 'reverse' ? 'lat, lng — e.g. 40.7484, -73.9857 (or click the map)' : 'Address, place or POI… e.g. 1600 Pennsylvania Ave NW, Washington DC';
    $('#refPoint').hidden = mode === 'reverse';
  }

  async function doSearch() {
    const mode = currentMode();
    const raw = $('#query').value.trim();
    if (!raw) { $('#query').focus(); return; }
    let input;
    if (mode === 'reverse') {
      input = parseLatLng(raw);
      if (!input) { toast('Reverse mode needs “lat, lng”'); return; }
    } else input = { text: raw };
    const refRaw = $('#refPoint').value.trim();
    const ref = mode === 'forward' && refRaw ? parseLatLng(refRaw) : null;
    if (refRaw && mode === 'forward' && !ref) { toast('Reference must be “lat, lng”'); return; }
    const ids = PROVIDERS.map((p) => p.id);
    const runnable = PROVIDERS.filter((p) => !skipReason(p));
    if (!runnable.length) { toast('Enable at least one provider (OpenStreetMap works without a key)'); return; }

    const btn = $('#searchBtn'); btn.disabled = true; btn.textContent = 'Geocoding…';
    renderLoading(ids);
    try {
      const entry = await runQuery(mode, input, ref, readOptions(), ids);
      state.history.push(entry);
      state.current = entry;
      renderEntry(entry);
      try { history.replaceState(null, '', `?${new URLSearchParams({ mode, q: raw, ...(refRaw && mode === 'forward' ? { ref: refRaw } : {}) })}`); } catch { /* ignore */ }
    } finally {
      btn.disabled = false; btn.textContent = 'Geocode';
    }
  }

  function skippedCard(list) {
    if (!list.length) return '';
    return `<article class="card muted skipped"><header><h3>Not included (${list.length})</h3></header>
      <p class="pad">${list.map(([id, why]) => `<span class="skip-item" data-tip="${esc(`${byId[id].name}: ${why}`)}">${pin(id)} ${esc(byId[id].name)}</span>`).join('')}</p>
      <p class="hint pad">Open <strong>⚙ Keys</strong> to add keys for these providers.</p></article>`;
  }

  function renderLoading(ids) {
    $('#summaryStrip').innerHTML = '';
    const skipped = ids.map((id) => [id, skipReason(byId[id])]).filter(([, w]) => w);
    $('#resultCards').innerHTML = ids.filter((id) => !skipReason(byId[id])).map((id) => `<article class="card loading">
        <header>${pin(id, 'md')}<h3>${esc(byId[id].name)}</h3><span class="badge"><span class="spin"></span></span></header></article>`).join('') + skippedCard(skipped);
  }

  function renderEntry(entry) {
    state.current = entry;
    drawMap(entry);
    renderSummary(entry);
    renderCards(entry);
    renderMatrix(entry);
  }

  function renderSummary(entry) {
    const resp = Object.values(entry.responses).filter((r) => !r.skipped);
    const ok = resp.filter((r) => r.results?.length);
    const fastest = resp.filter((r) => r.ok).sort((a, b) => a.latency - b.latency)[0];
    const best = ok.filter((r) => r.errorM != null).sort((a, b) => a.errorM - b.errorM)[0];
    const basis = entry.mode === 'reverse' ? 'query point' : entry.ref ? 'reference' : 'consensus of others';
    const tiles = [
      ['Providers answered', `${ok.length}/${resp.length}`],
      ['Fastest', fastest ? `${byId[fastest.provider].name} · ${fmtMs(fastest.latency)}` : '—'],
      [`Closest to ${basis}`, best ? `${byId[best.provider].name} · ${fmtDist(best.errorM)}` : '—'],
      ['Max disagreement', entry.spread != null ? fmtDist(entry.spread) : '—'],
    ];
    $('#summaryStrip').innerHTML = tiles.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  }

  function renderCards(entry) {
    const skipped = PROVIDERS.filter((p) => entry.responses[p.id]?.skipped).map((p) => [p.id, entry.responses[p.id].skipped]);
    $('#resultCards').innerHTML = PROVIDERS.map((p) => {
      const r = entry.responses[p.id];
      if (!r || r.skipped) return '';
      const status = r.ok ? (r.results.length ? `<span class="badge good">✓ ${r.results.length}</span>` : '<span class="badge warn">0 results</span>') : '<span class="badge bad">error</span>';
      const list = r.results.map((res, i) => `
        <li data-pid="${p.id}" data-i="${i}" tabindex="0">
          <span class="idx">${i + 1}</span>
          <div class="res-main">
            <div class="res-label">${esc(res.label)}</div>
            <div class="res-meta"><span class="tier t-${res.tier}">${esc(TIER_BY_ID[res.tier]?.label || res.tier)}</span>
              ${res.type ? `<span>${esc(res.type)}</span>` : ''}
              ${res.providerConfidence ? `<span>${esc(res.providerConfidence)}</span>` : ''}
              <span class="mono">${res.lat.toFixed(5)}, ${res.lng.toFixed(5)}</span></div>
          </div>
          <span class="dist" data-tip="Distance from ${esc(res.basis || '')}">${fmtDist(res.dist)}</span>
        </li>`).join('');
      return `<article class="card">
        <header>${pin(p.id, 'md')}<h3>${esc(p.name)}</h3>
          <span class="lat" data-tip="Round-trip time measured in your browser">${fmtMs(r.latency)}</span>${status}</header>
        ${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}
        ${list ? `<ol class="res">${list}</ol>` : ''}
        <details class="raw"><summary>Request &amp; raw response</summary>
          <div class="mono url">${esc(r.url)}</div>
          <pre data-raw="${p.id}"></pre></details>
      </article>`;
    }).join('') + skippedCard(skipped);
  }

  function bindCards() {
    $('#resultCards').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-pid]');
      if (li) focusResult(li.dataset.pid, Number(li.dataset.i));
    });
    $('#resultCards').addEventListener('keydown', (e) => {
      const li = e.target.closest('li[data-pid]');
      if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusResult(li.dataset.pid, Number(li.dataset.i)); }
    });
    $('#resultCards').addEventListener('toggle', (e) => {
      const pre = $('pre[data-raw]', e.target);
      if (pre && e.target.open && !pre.textContent) {
        const raw = state.current?.responses[pre.dataset.raw]?.raw;
        const s = raw ? JSON.stringify(raw, null, 2) : '(no raw response stored)';
        pre.textContent = s.length > 60000 ? s.slice(0, 60000) + '\n… truncated' : s;
      }
    }, true);
  }

  function focusResult(pid, i) {
    const res = state.current?.responses[pid]?.results[i];
    if (!res) return;
    if (!map.hasLayer(layers[pid])) map.addLayer(layers[pid]);
    map.setView([res.lat, res.lng], Math.max(map.getZoom(), 16));
    res._marker?.openPopup();
    if (window.innerWidth < 900) $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderMatrix(entry) {
    const ids = PROVIDERS.map((p) => p.id).filter((id) => entry.responses[id]?.results?.length);
    const panel = $('#matrixPanel');
    if (ids.length < 2) { panel.hidden = true; return; }
    panel.hidden = false;
    const tops = Object.fromEntries(ids.map((id) => [id, entry.responses[id].results[0]]));
    const anchor = entry.mode === 'reverse' ? entry.input : entry.ref;
    const head = `<tr><th></th>${ids.map((id) => `<th>${pin(id, 'sm')} ${esc(byId[id].name)}</th>`).join('')}${anchor ? `<th>${entry.mode === 'reverse' ? 'Query point' : 'Reference'}</th>` : ''}</tr>`;
    const rows = ids.map((a) => `<tr><th>${pin(a, 'sm')} ${esc(byId[a].name)}</th>${ids.map((b) => {
      if (a === b) return '<td class="diag">—</td>';
      const d = haversine(tops[a], tops[b]);
      return `<td class="${binClass(d)}">${fmtDist(d)}</td>`;
    }).join('')}${anchor ? `<td class="${binClass(haversine(anchor, tops[a]))}"><strong>${fmtDist(haversine(anchor, tops[a]))}</strong></td>` : ''}</tr>`).join('');
    $('#matrix').innerHTML = `<table class="tbl matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function binOf(d) {
    if (d == null) return ERROR_BINS[5];
    return ERROR_BINS.find((b) => b.max != null && d <= b.max);
  }
  const binClass = (d) => `bin-${binOf(d).id}`;

  // ------------------------------------------------------------------ batch tab
  function renderSampleSelect() {
    $('#sampleSet').innerHTML = Object.entries(SAMPLES).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join('');
  }
  function loadSample() {
    const s = SAMPLES[$('#sampleSet').value];
    $('#batchInput').value = s.lines.join('\n');
    $('#batchMode').value = s.mode;
  }
  function renderBatchProviders() {
    $('#batchProviders').innerHTML = PROVIDERS.map((p) => {
      const why = skipReason(p);
      return `<span class="ptoggle ${why ? 'off' : ''}" data-tip="${why ? esc(`${p.name}: ${why} — configure in the sidebar`) : esc(`${p.name} will be included`)}">
        ${pin(p.id, 'sm')}${esc(p.name)}${why ? ` <em>(${esc(why)})</em>` : ''}</span>`;
    }).join('');
  }

  function parseBatch(text, mode) {
    const items = [], bad = [];
    text.split(/\r?\n/).forEach((line, n) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      if (mode === 'reverse') {
        const pt = parseLatLng(l.split('|')[0]);
        if (pt) items.push({ input: pt, ref: null }); else bad.push(n + 1);
      } else {
        const [q, r] = l.split('|').map((s) => s.trim());
        const ref = r ? parseLatLng(r) : null;
        if (r && !ref) bad.push(n + 1);
        items.push({ input: { text: q }, ref });
      }
    });
    return { items, bad };
  }

  async function runBatch() {
    const mode = $('#batchMode').value;
    const { items, bad } = parseBatch($('#batchInput').value, mode);
    if (!items.length) { toast('Add at least one query'); return; }
    if (bad.length) toast(`Skipped unparseable line(s): ${bad.slice(0, 8).join(', ')}`, 5000);
    const ids = PROVIDERS.filter((p) => !skipReason(p)).map((p) => p.id);
    if (!ids.length) { toast('No providers are configured'); return; }
    const opt = readOptions();
    state.batchAbort = false;
    $('#runBatch').disabled = true; $('#stopBatch').disabled = false;
    $('#progressWrap').hidden = false;
    const log = $('#batchLog'); log.innerHTML = '';
    const entries = [];
    const t0 = Date.now();
    for (let i = 0; i < items.length; i++) {
      if (state.batchAbort) break;
      $('#progressBar').style.width = `${(i / items.length) * 100}%`;
      $('#progressText').textContent = `${i}/${items.length} · ${Math.round((Date.now() - t0) / 1000)}s`;
      const e = await runQuery(mode, items[i].input, items[i].ref, opt, ids);
      entries.push(e);
      log.insertAdjacentHTML('afterbegin', `<div class="logline"><span class="mono">${String(i + 1).padStart(3, ' ')}</span> ${esc(e.query)}
        ${ids.map((id) => { const r = e.responses[id]; const s = r.error ? 'bad' : r.results.length ? 'good' : 'warn'; return `<span class="mini ${s}" data-tip="${esc(byId[id].name)}: ${esc(r.error || `${r.results.length} results · ${fmtMs(r.latency)} · ${fmtDist(r.errorM)}`)}">${byId[id].letter}</span>`; }).join('')}</div>`);
    }
    $('#progressBar').style.width = '100%';
    $('#progressText').textContent = `${entries.length}/${items.length} · ${Math.round((Date.now() - t0) / 1000)}s${state.batchAbort ? ' · stopped' : ' · done'}`;
    $('#runBatch').disabled = false; $('#stopBatch').disabled = true;
    if (entries.length) {
      const set = Object.entries(SAMPLES).find(([, s]) => s.lines.join('\n') === $('#batchInput').value.trim());
      state.report = { title: set ? set[1].name : `Custom ${mode} benchmark`, createdAt: new Date().toISOString(), mode, providers: ids, opts: opt, durationMs: Date.now() - t0, entries };
      renderReport();
      switchTab('report');
    }
  }

  // ------------------------------------------------------------------ report
  function aggregate(rep) {
    const out = {};
    for (const id of rep.providers) {
      const rs = rep.entries.map((e) => e.responses[id]).filter(Boolean);
      const called = rs.filter((r) => !r.skipped);
      const okCalls = called.filter((r) => r.ok);
      const withRes = called.filter((r) => r.results?.length);
      const lat = okCalls.map((r) => r.latency);
      const errs = withRes.map((r) => r.errorM).filter((x) => x != null);
      const bins = Object.fromEntries(ERROR_BINS.map((b) => [b.id, 0]));
      for (const r of called) {
        if (!r.results?.length) bins.none++;
        else if (r.errorM != null) bins[binOf(r.errorM).id]++;
      }
      const tiers = Object.fromEntries(TIERS.map((t) => [t.id, 0]));
      for (const r of withRes) tiers[r.tier || 'other']++;
      const firstErr = called.find((r) => r.error)?.error;
      out[id] = {
        id, n: called.length, okN: okCalls.length, resN: withRes.length,
        coverage: called.length ? withRes.length / called.length : null,
        latMed: median(lat), latP95: quantile(lat, 0.95), latMean: mean(lat),
        errMed: median(errs), errMean: mean(errs), errP90: quantile(errs, 0.9), errN: errs.length,
        within250: errs.length ? errs.filter((x) => x <= 250).length / called.length : null,
        within1k: errs.length ? errs.filter((x) => x <= 1000).length / called.length : null,
        bins, tiers, firstErr,
        rooftopShare: withRes.length ? tiers.rooftop / withRes.length : null,
        avgResults: mean(withRes.map((r) => r.results.length)),
        errCount: called.filter((r) => r.error).length,
      };
    }
    return out;
  }

  function basisLabel(rep) {
    if (rep.mode === 'reverse') return 'distance from query point';
    const withRef = rep.entries.filter((e) => e.ref).length;
    if (withRef === rep.entries.length) return 'error vs. known reference';
    if (!withRef) return 'distance from leave-one-out consensus';
    return `vs. reference (${withRef}/${rep.entries.length}) or consensus`;
  }

  function renderReport() {
    const rep = state.report;
    $('#reportEmpty').hidden = !!rep;
    $('#report').hidden = !rep;
    if (!rep) return;
    const agg = aggregate(rep);
    const ids = rep.providers;
    const basis = basisLabel(rep);
    $('#reportTitle').textContent = rep.title;
    $('#reportMeta').textContent = `${new Date(rep.createdAt).toLocaleString()} · ${rep.mode} geocoding · ${rep.entries.length} queries × ${ids.length} providers · accuracy = ${basis}` +
      (rep.opts?.country ? ` · country=${rep.opts.country}` : '') + (rep.opts?.lang ? ` · lang=${rep.opts.lang}` : '');

    const totalReq = ids.reduce((s, id) => s + agg[id].n, 0);
    const totalErr = ids.reduce((s, id) => s + agg[id].errCount, 0);
    const spreads = rep.entries.map((e) => e.spread).filter((x) => x != null);
    $('#kpis').innerHTML = [
      ['Queries', rep.entries.length],
      ['Requests', totalReq.toLocaleString()],
      ['Failed requests', `${totalErr} (${fmtPct(totalReq ? totalErr / totalReq : 0)})`],
      ['Median disagreement', fmtDist(median(spreads))],
      ['Wall time', rep.durationMs ? `${(rep.durationMs / 1000).toFixed(1)} s` : '—'],
    ].map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

    renderFindings(rep, agg, basis);
    renderScorecard(ids, agg, basis);

    const maxP95 = Math.max(1, ...ids.map((id) => agg[id].latP95 || agg[id].latMed || 0));
    barChart($('#chartLatency'), ids.map((id) => ({
      id, value: agg[id].latMed, tick: agg[id].latP95, display: fmtMs(agg[id].latMed),
      tip: `${byId[id].name}: median ${fmtMs(agg[id].latMed)} · mean ${fmtMs(agg[id].latMean)} · p95 ${fmtMs(agg[id].latP95)}`,
    })), maxP95);
    barChart($('#chartCoverage'), ids.map((id) => ({
      id, value: agg[id].coverage, display: fmtPct(agg[id].coverage),
      tip: `${byId[id].name}: ${agg[id].resN}/${agg[id].n} queries returned results · ${agg[id].errCount} errors`,
    })), 1);
    stackedChart($('#chartError'), ids.map((id) => ({
      id, total: agg[id].n,
      segs: ERROR_BINS.map((b) => ({ cls: `bin-${b.id}`, label: b.label, value: agg[id].bins[b.id] })),
    })), ERROR_BINS.map((b) => ({ cls: `bin-${b.id}`, label: b.label })), basis);
    stackedChart($('#chartPrecision'), ids.map((id) => ({
      id, total: agg[id].resN,
      segs: TIERS.map((t) => ({ cls: `tier-${t.id}`, label: t.label, value: agg[id].tiers[t.id] })),
    })), TIERS.map((t) => ({ cls: `tier-${t.id}`, label: t.label })), 'top result precision');
    renderPerQuery(rep);
    $('#methodNote').innerHTML = `<strong>Method.</strong> Every query is sent to all configured providers in parallel from your browser; latency is the full round-trip measured with <code>performance.now()</code> (includes network distance to each provider's edge and, if enabled, the proxy hop). Accuracy uses the <em>top</em> result only. With a reference point, error is the great-circle (haversine) distance to it; without one, each provider is compared with the coordinate-wise median of the other providers' top results (needs ≥ 2 others). Precision tiers are normalized from each API's own fields — Radar <code>layer/confidence</code>, Pelias <code>layer/match_type/accuracy</code>, Nominatim <code>place_rank</code>, Google <code>location_type/types</code>, Mapbox <code>feature_type/coordinates.accuracy</code>. Reference coordinates in the bundled samples are approximate (±30 m). Results vary by region, query style and plan; treat small samples as indicative.`;
  }

  function renderFindings(rep, agg, basis) {
    const ids = rep.providers;
    const f = [];
    const name = (id) => `${pin(id, 'sm')} <strong>${esc(byId[id].name)}</strong>`;
    const pick = (key, dir = 1, filter = () => true) => ids.filter((id) => agg[id][key] != null && filter(id)).sort((a, b) => dir * (agg[a][key] - agg[b][key]));
    const fast = pick('latMed');
    if (fast.length) f.push(`${name(fast[0])} was fastest at a median of ${fmtMs(agg[fast[0]].latMed)}${fast.length > 1 ? `; ${esc(byId[fast[fast.length - 1]].name)} was slowest at ${fmtMs(agg[fast[fast.length - 1]].latMed)}` : ''}.`);
    const acc = pick('errMed', 1, (id) => agg[id].errN >= Math.max(1, rep.entries.length * 0.3));
    if (acc.length) f.push(`${name(acc[0])} had the lowest median positional error (${fmtDist(agg[acc[0]].errMed)}, ${basis}); ${fmtPct(agg[acc[0]].within250)} of its answers were within 250 m.`);
    const cov = pick('coverage', -1);
    if (cov.length) {
      const top = cov.filter((id) => agg[id].coverage === agg[cov[0]].coverage);
      f.push(`${top.map(name).join(', ')} returned a result for ${fmtPct(agg[cov[0]].coverage)} of queries${cov.length > top.length ? `; lowest coverage: ${esc(byId[cov[cov.length - 1]].name)} (${fmtPct(agg[cov[cov.length - 1]].coverage)})` : ''}.`);
    }
    const roof = pick('rooftopShare', -1);
    if (roof.length && rep.mode === 'forward') f.push(`${name(roof[0])} most often returned rooftop/POI-level precision (${fmtPct(agg[roof[0]].rooftopShare)} of answered queries).`);
    const failed = ids.filter((id) => agg[id].errCount).sort((a, b) => agg[b].errCount - agg[a].errCount);
    if (failed.length === 1) f.push(`${name(failed[0])} failed ${agg[failed[0]].errCount} request(s)${agg[failed[0]].firstErr ? ` — e.g. “${esc(agg[failed[0]].firstErr.slice(0, 140))}”` : ''}.`);
    else if (failed.length) f.push(`Failed requests: ${failed.map((id) => `<span data-tip="${esc(agg[id].firstErr || '')}">${esc(byId[id].name)} ${agg[id].errCount}</span>`).join(', ')} (hover for the first error message).`);
    const worst = [...rep.entries].filter((e) => e.spread != null).sort((a, b) => b.spread - a.spread).slice(0, 3);
    if (worst.length && worst[0].spread > 1000) f.push(`Biggest disagreements: ${worst.map((e) => `“${esc(e.query)}” (${fmtDist(e.spread)})`).join(', ')} — good candidates for manual review.`);
    $('#findings').innerHTML = f.map((x) => `<li>${x}</li>`).join('') || '<li>Not enough data for findings.</li>';
  }

  function renderScorecard(ids, agg, basis) {
    const cols = [
      ['Coverage', (a) => fmtPct(a.coverage), 'coverage', -1],
      ['Errors', (a) => a.errCount, 'errCount', 1],
      ['Median latency', (a) => fmtMs(a.latMed), 'latMed', 1],
      ['p95 latency', (a) => fmtMs(a.latP95), 'latP95', 1],
      ['Median error', (a) => fmtDist(a.errMed), 'errMed', 1],
      ['p90 error', (a) => fmtDist(a.errP90), 'errP90', 1],
      ['≤ 250 m', (a) => fmtPct(a.within250), 'within250', -1],
      ['≤ 1 km', (a) => fmtPct(a.within1k), 'within1k', -1],
      ['Rooftop/POI', (a) => fmtPct(a.rooftopShare), 'rooftopShare', -1],
      ['Avg results', (a) => (a.avgResults == null ? '—' : a.avgResults.toFixed(1)), null],
    ];
    const best = {};
    for (const [, , key, dir] of cols) {
      if (!key) continue;
      const vals = ids.map((id) => agg[id][key]).filter((v) => v != null);
      if (vals.length > 1) best[key] = dir > 0 ? Math.min(...vals) : Math.max(...vals);
    }
    $('#scorecard').innerHTML = `<table class="tbl num"><thead><tr><th>Provider</th>${cols.map(([h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>
      ${ids.map((id) => `<tr><th>${pin(id, 'sm')} ${esc(byId[id].name)}</th>
        ${cols.map(([, f, key]) => `<td class="${key && best[key] != null && agg[id][key] === best[key] ? 'best' : ''}">${esc(f(agg[id]))}</td>`).join('')}</tr>`).join('')}
    </tbody></table><p class="hint">Bold = best in column. Error columns: ${esc(basis)}.</p>`;
  }

  function barChart(el, rows, max) {
    el.innerHTML = `<div class="bars">${rows.map((r) => {
      const w = r.value == null ? 0 : Math.max(0.5, (r.value / max) * 100);
      const t = r.tick != null ? (r.tick / max) * 100 : null;
      return `<div class="bar-row" data-tip="${esc(r.tip)}">
        <div class="bar-label">${pin(r.id, 'sm')}${esc(byId[r.id].name)}</div>
        <div class="bar-track"><div class="bar-fill${byId[r.id].hollow ? ' hatch' : ''}" style="width:${w}%;--c:var(--s-${r.id})"></div>${t != null ? `<div class="bar-tick" style="left:${Math.min(100, t)}%"></div>` : ''}</div>
        <div class="bar-val">${esc(r.display)}</div></div>`;
    }).join('')}</div>`;
  }

  function stackedChart(el, rows, legend, what) {
    el.innerHTML = `<div class="legend">${legend.map((l) => `<span><i class="sw ${l.cls}"></i>${esc(l.label)}</span>`).join('')}</div>
      <div class="bars">${rows.map((r) => `<div class="bar-row">
        <div class="bar-label">${pin(r.id, 'sm')}${esc(byId[r.id].name)}</div>
        <div class="bar-track stack">${r.total ? r.segs.filter((s) => s.value).map((s) => `<div class="seg ${s.cls}" style="flex:${s.value}" data-tip="${esc(`${byId[r.id].name} · ${s.label}: ${s.value}/${r.total} (${fmtPct(s.value / r.total)}) — ${what}`)}"></div>`).join('') : ''}</div>
        <div class="bar-val">n=${r.total}</div></div>`).join('')}</div>`;
  }

  function renderPerQuery(rep) {
    const ids = rep.providers;
    const rows = rep.entries.map((e, i) => {
      const errs = ids.map((id) => e.responses[id]?.errorM).filter((x) => x != null);
      const bestErr = errs.length > 1 ? Math.min(...errs) : null;
      return `<tr data-i="${i}" tabindex="0"><td class="q">${esc(e.query)}${e.ref ? ' <span class="hint" data-tip="Has a reference coordinate">★</span>' : ''}</td>
        ${ids.map((id) => {
          const r = e.responses[id];
          if (!r || r.skipped) return '<td class="hint">—</td>';
          if (r.error) return `<td><span class="mini bad" data-tip="${esc(r.error)}">!</span></td>`;
          if (!r.results.length) return '<td><span class="hint">0</span></td>';
          const top = r.results[0];
          return `<td class="${r.errorM === bestErr ? 'best' : ''}" data-tip="${esc(`${byId[id].name}: ${top.label} · ${TIER_BY_ID[top.tier]?.label} · ${fmtMs(r.latency)}`)}"><i class="sw ${binClass(r.errorM)}"></i>${fmtDist(r.errorM)}</td>`;
        }).join('')}
        <td>${fmtDist(e.spread)}</td></tr>`;
    }).join('');
    $('#perQuery').innerHTML = `<table class="tbl num clickable"><thead><tr><th>Query</th>${ids.map((id) => `<th>${pin(id, 'sm')} ${esc(byId[id].name)}</th>`).join('')}<th>Spread</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function openReportRow(i) {
    const e = state.report?.entries[i];
    if (!e) return;
    switchTab('search');
    $(`input[name=mode][value=${e.mode}]`).checked = true;
    renderExamples();
    $('#query').value = e.query;
    $('#refPoint').value = e.ref ? `${e.ref.lat}, ${e.ref.lng}` : '';
    setTimeout(() => renderEntry(e), 50);
  }

  function exportCsv() {
    const rep = state.report; if (!rep) return;
    const head = ['query', 'mode', 'ref_lat', 'ref_lng', 'provider', 'status', 'error', 'http_status', 'latency_ms', 'result_count', 'top_label', 'top_lat', 'top_lng', 'top_type', 'precision_tier', 'provider_confidence', 'distance_m', 'distance_basis', 'request_url'];
    const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head.join(',')];
    for (const e of rep.entries) for (const id of rep.providers) {
      const r = e.responses[id]; if (!r) continue;
      const t = r.results?.[0];
      lines.push([e.query, e.mode, e.ref?.lat, e.ref?.lng, byId[id].name,
        r.skipped ? `skipped:${r.skipped}` : r.error ? 'error' : r.results.length ? 'ok' : 'no_results',
        r.error, r.httpStatus, r.latency != null ? Math.round(r.latency) : '', r.results?.length ?? 0,
        t?.label, t?.lat, t?.lng, t?.type, t?.tier, t?.providerConfidence,
        r.errorM != null ? Math.round(r.errorM) : '', r.basis, r.url].map(q).join(','));
    }
    download(`geocoding-report-${rep.createdAt.slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
  }

  function cleanForExport(rep, keepRaw) {
    return JSON.parse(JSON.stringify(rep, (k, v) => (k === '_marker' || (!keepRaw && k === 'raw') ? undefined : v)));
  }
  function exportJson() {
    const rep = state.report; if (!rep) return;
    download(`geocoding-report-${rep.createdAt.slice(0, 10)}.json`, JSON.stringify({ app: 'geocoder-compare', version: 1, report: cleanForExport(rep, true) }, null, 1), 'application/json');
  }
  function importJson(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        const rep = data.report || data;
        if (!Array.isArray(rep.entries) || !Array.isArray(rep.providers)) throw new Error('not a report file');
        rep.providers = rep.providers.filter((id) => byId[id]);
        rep.entries.forEach(computeMetrics);
        state.report = rep; renderReport(); switchTab('report'); toast('Report imported');
      } catch (e) { toast(`Import failed: ${e.message}`); }
    };
    fr.readAsText(file);
  }

  // ------------------------------------------------------------------ about
  function renderAbout() {
    const cols = [['endpoint', 'Endpoint used'], ['auth', 'Auth'], ['data', 'Data'], ['oss', 'Open source'], ['limits', 'Usage limits to know'], ['precision', 'Precision signal']];
    $('#aboutPanel').innerHTML = `
      <h1>Providers &amp; how this works</h1>
      <p>This tool sends the same query to up to ${PROVIDERS.length} geocoding APIs straight from your browser, plots every result on a Leaflet map and measures latency, coverage, agreement and positional error. It is a static site — there is no backend storing your keys or queries. An optional same-origin proxy (a Cloudflare Pages Function) can relay requests for providers that refuse cross-origin browser calls; it forwards only to the listed provider hosts and logs nothing.</p>
      <div class="table-scroll"><table class="tbl about"><thead><tr><th>Provider</th>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${PROVIDERS.map((p) => `<tr><th>${pin(p.id)} ${esc(p.name)}${p.subtitle ? ` <span class="hint inline">${esc(p.subtitle)}</span>` : ''}</th>${cols.map(([k]) => `<td>${p.about?.[k] || '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="hint">Pricing and limits change — check each provider’s current terms before production use.</p>

      <h2>Getting keys</h2>
      <ul>${PROVIDERS.map((p) => `<li><strong>${esc(p.name)}</strong> — <a href="${p.signup}" target="_blank" rel="noopener">${esc(p.signup.replace(/^https?:\/\//, ''))}</a> · <a href="${p.docs}" target="_blank" rel="noopener">API docs</a></li>`).join('')}</ul>

      <h2>Key safety</h2>
      <ul>
        <li>Prefer restricted, test-only keys. Restrict Google keys to <em>HTTP referrers</em> (add this site’s domain) and to the Geocoding API only; restrict Mapbox tokens to this URL; use Radar <em>publishable</em> keys.</li>
        <li>Keys are kept in memory unless you tick “Remember keys”, which stores them in this browser’s localStorage. Use “Clear saved keys” when done.</li>
        <li>If you enable the proxy, keys transit the proxy (same origin, not logged). Referrer-restricted keys keep working because the proxy forwards your page’s <code>Referer</code>.</li>
      </ul>

      <h2>Reading the results</h2>
      <ul>
        <li><strong>Reference point</strong> — paste a known “lat, lng” (or click the map) to measure absolute error. Benchmarks accept <code>query | lat, lng</code> per line.</li>
        <li><strong>Consensus</strong> — with no reference, each provider is compared against the median of the <em>other</em> providers’ top results, so one outlier can’t drag the baseline toward itself.</li>
        <li><strong>Precision tier</strong> — a normalized level (Rooftop/POI → Interpolated address → Street → Locality/postal → Region → Country) mapped from each provider’s own fields.</li>
        <li><strong>Latency</strong> — browser round-trip, so it reflects your location and network. Compare providers within the same run.</li>
      </ul>

      <h2>Troubleshooting</h2>
      <ul>
        <li><em>Network/CORS error</em>: the key may be restricted to other domains, the API may not be enabled on the key (Google: enable “Geocoding API”), or an ad-blocker may be blocking the host. Try “Route via same-origin proxy”.</li>
        <li><em>Nominatim slow in benchmarks</em>: deliberate — requests are spaced 1.1 s apart to respect the public server’s policy. Point the base URL at your own instance to go faster.</li>
        <li><em>Pelias</em>: defaults to geocode.earth. Set the base URL to your own instance (e.g. <code>https://pelias.example.com/v1</code>); with the proxy enabled only geocode.earth is allowed.</li>
      </ul>`;
  }

  // ------------------------------------------------------------------ tabs, theme, tooltip
  function switchTab(name) {
    $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
    if (name === 'search') setTimeout(() => map.invalidateSize(), 30);
    if (name === 'batch') renderBatchProviders();
  }

  function initTheme() {
    const saved = store.get('gc.theme', null);
    if (saved) document.documentElement.dataset.theme = saved;
    $('#themeBtn').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      const next = dark ? 'light' : 'dark';
      document.documentElement.dataset.theme = next; store.set('gc.theme', next);
      if (state.current) drawMap(state.current);
    });
  }

  function initTooltip() {
    const tip = $('#tip');
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t || !t.dataset.tip) { tip.hidden = true; return; }
      tip.textContent = t.dataset.tip; tip.hidden = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (tip.hidden) return;
      const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > innerWidth - 8) x = e.clientX - w - pad;
      if (y + h > innerHeight - 8) y = e.clientY - h - pad;
      tip.style.transform = `translate(${x}px, ${y}px)`;
    });
    document.addEventListener('scroll', () => (tip.hidden = true), true);
  }

  // ------------------------------------------------------------------ boot
  function init() {
    initTheme();
    renderKeyPanel(); bindKeyPanel();
    initMap();
    renderExamples();
    renderSampleSelect(); loadSample();
    renderBatchProviders();
    renderAbout();
    initTooltip();
    bindCards();

    $$('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); switchTab(g.dataset.goto); } });
    $$('input[name=mode]').forEach((r) => r.addEventListener('change', () => { renderExamples(); $('#query').value = ''; }));
    $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch(); });
    $('#examples').addEventListener('click', (e) => { const c = e.target.closest('[data-q]'); if (c) { $('#query').value = c.dataset.q; doSearch(); } });
    $('#showAll').addEventListener('change', () => state.current && drawMap(state.current));
    $('#showLines').addEventListener('change', () => state.current && drawMap(state.current));
    $('#fitBtn').addEventListener('click', () => state.current && drawMap(state.current));
    $('#mapLegend').addEventListener('change', (e) => {
      const id = e.target.dataset.layer; if (!id) return;
      if (e.target.checked) map.addLayer(layers[id]); else map.removeLayer(layers[id]);
    });

    $('#loadSample').addEventListener('click', loadSample);
    $('#runBatch').addEventListener('click', runBatch);
    $('#stopBatch').addEventListener('click', () => { state.batchAbort = true; toast('Stopping after the current query…'); });
    $('#importJson').addEventListener('change', (e) => e.target.files[0] && importJson(e.target.files[0]));

    $('#exportCsv').addEventListener('click', exportCsv);
    $('#exportJson').addEventListener('click', exportJson);
    $('#printReport').addEventListener('click', () => window.print());
    $('#perQuery').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr) openReportRow(Number(tr.dataset.i)); });
    $('#perQuery').addEventListener('keydown', (e) => { const tr = e.target.closest('tr[data-i]'); if (tr && e.key === 'Enter') openReportRow(Number(tr.dataset.i)); });
    $('#reportFromHistory').addEventListener('click', () => {
      if (!state.history.length) { toast('No searches yet — run a few in the Search tab'); return; }
      const ids = PROVIDERS.map((p) => p.id).filter((id) => state.history.some((e) => e.responses[id] && !e.responses[id].skipped));
      const modes = new Set(state.history.map((e) => e.mode));
      state.report = { title: 'Search history', createdAt: new Date().toISOString(), mode: modes.size === 1 ? [...modes][0] : 'forward', providers: ids, entries: [...state.history] };
      renderReport();
    });

    // Deep link: ?mode=forward&q=...&ref=lat,lng
    const params = new URLSearchParams(location.search);
    if (params.get('q')) {
      const m = params.get('mode') === 'reverse' ? 'reverse' : 'forward';
      $(`input[name=mode][value=${m}]`).checked = true; renderExamples();
      $('#query').value = params.get('q');
      if (params.get('ref')) $('#refPoint').value = params.get('ref');
      doSearch();
    }
  }

  init();
})();
