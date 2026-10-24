const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

let worker;
test('load the Cloudflare worker module', async () => {
  const source = await fs.readFile(new URL('../worker/src/index.js', `file://${__filename}`), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  worker = (await import(moduleUrl)).default;
});

test('worker requests ORS cycling alternatives with road and surface extras', async () => {
  const originalFetch = globalThis.fetch;
  let outgoing;
  const point = (x, y) => ({
    type: 'Feature',
    properties: {
      summary: { distance: 1500, duration: 300 },
      segments: [{ steps: [{ instruction: 'Turn left', way_points: [0, 1] }] }],
    },
    geometry: { type: 'LineString', coordinates: [[x, y], [x + 0.001, y + 0.001]] },
  });
  globalThis.fetch = async (url, options) => {
    outgoing = { url, options };
    return new Response(JSON.stringify({
      type: 'FeatureCollection',
      features: [point(-114.07, 51.04), point(-114.06, 51.05)],
    }), { status: 200 });
  };
  try {
    const request = new Request('http://localhost/route', {
      method: 'POST',
      headers: { Origin: 'http://localhost:8000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[-114.0719, 51.0447], [-114.06, 51.05]] }),
    });
    const response = await worker.fetch(request, {
      ORS_KEY: 'test-key',
      ROUTE_LIMITER: { limit: async () => ({ success: true }) },
    });
    assert.equal(response.status, 200);
    assert.match(outgoing.url, /api\.openrouteservice\.org/);
    const body = JSON.parse(outgoing.options.body);
    assert.equal(body.alternative_routes.target_count, 3);
    assert.equal(body.instructions, true);
    assert.equal(body.language, 'en');
    assert.equal(body.units, 'm');
    assert.deepEqual(body.extra_info, ['surface', 'waytype', 'steepness']);
    const responseBody = await response.json();
    assert.equal(responseBody.features.length, 2);
    assert.equal(responseBody.features[0].properties.routing_profile, 'cycling-regular');
    assert.equal(responseBody.features[0].properties.segments[0].steps[0].instruction, 'Turn left');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker asks cycling-road for a distinct fallback when regular returns one route', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const feature = coordinates => ({
    type: 'Feature',
    properties: {
      summary: { distance: 1500, duration: 300 },
      segments: [{ steps: [{ instruction: 'Turn right', way_points: [0, 1] }] }],
    },
    geometry: { type: 'LineString', coordinates },
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const features = calls.length === 1
      ? [feature([[-114.07, 51.04], [-114.06, 51.05]])]
      : [feature([[-114.07, 51.04], [-114.055, 51.052]])];
    return new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 });
  };
  try {
    const request = new Request('http://localhost/route', {
      method: 'POST',
      headers: { Origin: 'http://localhost:8000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[-114.0719, 51.0447], [-114.06, 51.05]] }),
    });
    const response = await worker.fetch(request, {
      ORS_KEY: 'test-key',
      ROUTE_LIMITER: { limit: async () => ({ success: true }) },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /cycling-road/);
    assert.equal(JSON.parse(calls[1].options.body).instructions, true);
    assert.equal(body.features.length, 2);
    assert.equal(body.features[1].properties.routing_profile, 'cycling-road');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker rejects San Francisco coordinates without contacting ORS', async () => {
  const request = new Request('http://localhost/route', {
    method: 'POST',
    headers: { Origin: 'http://localhost:8000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: [[-122.4194, 37.7749], [-122.41, 37.78]] }),
  });
  const response = await worker.fetch(request, {
    ORS_KEY: 'test-key',
    ROUTE_LIMITER: { limit: async () => ({ success: true }) },
  });
  assert.equal(response.status, 400);
});

test('worker reports missing ORS credentials as a configuration error', async () => {
  const request = new Request('http://localhost/route', {
    method: 'POST',
    headers: { Origin: 'http://localhost:8000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: [[-114.0719, 51.0447], [-114.06, 51.05]] }),
  });
  const response = await worker.fetch(request, {
    ROUTE_LIMITER: { limit: async () => ({ success: true }) },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /ORS_KEY/);
});
