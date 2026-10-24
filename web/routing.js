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

// ---------- Avoidance routing ----------
const AVOID_BUFFER_M = 20;      // > CLOSURE_BUFFER_M (15) so a route that clears the polygon also passes the check
const AVOID_PAD = { lng: 0.03, lat: 0.02 };   // ~2 km search margin around start/end
const MAX_AVOID_POLYGONS = 40;  // keep equal to the worker
const MAX_AVOID_VERTICES = 4000;

const blockingHits = (route, closures) =>
  routeCrossesClosures(route, closures).filter(h => h.info.blocking);

function buildAvoidPolygons(closures, start, end, { skipLapsed = false } = {}) {
  const box = turf.bboxPolygon([
    Math.min(start[0], end[0]) - AVOID_PAD.lng, Math.min(start[1], end[1]) - AVOID_PAD.lat,
    Math.max(start[0], end[0]) + AVOID_PAD.lng, Math.max(start[1], end[1]) + AVOID_PAD.lat,
  ]);
  const mid = turf.point([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
  const found = [];
  for (const feature of closures.features) {
    const info = closureInfo(feature.properties || {});
    if (!info.blocking) continue;
    if (skipLapsed && info.pastEndDate) continue;
    if (!turf.booleanIntersects(feature, box)) continue;
    let buf = turf.buffer(feature, AVOID_BUFFER_M / 1000, { units: 'kilometers', steps: 4 });
    if (!buf) continue;
    try { buf = turf.simplify(buf, { tolerance: 0.00003, highQuality: false }); } catch (_) {}
    found.push({ buf, d: turf.distance(turf.center(feature), mid) });
  }
  found.sort((a, b) => a.d - b.d);   // nearest the trip first, so truncation drops the far ones

  const polys = [];
  let vertices = 0, truncated = false;
  for (const { buf } of found) {
    const g = buf.geometry;
    const parts = g.type === 'Polygon' ? [g.coordinates]
      : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const part of parts) {
      const n = part.reduce((s, ring) => s + ring.length, 0);
      if (polys.length >= MAX_AVOID_POLYGONS || vertices + n > MAX_AVOID_VERTICES) { truncated = true; continue; }
      polys.push(part);
      vertices += n;
    }
  }
  return { polygons: polys.length ? { type: 'MultiPolygon', coordinates: polys } : null, truncated };
}

async function fetchAvoidingRoutes(start, end, polygons) {
  const r = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: [start, end], avoid_polygons: polygons }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch (_) {}
    throw new Error(`Route service ${r.status} ${detail}`.trim());
  }
  const fc = await r.json();
  if (!fc.features?.length) throw new Error('Route service 404 No route found');
  return fc.features.slice(0, 3);
}

const routeKey = r => `${Math.round(r.properties?.summary?.distance || 0)}:${r.geometry?.coordinates?.length}`;
function uniqueRoutes(list) {
  const seen = new Set();
  return list.filter(r => !seen.has(routeKey(r)) && seen.add(routeKey(r)));
}

// status: 'clear' | 'avoided' | 'lapsed-only' | 'blocked' | 'unverified'
// Fails closed: on 'blocked' / 'unverified' the returned routes are the plain ones, never labelled safe.
async function planSafeRoutes(start, end, closures) {
  const plain = await fetchPlainRoutes(start, end);   // throws -> caller shows its normal error
  const cleanPlain = plain.filter(r => blockingHits(r, closures).length === 0);
  if (plain[0] === cleanPlain[0]) return { status: 'clear', routes: cleanPlain, plain };

  // Attempt 1 avoids every current closure. Attempt 2 ignores closures past their
  // listed end date (the feed doesn't always clear them) and allows those hits, flagged ⚑.
  const attempts = [{ skipLapsed: false, tolerateLapsed: false }, { skipLapsed: true, tolerateLapsed: true }];
  let lastError = null;
  for (const a of attempts) {
    const { polygons, truncated } = buildAvoidPolygons(closures, start, end, { skipLapsed: a.skipLapsed });
    if (!polygons) continue;
    let avoiding;
    try {
      avoiding = await fetchAvoidingRoutes(start, end, polygons);
    } catch (e) {
      lastError = e;
      if (/Route service 404/.test(e.message)) continue;   // no route with this avoid set: try the looser one
      break;                                               // worker/network problem: don't hammer it
    }
    const ok = uniqueRoutes([...cleanPlain, ...avoiding]).filter(r =>
      blockingHits(r, closures).every(h => a.tolerateLapsed && h.info.pastEndDate));
    if (ok.length) {
      return { status: a.tolerateLapsed ? 'lapsed-only' : 'avoided', routes: ok, plain, truncated };
    }
  }
  return lastError && !/Route service 404/.test(lastError.message)
    ? { status: 'unverified', routes: plain, plain, error: lastError }
    : { status: 'blocked', routes: plain, plain };
}

function safeRouteMessage(result) {
  const km = r => ((r.properties?.summary?.distance || 0) / 1000).toFixed(1);
  switch (result.status) {
    case 'avoided':
      return `Rerouted around current closures: ${km(result.routes[0])} km vs ${km(result.plain[0])} km direct.`
        + (result.truncated ? ' Some distant closures were not avoided.' : '');
    case 'lapsed-only':
      return 'Avoids active closures. Remaining ⚑ closures are past their listed end date and may already be cleared.';
    case 'blocked':
      return 'No route found that avoids all current closures. Showing the direct route; red sections are closed.';
    case 'unverified':
      return "Couldn't check for a closure-free route. This route may cross closures.";
    default:
      return '';
  }
}

// ---------- Ranking: confirmed network first, then small streets over arterials/alleys ----------
const HIGHWAY_COST = {            // lower = better; 'designated' network counts as 0
  cycleway: 0.5, path: 0.5, track: 1, pedestrian: 1, footway: 1,
  living_street: 1, residential: 1, unclassified: 1.5, tertiary: 2.5,
  service: 4, secondary: 4, primary: 6, trunk: 7,
};
const ALLEY_COST = 5, UNMATCHED_COST = 3;
const DETOUR_WEIGHT = 2;          // a route 50% longer than the shortest costs +1 preference unit

function preferenceCost(route, networkIndex) {
  const pts = CyclingApp.sampleRoute(route, 100);
  let total = 0, confirmed = 0;
  for (const pt of pts) {
    const p = CyclingApp.nearbyFeature(pt, networkIndex, 40)?.properties;
    if (!p) { total += UNMATCHED_COST; continue; }
    if (p.bicycle_access === 'designated') { confirmed++; continue; }
    if (p.service === 'alley') { total += ALLEY_COST; continue; }
    total += HIGHWAY_COST[p.highway] ?? UNMATCHED_COST;
  }
  return {
    cost: pts.length ? total / pts.length : UNMATCHED_COST,
    confirmedShare: pts.length ? confirmed / pts.length : 0,
  };
}

// Takes the array returned by CyclingApp.scoreRoutes and re-orders it in place of its own sort.
function applyPreferenceOrder(scored, networkIndex) {
  const dists = scored.map(s => s.distance).filter(d => d > 0);
  const minDist = dists.length ? Math.min(...dists) : 1;
  for (const s of scored) {
    s.pref = preferenceCost(s.route, networkIndex);
    s.rankKey = s.pref.cost + DETOUR_WEIGHT * ((s.distance || minDist) / minDist - 1);
    s.explanations.unshift(`${Math.round(s.pref.confirmedShare * 100)}% on confirmed cycling network.`);
  }
  scored.sort((a, b) => a.rankKey - b.rankKey);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}