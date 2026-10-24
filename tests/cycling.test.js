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
  assert.equal(result.weather.warnings.length, 5);
  assert.equal(result.weather.winterConditions, true);
  assert.ok(result.weather.headwind > 49);
});

test('winter conditions prefer routes near priority streets without changing universal scores', () => {
  const winterForecast = {
    hourly: {
      time: ['2026-06-01T12:00'],
      temperature_2m: [-2],
      precipitation: [1],
      snowfall: [0],
      wind_speed_10m: [0],
      wind_direction_10m: [0],
      wind_gusts_10m: [0],
    },
  };
  const priorityRoutes = CyclingApp.buildSnowPriorityIndex({
    source_updated: '2026-10-01T20:35:57+00:00',
    features: [{
      type: 'Feature',
      properties: { priority: 1 },
      geometry: { type: 'MultiLineString', coordinates: [[[-114.1, 51], [-114.09, 51]]] },
    }],
  });
  const maintained = makeRoute(
    [[-114.1, 51], [-114.09, 51]], { distance: 1000, duration: 500 },
  );
  const other = makeRoute(
    [[-114.1, 51.01], [-114.09, 51.01]], { distance: 1000, duration: 500 },
  );
  const result = CyclingApp.scoreRoutes(
    [other, maintained], null, winterForecast, Date.UTC(2026, 5, 1, 12), priorityRoutes,
  );

  assert.equal(result[0].route, maintained);
  assert.equal(result[0].score, result[1].score);
  assert.ok(result[0].winter.coverage.priorityPercent > 90);
  assert.equal(result[0].winter.rankingBonus, 5);
  assert.equal(result[1].winter.coverage.priorityPercent, 0);
});

test('cold dry forecast does not assume snow clearing is needed', () => {
  const coldDryForecast = {
    hourly: {
      time: ['2026-06-01T12:00'],
      temperature_2m: [-5],
      precipitation: [0],
      snowfall: [0],
      wind_speed_10m: [0],
      wind_direction_10m: [0],
      wind_gusts_10m: [0],
    },
  };
  const result = CyclingApp.scoreRoutes(
    [makeRoute([[-114.1, 51], [-114.09, 51]], { distance: 1000, duration: 500 })],
    null, coldDryForecast, Date.UTC(2026, 5, 1, 12),
  )[0];

  assert.equal(result.winter, null);
});

test('live City snow progress categories match reported hours and completions', () => {
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 0, HOURS_BACK: 1 }), 'last-hour');
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 0, HOURS_BACK: 2 }), 'last-two-hours');
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 0, HOURS_BACK: 24 }), 'over-two-hours');
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 0, HOURS_BACK: 48 }), 'over-two-hours');
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 1, HOURS_BACK: 49 }), 'priority-one-completed');
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 2, HOURS_BACK: 49 }), 'priority-two-completed');
  assert.equal(CyclingApp.snowProgressCategory({ PRIORITY: 3, HOURS_BACK: 1 }), null);
});

test('live City snow progress fetch paginates even if ArcGIS omits its limit flag', async () => {
  const offsets = [];
  const makeFeature = id => ({
    type: 'Feature',
    id,
    properties: { OBJECTID: id, PRIORITY: 0, HOURS_BACK: 1 },
    geometry: { type: 'LineString', coordinates: [[-114.1, 51], [-114.09, 51]] },
  });
  const fetcher = async (url, options) => {
    assert.equal(options.cache, 'no-store');
    assert.match(url.toString(), /SnowClearingProgress\/MapServer\/0\/query/);
    assert.equal(url.searchParams.get('where'), '1=1');
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('f'), 'geojson');
    offsets.push(Number(url.searchParams.get('resultOffset')));
    const features = offsets.length === 1
      ? Array.from({ length: 1000 }, (_, index) => makeFeature(index + 1))
      : [makeFeature(1001)];
    return { ok: true, json: async () => ({ type: 'FeatureCollection', features }) };
  };

  const data = await CyclingApp.fetchSnowProgress(fetcher, true);
  assert.deepEqual(offsets, [0, 1000]);
  assert.equal(data.features.length, 1001);
  assert.equal(data.features[0].properties.snow_progress_category, 'last-hour');
  assert.ok(data.fetched_at);
});

test('empty live City snow-progress response is valid and indexes to no reported segments', async () => {
  const data = await CyclingApp.fetchSnowProgress(async () => ({
    ok: true,
    json: async () => ({ type: 'FeatureCollection', features: [] }),
  }), true);
  assert.deepEqual(data.features, []);
  assert.equal(CyclingApp.buildSnowProgressIndex(data).featureCount, 0);
});

