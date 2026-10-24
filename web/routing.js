// web/routing.js — plain ORS route + closure crossing check
const PROXY_URL = 'https://ors-proxy.jess-jm-zhang.workers.dev';
const CLOSURE_BUFFER_M = 15;
const BLOCKING = new Set(['closed']);   // 'detour' = passable via posted detour
const POSSIBLE = new Set(['reduced']);  // lanes reduced: street may still be passable -> softer warning

// Live CURRENT/FUTURE/PAST from the closure's UTC window and the viewer's clock.
// Closures without window fields (Calgary) keep their baked-in status.
function temporalStatus(p, now = Date.now()) {
  if (p.window_start_utc && p.window_end_utc) {
    const s = Date.parse(p.window_start_utc), e = Date.parse(p.window_end_utc);
    if (!isNaN(s) && !isNaN(e)) return now < s ? 'FUTURE' : now >= e ? 'PAST' : 'CURRENT';
  }
  return p.calgary_temporal_status;
}

// Re-stamps windowed features in place. Returns true if any status changed
// (caller should then map.getSource('closures').setData(closures)).
function refreshTemporal(closures, now = Date.now()) {
  let changed = false;
  for (const f of closures.features) {
    const p = f.properties || {};
    if (!p.window_start_utc) continue;
    const t = temporalStatus(p, now);
    if (p.calgary_temporal_status !== t) {
      p.calgary_temporal_status = t;
      p.temporal_status = t;
      changed = true;
    }
  }
  return changed;
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: CITY.timezone });
}

function closureInfo(p) {
  const note = p.detour_note || '';
  const i = note.indexOf(' \u2014 ');
  const t = temporalStatus(p);
  const active = t !== 'FUTURE' && t !== 'PAST';   // conservative: a missing field still warns
  return {
    kind: BLOCKING.has(p.status) ? 'closed' : POSSIBLE.has(p.status) ? 'reduced' : null,
    name: (i > -1 ? note.slice(0, i) : note) || 'Unnamed closure',
    text: i > -1 ? note.slice(i + 3) : '',
    blocking: BLOCKING.has(p.status) && active,   // full closure right now
    possible: POSSIBLE.has(p.status) && active,   // lane restriction right now
    pastEndDate: !!p.end_date && p.end_date < todayLocal(),
  };
}

// Buffer every closed/reduced feature once. Whether it counts is decided per
// call from the live clock, so the cache never goes stale as time passes.
let _cache = { src: null, items: [] };
function bufferedClosures(closures) {
  if (_cache.src === closures) return _cache.items;
  const items = [];
  for (const feature of closures.features) {
    const st = (feature.properties || {}).status;
    if (!BLOCKING.has(st) && !POSSIBLE.has(st)) continue;
    const buf = turf.buffer(feature, CLOSURE_BUFFER_M / 1000, { units: 'kilometers' });
    if (buf) items.push({ buf, feature });
  }
  _cache = { src: closures, items };
  return items;
}

// Returns [{feature, info}] for every closure or lane restriction the route
// touches right now. info.kind is 'closed' or 'reduced'.
function routeCrossesClosures(route, closures) {
  const hits = [];
  for (const c of bufferedClosures(closures)) {
    const info = closureInfo(c.feature.properties || {});
    if (!info.blocking && !info.possible) continue;
    if (turf.booleanIntersects(route, c.buf)) hits.push({ feature: c.feature, info });
  }
  return hits;
}

async function fetchPlainRoutes(start, end) {   // [lng, lat] each
  const r = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: [start, end] }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch (_) {}
    throw new Error(`Route service ${r.status} ${detail}`.trim());
  }
  const fc = await r.json();
  if (!fc.features?.length) throw new Error('No route found');
  return fc.features.slice(0, 3);
}