import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from functools import partial
from http.server import ThreadingHTTPServer

import polars as pl

import tidal
from generate_calendar_data import build_calendar_data
from server import CalendarCache, Handler


def fake_predictions(**kwargs):
    start = datetime.strptime(kwargs['begin'], '%Y%m%d %H:%M').replace(tzinfo=UTC)
    end = datetime.strptime(kwargs['end'], '%Y%m%d %H:%M').replace(tzinfo=UTC)
    times = pl.datetime_range(start, end, interval='5m', eager=True)
    # Vary across the full period so annual normalization can be checked.
    return pl.DataFrame({'t': times, 'v': [(value.toordinal() % 31) / 10 for value in times]})


class CalendarTests(unittest.TestCase):
    @patch('tidal.noaa_tides', side_effect=fake_predictions)
    def test_leap_year_and_timezone_boundaries(self, request):
        data = build_calendar_data(2024, station_id='8518750')
        self.assertEqual(len(data['records']), 732)
        self.assertEqual(data['station']['timezone'], 'America/New_York')
        self.assertEqual(data['records'][0]['date'], '2024-01-01')
        self.assertEqual(data['records'][-1]['date'], '2024-12-31')
        self.assertEqual(len({(r['date'], r['daytime']) for r in data['records']}), 732)
        for record in data['records']:
            sun = datetime.fromisoformat(record['sun_time'])
            tide = datetime.fromisoformat(record['tide_time'])
            self.assertIsNotNone(tide.utcoffset())
            self.assertLessEqual(abs((sun.astimezone(UTC) - tide.astimezone(UTC)).total_seconds()), 150)
            self.assertGreaterEqual(record['normalized_amplitude'], -1)
            self.assertLessEqual(record['normalized_amplitude'], 1)
        offsets = {datetime.fromisoformat(r['tide_time']).utcoffset() for r in data['records']}
        self.assertEqual(offsets, {timedelta(hours=-5), timedelta(hours=-4)})
        self.assertTrue(all(call.kwargs['station'] == '8518750' for call in request.call_args_list))
        self.assertTrue(all(call.kwargs['time_zone'] == 'gmt' for call in request.call_args_list))

    @patch('tidal.noaa_tides', side_effect=fake_predictions)
    def test_sunrise_only(self, request):
        data = build_calendar_data(2026, daytime='sunrise')
        self.assertEqual(len(data['records']), 365)
        self.assertEqual({r['daytime'] for r in data['records']}, {'sunrise'})

    def test_invalid_selection(self):
        for year, station in [(1800, '9410840'), (2026, '../../invalid')]:
            with self.assertRaises(ValueError):
                build_calendar_data(year, station_id=station)
        with self.assertRaises(ValueError):
            build_calendar_data(2026, interval='hilo')

    @patch('tidal.requests.get')
    def test_noaa_error_payload(self, request):
        request.return_value.json.return_value = {'error': {'message': 'No predictions available.'}}
        with self.assertRaisesRegex(tidal.NOAAError, 'No predictions available'):
            tidal.noaa_tides()

    @patch('tidal.noaa_tides', side_effect=lambda **kwargs: fake_predictions(**kwargs).head(1))
    def test_incomplete_predictions_are_rejected(self, request):
        with self.assertRaises(tidal.NOAAError):
            build_calendar_data(2026)


class CacheTests(unittest.TestCase):
    def test_coalescing_disk_cache_and_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CalendarCache(Path(directory))
            entered = threading.Event()
            release = threading.Event()
            def build(*args, **kwargs):
                entered.set()
                release.wait(5)
                return {'year': 2026}
            try:
                with patch('server.build_calendar_data', side_effect=build) as builder:
                    with ThreadPoolExecutor(max_workers=4) as callers:
                        futures = [callers.submit(cache.get, '9410840', 2026) for _ in range(4)]
                        self.assertTrue(entered.wait(5))
                        release.set()
                        self.assertEqual([f.result() for f in futures], [{'year': 2026}] * 4)
                    self.assertEqual(builder.call_count, 1)
                    self.assertEqual(cache.get('9410840', 2026), {'year': 2026})
                    self.assertEqual(builder.call_count, 1)
                    import os
                    path = next(Path(directory).glob('*.json'))
                    os.utime(path, (0, 0))
                    cache.get('9410840', 2026)
                    self.assertEqual(builder.call_count, 2)
            finally:
                cache.executor.shutdown()

    def test_upstream_failure_can_be_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CalendarCache(Path(directory))
            try:
                with patch('server.build_calendar_data', side_effect=[tidal.NOAAError('Unavailable'), {'year': 2026}]):
                    with self.assertRaises(tidal.NOAAError):
                        cache.get('9410840', 2026)
                    self.assertEqual(cache.get('9410840', 2026), {'year': 2026})
            finally:
                cache.executor.shutdown()


class HTTPTests(unittest.TestCase):
    def test_routes_validation_and_cors(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = CalendarCache(Path(directory))
            handler = partial(Handler, cache=cache, origins={'https://floraths.github.io'})
            with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f'http://127.0.0.1:{server.server_port}'
                try:
                    with urlopen(Request(base + '/api/stations', headers={'Origin': 'https://floraths.github.io'})) as response:
                        self.assertEqual(len(json.load(response)['stations']), 6)
                        self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://floraths.github.io')
                    with urlopen(Request(base + '/api/health', headers={'Origin': 'https://example.com'})) as response:
                        self.assertIsNone(response.headers.get('Access-Control-Allow-Origin'))
                    for query in ['year=1800', 'year=abc', 'year=2026&station=bad', 'year=2026&year=2027']:
                        with self.assertRaises(HTTPError) as error:
                            urlopen(base + '/api/calendar?' + query)
                        self.assertEqual(error.exception.code, 400)
                    with patch('server.build_calendar_data', return_value={'year': 2026}):
                        with urlopen(base + '/api/calendar?year=2026') as response:
                            self.assertEqual(json.load(response), {'year': 2026})
                    with urlopen(base + '/') as response:
                        self.assertIn(b'stationSelect', response.read())
                finally:
                    server.shutdown()
                    thread.join()
                    cache.executor.shutdown()


if __name__ == '__main__':
    unittest.main()