test('live snow progress influences winter ordering without changing universal scores', () => {
  const winterForecast = {
    hourly: {
      time: ['2026-06-01T12:00'],
      temperature_2m: [-2],
      precipitation: [1],
      snowfall: [0],
      wind_speed_10m: [0],
      wind_direction_10m: [0],
      wind_gusts_10m: [0],
    },
  };
  const liveRoute = makeRoute(
    [[-114.1, 51], [-114.09, 51]], { distance: 1000, duration: 500 },
  );
  const annualPriorityRoute = makeRoute(
    [[-114.1, 51.01], [-114.09, 51.01]], { distance: 1000, duration: 500 },
  );
  const snowPriorityIndex = CyclingApp.buildSnowPriorityIndex({
    source_updated: '2026-10-01T20:35:57+00:00',
    features: [{
      type: 'Feature',
      properties: { priority: 1 },
      geometry: { type: 'LineString', coordinates: annualPriorityRoute.geometry.coordinates },
    }],
  });
  const progressData = {
    features: [{
      type: 'Feature',
      properties: { PRIORITY: 0, HOURS_BACK: 1 },
      geometry: { type: 'LineString', coordinates: liveRoute.geometry.coordinates },
    }],
    fetched_at: '2026-06-01T12:00:00Z',
  };
  const snowProgressIndex = CyclingApp.buildSnowProgressIndex(progressData);
  const result = CyclingApp.scoreRoutes(
    [annualPriorityRoute, liveRoute], null, winterForecast, Date.UTC(2026, 5, 1, 12),
    snowPriorityIndex, snowProgressIndex,
  );

  assert.equal(result[0].route, liveRoute);
  assert.equal(result[0].score, result[1].score);
  assert.ok(result[0].winter.progress.lastHourPercent > 90);
  assert.equal(result[0].winter.rankingBonus, 5);
  assert.equal(result[1].winter.rankingBonus, 0);
});

test('weather requests are cached and share in-flight requests', async () => {
  let requests = 0;
  const fetcher = async url => {
    requests++;
    assert.match(url.toString(), /api\.open-meteo\.com/);
    assert.match(url.searchParams.get('hourly'), /snowfall/);
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

test('every completed ride earns points without asking for a travel alternative', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = CyclingApp.createTripStore(storage);
  const ordinary = store.addRide({
    distanceKm: 5,
  }).ride;
  const shorter = store.addRide({
    distanceKm: 2.5,
  }).ride;
  const noAlternative = store.addRide({
    distanceKm: 4,
  }).ride;
  assert.equal(ordinary.points, 50);
  assert.equal(shorter.points, 25);
  assert.equal(noAlternative.points, 40);
  assert.equal(ordinary.co2Kg, null);
  assert.equal(ordinary.mode, undefined);
  assert.deepEqual(CyclingApp.summarizeRides(store.load().rides), {
    rideCount: 3,
    distanceKm: 11.5,
    co2Kg: 0,
    points: 115,
  });
});

test('completed ride history persists route geometry and loads older rides without routes', () => {
  const values = new Map([['revitalizeCycling.v1', JSON.stringify({
    rides: [{ id: 'older-ride', distanceKm: 3, points: 0, co2Kg: 0, mode: 'other' }],
  })]]);
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = CyclingApp.createTripStore(storage);
  const geometry = {
    type: 'LineString',
    coordinates: [[-114.0719, 51.0447], [-114.06, 51.05]],
  };
  const result = store.addRide({
    distanceKm: 2.1,
    route: { type: 'Feature', geometry },
  });
  const restored = CyclingApp.createTripStore(storage).load();
  assert.equal(restored.rides.length, 2);
  assert.equal(restored.rides[0].id, result.ride.id);
  assert.deepEqual(restored.rides[0].route, geometry);
  assert.equal(restored.rides[0].points, 21);
  assert.equal(restored.rides[0].co2Kg, null);
  assert.equal(restored.rides[1].route, undefined);
});

test('trip store rejects unsupported saved route geometries', () => {
  const store = CyclingApp.createTripStore({
    getItem: () => null,
    setItem: () => {},
  });
  assert.throws(() => store.addRide({
    distanceKm: 1,
    route: { type: 'Feature', geometry: { type: 'Point', coordinates: [-114, 51] } },
  }), /must be a line/);
});
