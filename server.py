"""Local preview and deployable calendar API. Run with `uv run server.py`."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import tidal
from generate_calendar_data import build_calendar_data
from stations import DEFAULT_STATION, STATIONS, get_station

ROOT = Path(__file__).resolve().parent
CACHE_VERSION = 'v1'
CACHE_TTL = 7 * 24 * 60 * 60


class CalendarCache:
    def __init__(self, directory: Path):
        self.directory = directory
        self.lock = threading.Lock()
        self.pending = {}
        # Bound upstream work; concurrent callers share the same in-flight result.
        self.executor = ThreadPoolExecutor(max_workers=2)

    def read(self, path):
        try:
            if time.time() - path.stat().st_mtime < CACHE_TTL:
                return json.loads(path.read_text())
        except (OSError, ValueError):
            pass
        return None

    def get(self, station, year):
        get_station(station)
        if not 1900 <= year <= 2100:
            raise ValueError('Year must be between 1900 and 2100.')
        path = self.directory / f'{CACHE_VERSION}-{station}-{year}.json'
        data = self.read(path)
        if data is not None:
            return data
        key = (station, year)
        with self.lock:
            future = self.pending.get(key)
            if future is None:
                if len(self.pending) >= 8:
                    raise BusyError('The calendar service is busy. Please try again shortly.')
                future = self.executor.submit(self.generate, station, year, path)
                self.pending[key] = future
        try:
            return future.result()
        finally:
            with self.lock:
                if self.pending.get(key) is future:
                    del self.pending[key]

    def generate(self, station, year, path):
        # Recheck after queued work starts in case another request filled the cache.
        data = self.read(path)
        if data is None:
            data = build_calendar_data(year, station_id=station)
            self.directory.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix('.tmp')
            temp.write_text(json.dumps(data))
            temp.replace(path)
        return data


class BusyError(RuntimeError):
    pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, cache, origins, **kwargs):
        self.cache = cache
        self.origins = origins
        super().__init__(*args, directory=str(ROOT / 'docs'), **kwargs)

    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin in self.origins:
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == '/api/health':
            return self.send_json(200, {'status': 'ok'})
        if url.path == '/api/stations':
            return self.send_json(200, {'stations': [get_station(key) for key in STATIONS], 'min_year': 1900, 'max_year': 2100})
        if url.path == '/api/calendar':
            try:
                params = parse_qs(url.query, keep_blank_values=True)
                if set(params) - {'station', 'year'} or any(len(v) != 1 for v in params.values()):
                    raise ValueError('Provide a single station and year.')
                station = params.get('station', [DEFAULT_STATION])[0]
                year = int(params.get('year', [''])[0])
                data = self.cache.get(station, year)
                return self.send_json(200, data)
            except ValueError as exc:
                return self.send_json(400, {'error': str(exc)})
            except BusyError as exc:
                return self.send_json(503, {'error': str(exc)})
            except tidal.NOAAError as exc:
                return self.send_json(502, {'error': str(exc)})
            except Exception:
                logging.exception('Calendar generation failed')
                return self.send_json(500, {'error': 'Could not calculate this calendar. Please try again.'})
        if url.path.startswith('/api/'):
            return self.send_json(404, {'error': 'API route not found.'})
        super().do_GET()


def main():
    cache = CalendarCache(Path(os.environ.get('CACHE_DIR', ROOT / '.cache' / 'calendars')))
    origins = set(os.environ.get('ALLOWED_ORIGINS', 'https://floraths.github.io').split(','))
    handler = partial(Handler, cache=cache, origins={origin.strip() for origin in origins})
    address = (os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8000')))
    with ThreadingHTTPServer(address, handler) as server:
        print(f'Tidal Almanac running at http://{address[0]}:{address[1]}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            cache.executor.shutdown(wait=True)


if __name__ == '__main__':
    main()
