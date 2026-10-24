# Revitalize Cycling

Revitalize Cycling is a Calgary cycling map with closure-aware route alternatives, a rule-based route comparison, departure-time weather, and an optional locally saved eco-trip log. It extends the existing static MapLibre app and Cloudflare Worker; it does not require a frontend build step or add a JavaScript dependency.

## Run the app

From the repository root:

```sh
python3 -m http.server 8000
```

Open [http://localhost:8000/](http://localhost:8000/) or [http://localhost:8000/web/](http://localhost:8000/web/). The root page redirects to the map. The deployed route proxy is already configured in `web/routing.js`; local route planning therefore needs network access and an available deployed proxy.

The configured public Worker must be redeployed to receive the route-selection improvements. It first requests up to three `cycling-regular` alternatives and, if that yields fewer than two distinct routes, requests a `cycling-road` alternative as a fallback. Route providers can still decline to produce a distinct second route for a particular trip; the app will not fabricate a path to fill that gap.

## APIs and credentials

- **OpenRouteService (ORS):** The existing Cloudflare Worker requests up to three `cycling-regular` alternatives, plus surface, road-type, and steepness extras. Its ORS credential is a Worker secret and is never sent to the browser.
- **Open-Meteo:** Forecasts are requested from `https://api.open-meteo.com/v1/forecast` for the chosen departure hour. The public forecast endpoint needs no API key. Requests are rounded to a 0.01-degree location grid, deduplicated while in flight, cached for 15 minutes, and refreshed every 30 minutes while a route is displayed. Changing the route or departure time refreshes the forecast and route scores.
- **OpenStreetMap:** The existing Calgary network is used for mapped cycling infrastructure and, where present, highway, surface, cycleway, incline, and elevation tags. OSM data attribution remains on the map.

To use your own ORS deployment:

1. Install the Cloudflare Wrangler CLI and authenticate it.
2. From `worker/`, set the Worker-only credential: `npx wrangler secret put ORS_KEY`.
3. Add your static site's exact origin to `ALLOWED_ORIGINS` in `worker/src/index.js` if it is not already listed, and update `PROXY_URL` in `web/routing.js` to the Worker URL.
4. From `worker/`, deploy the worker with `npx wrangler deploy`.

For local Worker development, copy `worker/.dev.vars.example` to `worker/.dev.vars`, put your ORS key in that local ignored file, and run `npx wrangler dev`. Point `PROXY_URL` to the local Worker URL while testing. Do not commit `.dev.vars` or put an ORS key in frontend code.

The checked-in `data/network.geojson` has been regenerated from the included OSM extract and now retains available highway, surface, cycleway, incline, and elevation tags. Elevation tags are sparse in the source, so route elevation may still be unavailable. To refresh the network after updating `Scraping/inputs/calgary_cycling_permissive.geojson`, run:

```sh
python3 Scraping/merge.py
```

That full merge also fetches the City of Calgary closure feed. `python3 Scraping/refresh_closures.py` refreshes closures only.

## Scoring and trip estimates

Route scores are deterministic comparisons, not safety ratings. The 100-point weighting is:

| Input | Weight |
|---|---:|
| Mapped road class, surface, and cycleway tags | 25 |
| Mapped cycling infrastructure and bicycle access | 25 |
| Forecast precipitation, headwind, gusts, and temperature | 25 |
| Route distance against a fixed 5 km benchmark | 15 |
| Route ascent, ORS steepness, or mapped incline/elevation, when available | 10 |

Every trip uses the same fixed rubric; adding or removing competing options does not change an existing route's score. Distance earns up to 15 points using `min(1, 5 km / route distance)`. Missing data earns no points and is not inferred; the UI separately reports how many of the 100 benchmark points had data. Open-Meteo forecast warnings are advisory; route scores do not guarantee a safe route. ORS may return fewer than three options, and the fallback cannot guarantee a distinct second route for every trip.

Every completed ride earns 10 points per kilometre when it is logged; no transport alternative or car-replacement confirmation is requested. Because the app no longer collects an alternative mode for new rides, it does not claim new CO₂ savings. Any pre-existing CO₂ estimates remain in history and the dashboard. Ride history and the route geometry selected when logging are stored in browser local storage and do not sync across devices. Select **Show route** on a saved ride to display and zoom to its recorded path; earlier rides saved before route storage was added remain in history but do not have a path to display.

Weather attribution: [Open-Meteo](https://open-meteo.com). Road-network data: © OpenStreetMap contributors, ODbL.

## Checks

Run the focused JavaScript tests:

```sh
node --test tests/*.test.js
```

Run the OSM pipeline test with the project's configured Python:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
```

The repository does not currently define a frontend build or lint command; the app is served as static files. The Python data pipeline uses its existing environment/dependencies.
