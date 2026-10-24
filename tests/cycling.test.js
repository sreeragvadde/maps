const test = require('node:test');
const assert = require('node:assert/strict');
const CyclingApp = require('../web/cycling.js');

const network = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        facility_type: 'pathway',
        bicycle_access: 'designated',
        highway: 'path',
        surface: 'asphalt',
      },
      geometry: { type: 'LineString', coordinates: [[-114.1, 51], [-114.09, 51]] },
    },
    {
      type: 'Feature',
      properties: {
        facility_type: 'shared_use',
        bicycle_access: 'unknown',
        highway: 'primary',
        surface: 'gravel',
      },
      geometry: { type: 'LineString', coordinates: [[-114.1, 51.01], [-114.09, 51.01]] },
    },
  ],
};

function makeRoute(coordinates, summary) {
  return {
    type: 'Feature',
    properties: { summary },
    geometry: { type: 'LineString', coordinates },
  };
}

const forecast = {
  hourly: {
    time: ['2026-06-01T12:00'],
    temperature_2m: [20],
    precipitation: [0],
    wind_speed_10m: [0],
    wind_direction_10m: [0],
    wind_gusts_10m: [0],
  },
};

test('route scores use a fixed benchmark and reward mapped cycling facilities', () => {
  const index = CyclingApp.buildNetworkIndex(network);
  const routes = [
    makeRoute([[-114.1, 51], [-114.09, 51]], { distance: 700, duration: 500, ascent: 0 }),
    makeRoute([[-114.1, 51.01], [-114.09, 51.01]], { distance: 800, duration: 600, ascent: 20 }),
  ];
  const result = CyclingApp.scoreRoutes(routes, index, forecast, Date.UTC(2026, 5, 1, 12));
  assert.equal(result.length, 2);
  assert.equal(result[0].score, 99);
  assert.equal(result[0].scoreCoverage, 100);
  assert.ok(result[0].score > result[1].score);
  assert.match(result[1].explanations.join(' '), /higher-classified roads or rougher mapped surfaces/);
});

test('unavailable weather and elevation are excluded rather than fabricated', () => {
  const route = makeRoute([[-114.1, 51], [-114.09, 51]], { distance: 700, duration: 500 });
  const result = CyclingApp.scoreRoutes([route], null, null, Date.now())[0];
  assert.equal(result.components.weather, null);
  assert.equal(result.components.elevation, null);
  assert.equal(result.scoreCoverage, 15);
  assert.equal(result.score, 15);
  assert.match(result.explanations.join(' '), /No forecast is available/);
});

test('route scores do not change based on the other options returned', () => {
  const index = CyclingApp.buildNetworkIndex(network);
  const route = makeRoute([[-114.1, 51], [-114.09, 51]], {
    distance: 4000, duration: 500, ascent: 0,
  });
  const longer = makeRoute([[-114.1, 51.01], [-114.09, 51.01]], {
    distance: 12000, duration: 800, ascent: 30,
  });
  const single = CyclingApp.scoreRoutes(
    [route], index, forecast, Date.UTC(2026, 5, 1, 12),
  )[0];
  const pair = CyclingApp.scoreRoutes(
    [route, longer], index, forecast, Date.UTC(2026, 5, 1, 12),
  ).find(option => option.route === route);
  assert.equal(single.score, pair.score);
  assert.equal(single.components.distance, 15);
  assert.equal(CyclingApp.DISTANCE_TARGET_M, 5000);
});

test('route ascent is compared per kilometre', () => {
  const route = makeRoute([[-114.1, 51], [-114.09, 51]], {
    distance: 1000, duration: 500, ascent: 60,
  });
  const result = CyclingApp.scoreRoutes([route], null, null, Date.now())[0];
  assert.equal(result.components.elevation, 4.75);
});

test('weather score warns for rain, headwinds, gusts, and extreme temperatures', () => {
  const route = makeRoute([[-114.1, 51], [-114.1, 51.01]], { distance: 1000, duration: 500 });
  const badForecast = {
    hourly: {
      time: ['2026-06-01T12:00'],
      temperature_2m: [-20],
      precipitation: [3],
      wind_speed_10m: [50],
      wind_direction_10m: [0],
      wind_gusts_10m: [55],
    },
  };
  const result = CyclingApp.scoreRoutes(
    [route], null, badForecast, Date.UTC(2026, 5, 1, 12),
  )[0];
  assert.ok(result.components.weather < 10);
  assert.equal(result.weather.warnings.length, 4);
  assert.ok(result.weather.headwind > 49);
});

test('weather requests are cached and share in-flight requests', async () => {
  let requests = 0;
  const fetcher = async url => {
    requests++;
    assert.match(url.toString(), /api\.open-meteo\.com/);
    return { ok: true, json: async () => forecast };
  };
  const when = Date.parse('2026-06-01T12:00');
  const first = CyclingApp.fetchWeather(51.01, -114.02, when, fetcher);
  const second = CyclingApp.fetchWeather(51.01, -114.02, when, fetcher);
  const [one, two] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(one, two);
  const cached = await CyclingApp.fetchWeather(51.01, -114.02, when, fetcher);
  assert.equal(cached, one);
  assert.equal(requests, 1);
});

test('only explicitly confirmed car-replacing rides earn points', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = CyclingApp.createTripStore(storage);
  const ordinary = store.addRide({
    distanceKm: 5, mode: 'car', carReplacement: false,
  }).ride;
  const confirmed = store.addRide({
    distanceKm: 2.5, mode: 'car', carReplacement: true,
  }).ride;
  const nonCarBaseline = store.addRide({
    distanceKm: 4, mode: 'transit', carReplacement: true,
  }).ride;
  assert.equal(ordinary.points, 0);
  assert.equal(confirmed.points, 25);
  assert.equal(confirmed.co2Kg, 0.48);
  assert.equal(nonCarBaseline.points, 0);
  assert.deepEqual(CyclingApp.summarizeRides(store.load().rides), {
    rideCount: 3,
    distanceKm: 11.5,
    co2Kg: 1.8,
    points: 25,
    carReplacements: 1,
  });
});
