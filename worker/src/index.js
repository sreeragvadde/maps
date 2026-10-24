const ALLOWED_ORIGINS = new Set([
  'https://jessikamessika.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);
const ORS = 'https://api.openrouteservice.org/v2/directions/cycling-regular/geojson';
const ORS_ROAD = 'https://api.openrouteservice.org/v2/directions/cycling-road/geojson';
const CALGARY_BBOX = { minLng: -114.5, maxLng: -113.7, minLat: 50.8, maxLat: 51.3 };
const inCalgary = p =>
  p[0] >= CALGARY_BBOX.minLng && p[0] <= CALGARY_BBOX.maxLng &&
  p[1] >= CALGARY_BBOX.minLat && p[1] <= CALGARY_BBOX.maxLat;

const err = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: { message } }),
    { status, headers: { 'Content-Type': 'application/json', ...headers } });

function validCoords(c) {
  return Array.isArray(c) && c.length === 2 && c.every(p =>
    Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
    inCalgary(p));
}

function routeFingerprint(feature) {
  const geometry = feature?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return '';
  const coordinates = geometry.type === 'LineString'
    ? geometry.coordinates
    : geometry.type === 'MultiLineString' ? geometry.coordinates.flat() : [];
  if (!coordinates.length) return '';
  const stride = Math.max(1, Math.floor(coordinates.length / 24));
  return coordinates.filter((_, index) => index % stride === 0 || index === coordinates.length - 1)
    .map(point => point.map(value => Number(value).toFixed(3)).join(','))
    .join(';');
}

function distinctRoutes(features, limit = 3) {
  const seen = new Set();
  return features.filter(feature => {
    const fingerprint = routeFingerprint(feature);
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }).slice(0, limit);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.has(origin)) return err(403, 'Origin not allowed');

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return err(405, 'POST only', cors);

    let body;
    try { body = await request.json(); } catch { return err(400, 'Invalid JSON', cors); }
    if (!validCoords(body.coordinates)) return err(400, 'Coordinates must be two [lng, lat] points in Calgary', cors);
    if (!env.ORS_KEY) return err(503, 'Route service is not configured. Set the ORS_KEY worker secret.', cors);

    // Rate limit: one shared bucket protects the ORS allowance
    const { success } = await env.ROUTE_LIMITER.limit({ key: 'route' });
    if (!success) return err(429, 'Route service is busy. Please try again in a minute.', cors);

    let upstream;
    try {
      upstream = await fetch(ORS, {
        method: 'POST',
        headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coordinates: body.coordinates,
          radiuses: [500, 500],
          alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.4 },
          extra_info: ['surface', 'waytype', 'steepness'],
        }),
      });
    } catch (e) {
      console.error('Upstream fetch threw:', String(e));
      return err(502, 'Upstream fetch failed: ' + String(e), cors);
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('ORS responded', upstream.status, text.slice(0, 300));
      return new Response(text, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let primary;
    try {
      primary = JSON.parse(text);
    } catch (e) {
      console.error('ORS returned invalid JSON:', String(e));
      return err(502, 'Route service returned an invalid response.', cors);
    }
    if (!Array.isArray(primary.features)) {
      return err(502, 'Route service returned no route options.', cors);
    }

    let features = distinctRoutes(primary.features.map(feature => ({
      ...feature,
      properties: { ...(feature.properties || {}), routing_profile: 'cycling-regular' },
    })));
    if (features.length < 2) {
      try {
        const fallback = await fetch(ORS_ROAD, {
          method: 'POST',
          headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coordinates: body.coordinates,
            radiuses: [500, 500],
            alternative_routes: { target_count: 2, share_factor: 0.6, weight_factor: 1.4 },
            extra_info: ['surface', 'waytype', 'steepness'],
          }),
        });
        if (fallback.ok) {
          const fallbackBody = await fallback.json();
          if (Array.isArray(fallbackBody.features)) {
            features = distinctRoutes([...features, ...fallbackBody.features.map(feature => ({
              ...feature,
              properties: { ...(feature.properties || {}), routing_profile: 'cycling-road' },
            }))]);
          }
        } else {
          console.warn('ORS cycling-road fallback responded', fallback.status);
        }
      } catch (e) {
        console.warn('ORS cycling-road fallback failed:', String(e));
      }
    }

    return new Response(JSON.stringify({ ...primary, features }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};