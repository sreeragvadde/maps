const ALLOWED_ORIGINS = new Set([
  'https://jessikamessika.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);
const ORS = 'https://api.openrouteservice.org/v2/directions/cycling-regular/geojson';
const BBOXES = [
  { minLng: -114.5,  maxLng: -113.7,  minLat: 50.8,  maxLat: 51.3  },  // Calgary
  { minLng: -122.55, maxLng: -122.35, minLat: 37.70, maxLat: 37.84 },  // San Francisco (checked GMaps.)
];
const inAnyBox = p => BBOXES.some(b => p[0] >= b.minLng && p[0] <= b.maxLng && p[1] >= b.minLat && p[1] <= b.maxLat);

const err = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: { message } }),
    { status, headers: { 'Content-Type': 'application/json', ...headers } });

function validCoords(c) {
  return Array.isArray(c) && c.length === 2 && c.every(p =>
    Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
    inAnyBox(p));
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
    if (!validCoords(body.coordinates)) return err(400, 'Coordinates must be two [lng, lat] points in a supported city', cors);

    // Rate limit: one shared bucket protects the ORS allowance
    const { success } = await env.ROUTE_LIMITER.limit({ key: 'route' });
    if (!success) return err(429, 'Route service is busy. Please try again in a minute.', cors);

    let upstream;
    try {
      upstream = await fetch(ORS, {
        method: 'POST',
        headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates: body.coordinates, radiuses: [500, 500] }),
      });
    } catch (e) {
      console.error('Upstream fetch threw:', String(e));
      return err(502, 'Upstream fetch failed: ' + String(e), cors);
    }

    const text = await upstream.text();
    if (!upstream.ok) console.error('ORS responded', upstream.status, text.slice(0, 300));
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};