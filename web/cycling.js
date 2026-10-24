(function (root) {
  'use strict';

  const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
  const WEATHER_CACHE_MS = 15 * 60 * 1000;
  const WEATHER_REFRESH_MS = 30 * 60 * 1000;
  const WEATHER_CACHE_LIMIT = 48;
  const CELL_SIZE = 0.01;
  const EARTH_RADIUS_M = 6371008.8;
  const DISTANCE_TARGET_M = 5000;
  const CAR_EMISSIONS_KG_PER_KM = 0.192;
  const EMISSIONS_FACTORS = {
    car: CAR_EMISSIONS_KG_PER_KM,
    rideshare: CAR_EMISSIONS_KG_PER_KM / 2,
    transit: 0.089,
    other: 0,
  };

  const weatherCache = new Map();
  const weatherRequests = new Map();

  function cellKey(lng, lat) {
    return `${Math.floor(lng / CELL_SIZE)}:${Math.floor(lat / CELL_SIZE)}`;
  }

  function eachLine(feature, callback) {
    const geometry = feature.geometry || {};
    if (geometry.type === 'LineString') callback(geometry.coordinates);
    if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(callback);
  }

  function haversine(a, b) {
    const rad = value => value * Math.PI / 180;
    const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function addToCell(index, point, featureIndex) {
    const key = cellKey(point[0], point[1]);
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(featureIndex);
  }

  function buildNetworkIndex(network) {
    const index = new Map();
    const features = network?.features || [];
    features.forEach((feature, featureIndex) => {
      eachLine(feature, line => {
        if (!line.length) return;
        addToCell(index, line[0], featureIndex);
        for (let i = 1; i < line.length; i++) {
          const start = line[i - 1], end = line[i];
          const distance = haversine(start, end);
          const steps = Math.max(1, Math.ceil(distance / 250));
          for (let step = 1; step <= steps; step++) {
            const ratio = step / steps;
            addToCell(index, [
              start[0] + (end[0] - start[0]) * ratio,
              start[1] + (end[1] - start[1]) * ratio,
            ], featureIndex);
          }
        }
      });
    });
    return { index, features };
  }

  function nearbyFeature(point, networkIndex, maxDistance = 90) {
    if (!networkIndex) return null;
    const candidates = new Set();
    const x = Math.floor(point[0] / CELL_SIZE);
    const y = Math.floor(point[1] / CELL_SIZE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const featureIndex of networkIndex.index.get(`${x + dx}:${y + dy}`) || []) {
          candidates.add(featureIndex);
        }
      }
    }

    const latScale = 111320;
    const lngScale = latScale * Math.cos(point[1] * Math.PI / 180);
    let bestFeature = null, bestDistance = maxDistance;
    for (const featureIndex of candidates) {
      const feature = networkIndex.features[featureIndex];
      let foundLineDistance = Infinity;
      eachLine(feature, line => {
        for (let i = 1; i < line.length; i++) {
          const ax = (line[i - 1][0] - point[0]) * lngScale;
          const ay = (line[i - 1][1] - point[1]) * latScale;
          const bx = (line[i][0] - point[0]) * lngScale;
          const by = (line[i][1] - point[1]) * latScale;
          const vx = bx - ax, vy = by - ay;
          const lengthSquared = vx * vx + vy * vy;
          const t = lengthSquared
            ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / lengthSquared))
            : 0;
          foundLineDistance = Math.min(foundLineDistance,
            Math.hypot(ax + t * vx, ay + t * vy));
        }
      });
      if (foundLineDistance < bestDistance) {
        bestDistance = foundLineDistance;
        bestFeature = feature;
      }
    }
    return bestFeature;
  }

  function sampleRoute(route, intervalM = 250) {
    const geometry = route.geometry || {};
    const lines = geometry.type === 'LineString' ? [geometry.coordinates]
      : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    const samples = [];
    for (const line of lines) {
      if (!line.length) continue;
      samples.push(line[0]);
      for (let i = 1; i < line.length; i++) {
        const start = line[i - 1], end = line[i];
        const steps = Math.max(1, Math.ceil(haversine(start, end) / intervalM));
        for (let step = 1; step <= steps; step++) {
          const ratio = step / steps;
          samples.push([
            start[0] + (end[0] - start[0]) * ratio,
            start[1] + (end[1] - start[1]) * ratio,
          ]);
        }
      }
    }
    return samples;
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function parseWeatherTime(value) {
    return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
  }

  function roadSafetyValue(properties) {
    const highwayScores = {
      cycleway: 25, path: 25, footway: 22, track: 22, pedestrian: 22,
      living_street: 22, service: 20, residential: 19, unclassified: 18,
      tertiary: 16, secondary: 12, primary: 8, trunk: 4, motorway: 0,
    };
    const surfaceScores = {
      asphalt: 25, paved: 24, concrete: 23, paving_stones: 20,
      compacted: 18, fine_gravel: 16, gravel: 13, dirt: 10, ground: 9,
      unpaved: 8, sand: 4, mud: 3,
    };
    const values = [];
    if (highwayScores[properties.highway] !== undefined)
      values.push(highwayScores[properties.highway]);
    if (surfaceScores[properties.surface] !== undefined)
      values.push(surfaceScores[properties.surface]);
    const cycleway = properties.cycleway || properties.cycleway_left || properties.cycleway_right;
    if (cycleway === 'track' || cycleway === 'separate') values.push(25);
    else if (cycleway === 'lane' || cycleway === 'opposite_lane') values.push(21);
    else if (cycleway === 'shared_lane' || cycleway === 'shared') values.push(15);
    return mean(values);
  }

  function infrastructureValue(properties) {
    const scores = {
      cycle_track: 25, bike_lane: 23, pathway: 22, trail: 20, shared_use: 18,
      unknown: 10,
    };
    const value = scores[properties.facility_type];
    if (value === undefined) return null;
    if (properties.bicycle_access === 'designated') return Math.min(25, value + 2);
    if (properties.bicycle_access === 'permissive') return Math.max(0, value - 2);
    return value;
  }

  function routeDistance(route) {
    const summary = route.properties?.summary || {};
    if (Number.isFinite(summary.distance)) return summary.distance;
    const geometry = route.geometry || {};
    const lines = geometry.type === 'LineString' ? [geometry.coordinates]
      : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
    return lines.reduce((total, line) => total + line.slice(1).reduce((length, point, index) =>
      length + haversine(line[index], point), 0), 0);
  }

  function routeElevation(route, matchedFeatures) {
    const summary = route.properties?.summary || {};
    const ascent = Number.isFinite(summary.ascent) ? summary.ascent
      : Number.isFinite(route.properties?.ascent) ? route.properties.ascent : null;
    const routeKm = Math.max(routeDistance(route) / 1000, 0.1);
    if (ascent !== null) {
      const ascentPerKm = ascent / routeKm;
      return Math.max(0, 10 - Math.max(0, ascentPerKm - 25) * 0.15);
    }

    const elevations = matchedFeatures.map(feature =>
      Number.parseFloat(feature.properties?.ele)).filter(Number.isFinite);
    if (elevations.length > 1) {
      const ascentFromOsm = elevations.slice(1).reduce((total, elevation, index) =>
        total + Math.max(0, elevation - elevations[index]), 0);
      return Math.max(0, 10 - Math.max(0, ascentFromOsm / routeKm - 25) * 0.15);
    }

    const steepness = route.properties?.extras?.steepness?.values;
    if (Array.isArray(steepness) && steepness.length) {
      let total = 0, weight = 0;
      for (const range of steepness) {
        if (!Array.isArray(range) || !Number.isFinite(range[2])) continue;
        const length = Math.max(1, Number(range[1]) - Number(range[0]));
        total += Math.abs(range[2]) * length;
        weight += length;
      }
      if (weight) return Math.max(0, 10 - Math.max(0, total / weight - 1) * 1.5);
    }

    const inclines = matchedFeatures.map(feature => {
      const value = Number.parseFloat(String(feature.properties?.incline || '').replace('%', ''));
      return Number.isFinite(value) ? Math.abs(value) : null;
    }).filter(value => value !== null);
    if (inclines.length) return Math.max(0, 10 - Math.max(0, mean(inclines) - 3) * 1.2);
    return null;
  }

  function calculateWeather(weather, departureMs, route) {
    if (!weather?.hourly?.time?.length) return null;
    let selected = -1, bestDelta = Infinity;
    for (let index = 0; index < weather.hourly.time.length; index++) {
      const delta = Math.abs(parseWeatherTime(weather.hourly.time[index]) - departureMs);
      if (delta < bestDelta) { bestDelta = delta; selected = index; }
    }
    if (selected < 0 || bestDelta > 90 * 60 * 1000) return null;

    const value = field => weather.hourly[field]?.[selected];
    const temperature = value('temperature_2m');
    const precipitation = value('precipitation');
    const windSpeed = value('wind_speed_10m');
    const windDirection = value('wind_direction_10m');
    const gusts = value('wind_gusts_10m');
    const coordinates = route.geometry?.coordinates || [];
    const firstPoint = route.geometry?.type === 'MultiLineString' ? coordinates[0]?.[0] : coordinates[0];
    const secondPoint = route.geometry?.type === 'MultiLineString' ? coordinates[0]?.[1] : coordinates[1];
    let headwind = null;
    if (firstPoint && secondPoint && Number.isFinite(windDirection) && Number.isFinite(windSpeed)) {
      const y = Math.sin((secondPoint[0] - firstPoint[0]) * Math.PI / 180) *
        Math.cos(secondPoint[1] * Math.PI / 180);
      const x = Math.cos(firstPoint[1] * Math.PI / 180) * Math.sin(secondPoint[1] * Math.PI / 180) -
        Math.sin(firstPoint[1] * Math.PI / 180) * Math.cos(secondPoint[1] * Math.PI / 180) *
        Math.cos((secondPoint[0] - firstPoint[0]) * Math.PI / 180);
      const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      headwind = Math.max(0, Math.cos((windDirection - bearing) * Math.PI / 180)) * windSpeed;
    }

    let earned = 0, availableWeight = 0;
    if (Number.isFinite(precipitation)) {
      availableWeight += 10;
      earned += 10 - Math.min(10, precipitation * 2.5);
    }
    if (Number.isFinite(headwind)) {
      availableWeight += 7;
      earned += 7 - Math.min(7, headwind * 0.15);
    }
    if (Number.isFinite(gusts)) {
      availableWeight += 5;
      earned += 5 - Math.min(5, Math.max(0, gusts - 25) * 0.15);
    }
    if (Number.isFinite(temperature)) {
      availableWeight += 3;
      let temperaturePenalty = 0;
      if (temperature < 0) temperaturePenalty += Math.min(3, Math.abs(temperature) * 0.15);
      if (temperature > 25) temperaturePenalty += Math.min(3, (temperature - 25) * 0.3);
      earned += 3 - temperaturePenalty;
    }
    const warnings = [];
    if (precipitation >= 2) warnings.push('Forecast precipitation may reduce visibility and traction.');
    if (gusts >= 50) warnings.push('Strong gusts are forecast; take extra care in exposed areas.');
    if (windSpeed >= 40) warnings.push('Strong winds are forecast.');
    if (temperature <= -15 || temperature >= 33)
      warnings.push('Forecast temperature is extreme; consider delaying or dressing appropriately.');
    return {
      score: availableWeight ? Math.max(0, Math.min(25, earned / availableWeight * 25)) : null,
      availableWeight,
      time: weather.hourly.time[selected],
      temperature, precipitation, windSpeed, windDirection, gusts, headwind,
      warnings,
      label: [
        Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : null,
        Number.isFinite(precipitation) ? `${precipitation.toFixed(1)} mm rain` : null,
        Number.isFinite(windSpeed) ? `${Math.round(windSpeed)} km/h wind` : null,
        Number.isFinite(gusts) ? `${Math.round(gusts)} km/h gusts` : null,
      ].filter(Boolean).join(' · '),
    };
  }

  function scoreRoutes(routes, networkIndex, weather, departureMs) {
    const prepared = routes.map(route => {
      const distance = routeDistance(route);
      const matched = sampleRoute(route)
        .map(point => nearbyFeature(point, networkIndex))
        .filter(Boolean);
      const safetyValues = matched.map(feature => roadSafetyValue(feature.properties || {}))
        .filter(value => value !== null);
      const infrastructureValues = matched.map(feature =>
        infrastructureValue(feature.properties || {})).filter(value => value !== null);
      const roadSafety = mean(safetyValues);
      const infrastructure = mean(infrastructureValues);
      const weatherResult = calculateWeather(weather, departureMs, route);
      const elevation = routeElevation(route, matched);
      return {
        route, distance,
        duration: route.properties?.summary?.duration ??
          distance / 1000 / 15 * 3600,
        components: { safety: roadSafety, infrastructure, weather: weatherResult?.score ?? null,
          distance: null, elevation },
        componentWeights: { safety: 25, infrastructure: 25,
        weather: weatherResult?.availableWeight ?? 0, distance: 15, elevation: 10 },
        weather: weatherResult,
        matchedCount: matched.length,
      };
    });
    return prepared.map((item, index) => {
      item.components.distance = Number.isFinite(item.distance) && item.distance > 0
        ? 15 * Math.min(1, DISTANCE_TARGET_M / item.distance) : null;
      const available = Object.keys(item.componentWeights)
        .filter(key => Number.isFinite(item.components[key]) && item.componentWeights[key] > 0);
      const maxPoints = available.reduce((sum, key) => sum + item.componentWeights[key], 0);
      const earnedPoints = available.reduce((sum, key) => {
        if (key === 'weather') {
          return sum + item.components.weather * item.componentWeights.weather / 25;
        }
        return sum + item.components[key];
      }, 0);
      item.score = Math.max(0, Math.min(100, Math.round(earnedPoints + 1e-9)));
      item.scoreCoverage = maxPoints;
      item.option = index;
      item.explanations = [];
      if (item.components.infrastructure >= 19) item.explanations.push('Strong mapped cycling infrastructure.');
      else if (item.components.infrastructure < 15) item.explanations.push('Less mapped cycling infrastructure along this option.');
      if (item.components.safety !== null && item.components.safety >= 18)
        item.explanations.push('Favors lower-classified streets and/or smoother mapped surfaces.');
      else if (item.components.safety !== null && item.components.safety < 12)
        item.explanations.push('Includes higher-classified roads or rougher mapped surfaces.');
      if (item.components.distance === 15) item.explanations.push('Meets the fixed 5 km distance benchmark.');
      else item.explanations.push('Distance points decrease beyond the fixed 5 km benchmark.');
      if (item.components.elevation === null) item.explanations.push('Elevation/steepness data is unavailable for this route.');
      if (item.matchedCount === 0) item.explanations.push('No nearby mapped OSM cycling features matched this route.');
      if (item.weather) item.explanations.push(...item.weather.warnings);
      else item.explanations.push('No forecast is available for the selected departure time.');
      return item;
    }).sort((a, b) => b.score - a.score || a.distance - b.distance)
      .map((item, index) => ({ ...item, rank: index + 1 }));
  }

  function weatherCacheKey(latitude, longitude, departureMs) {
    const hour = new Date(departureMs);
    hour.setMinutes(0, 0, 0);
    return `${latitude.toFixed(2)}:${longitude.toFixed(2)}:${hour.toISOString()}`;
  }

  async function fetchWeather(latitude, longitude, departureMs, fetcher = fetch) {
    const key = weatherCacheKey(latitude, longitude, departureMs);
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.timestamp < WEATHER_CACHE_MS) return cached.value;
    if (weatherRequests.has(key)) return weatherRequests.get(key);

    const request = (async () => {
      const url = new URL(WEATHER_URL);
      url.search = new URLSearchParams({
        latitude: latitude.toFixed(2),
        longitude: longitude.toFixed(2),
        hourly: 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        forecast_days: '3',
        timezone: 'UTC',
      });
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`Weather service HTTP ${response.status}`);
      const data = await response.json();
      if (!data.hourly?.time?.length) throw new Error('Weather forecast is unavailable');
      while (weatherCache.size >= WEATHER_CACHE_LIMIT) {
        weatherCache.delete(weatherCache.keys().next().value);
      }
      weatherCache.set(key, { timestamp: Date.now(), value: data });
      return data;
    })().finally(() => weatherRequests.delete(key));
    weatherRequests.set(key, request);
    return request;
  }

  function createTripStore(storage) {
    const key = 'revitalizeCycling.v1';
    function load() {
      try {
        const value = JSON.parse(storage.getItem(key) || '{"rides":[]}');
        if (!value || !Array.isArray(value.rides)) throw new Error('Stored ride history is malformed.');
        return { ...value, storageAvailable: true };
      } catch (error) {
        return { rides: [], storageAvailable: false, storageError: error };
      }
    }
    function save(state) {
      try {
        storage.setItem(key, JSON.stringify({ rides: state.rides }));
        return { ...state, storageAvailable: true };
      } catch (error) {
        return { ...state, storageAvailable: false, storageError: error };
      }
    }
    function addRide({ distanceKm, mode, carReplacement, routeName = 'Cycling trip', date = new Date().toISOString() }) {
      if (!Number.isFinite(distanceKm) || distanceKm <= 0) throw new Error('Ride distance must be positive.');
      if (!Object.hasOwn(EMISSIONS_FACTORS, mode)) throw new Error('Choose a supported alternative travel mode.');
      const replacedCar = carReplacement && (mode === 'car' || mode === 'rideshare');
      const ride = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date, distanceKm: Math.round(distanceKm * 10) / 10, mode,
        carReplacement: Boolean(replacedCar),
        points: replacedCar ? Math.round(distanceKm * 10) : 0,
        co2Kg: Math.round(distanceKm * EMISSIONS_FACTORS[mode] * 100) / 100,
        routeName,
      };
      const state = load();
      state.rides.unshift(ride);
      return { ride, state: save(state) };
    }
    return { load, addRide };
  }

  function summarizeRides(rides) {
    return {
      rideCount: rides.length,
      distanceKm: rides.reduce((sum, ride) => sum + ride.distanceKm, 0),
      co2Kg: Math.round(rides.reduce((sum, ride) => sum + ride.co2Kg, 0) * 100) / 100,
      points: rides.reduce((sum, ride) => sum + ride.points, 0),
      carReplacements: rides.filter(ride => ride.carReplacement).length,
    };
  }

  const api = {
    CAR_EMISSIONS_KG_PER_KM, DISTANCE_TARGET_M, EMISSIONS_FACTORS, WEATHER_REFRESH_MS,
    buildNetworkIndex, scoreRoutes, fetchWeather, createTripStore, summarizeRides,
  };
  root.CyclingApp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
