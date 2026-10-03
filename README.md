# Tidal Almanac

A calendar of NOAA predicted tide heights nearest sunrise or sunset, with moon
phase information. Circle size and color encode tide height scaled over the
**whole selected year**, rather than independently for each month. Heights are
meters relative to Mean Lower Low Water (MLLW).

The HTML/CSS/JavaScript interface can stay on GitHub Pages. A separate Python
service calculates calendars on demand using NOAA, Astral, and Polars. The first
version supports Santa Monica, La Jolla, San Francisco, Seattle, The Battery, and
Boston; station coordinates come from NOAA's metadata API. These are station
predictions, not observed water levels or predictions for arbitrary coordinates.

## Run locally

Requires Python 3.13+ and [uv](https://docs.astral.sh/uv/).

```sh
uv sync --frozen
uv run server.py
```

Open http://127.0.0.1:8000. Select a location and year, then **Load calendar**.
The initial request downloads a year of predictions in up to three chunks;
subsequent requests reuse the server cache. Months and sunrise/sunset switch
immediately without contacting the API. Supported input years are 1900–2100,
subject to NOAA's prediction availability for the selected station.

## API

- `GET /api/health`: process health (does not contact NOAA).
- `GET /api/stations`: station metadata and allowed year range.
- `GET /api/calendar?station=9410840&year=2027`: both solar events for every day.

Calendars retain the static JSON schema with offset-aware tide timestamps and
station-specific coordinates/time zones. NOAA requests and matching use UTC;
displayed dates and timestamps use the station's time zone, including DST.
Missing predictions and upstream failures return an error rather than a partial
calendar. Annual min/max come from all tide samples, not just the solar events.

Calendars are cached on disk for seven days, with atomic writes. Concurrent
requests for the same station/year share one calculation; up to two calculations
run at once and at most eight distinct requests are pending per process. Browser
results are reused for one hour within the current tab. API errors are not cached.
The UI retains the previous successful calendar on failure and offers Retry.

## Deploy the backend and connect GitHub Pages

The repository includes a Dockerfile for a Python backend host supporting HTTPS.
Build and run it locally with:

```sh
docker build -t tidal-almanac .
docker run --rm -p 8000:8000 -e ALLOWED_ORIGINS=https://floraths.github.io tidal-almanac
```

Backend environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `PORT` | `8000` | Host-assigned port |
| `CACHE_DIR` | `.cache/calendars` | Attach persistent storage here to retain cached calendars across restarts |
| `ALLOWED_ORIGINS` | `https://floraths.github.io` | Comma-separated frontend origins, including a custom domain if used; no path or trailing slash |

After deploying the backend, edit **docs/config.js**:

```js
window.TIDAL_CONFIG = {
  apiBaseUrl: "https://your-backend.example.com",
};
```

Use the backend's origin, without `/api` or a trailing slash. Publish `docs/` using
your existing GitHub Pages configuration. GitHub Pages cannot run this Python
service; publishing the frontend alone does not activate the live API.

Until a backend URL is configured, the hosted page keeps showing the bundled
Santa Monica 2026 calendar and explains why location/year controls are unavailable.
On localhost, an empty URL automatically uses the local Python service. For a
remote same-origin deployment, set `apiBaseUrl` to that deployment's origin.

The service includes a local static preview server. In production, let the hosting
platform provide HTTPS and request limits, and use one service process per cache
volume: request coalescing is process-local. Cold calendar requests can take a few
minutes, so choose a host that allows sufficiently long HTTP requests (the browser
waits up to five minutes). The API sends CORS headers only for configured origins;
CORS is not authentication. The public station/year API needs no API keys.

## Generate a static calendar

The original offline workflow is still supported:

```sh
uv run generate_calendar_data.py --year 2027
uv run generate_calendar_data.py --station 8518750 --year 2027 --output /tmp/battery-2027.json
```

## Verify

```sh
uv run python -m unittest discover -s tests -v
node --check docs/main.js
node tests/test_frontend.cjs
```

Python tests use synthetic NOAA samples to check leap years, DST, incomplete
responses, disk-cache reuse/expiry, concurrent requests, HTTP validation, and CORS.
Frontend tests cover selection/loading, cached results, failures/retry, the saved
calendar fallback, and chronological calendar rows at ISO year boundaries.

Sources: [NOAA Data API](https://api.tidesandcurrents.noaa.gov/api/prod/),
[NOAA Station Metadata](https://api.tidesandcurrents.noaa.gov/mdapi/prod/).
