from __future__ import annotations

import argparse
import json
from bisect import bisect_left
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import polars as pl

import tidal
from stations import DEFAULT_STATION, STATIONS, get_station, station_location

DAYTIMES = ('sunrise', 'sunset')
INTERVALS = ('1', '5', '6', '10', '15', '30', '60')
PROJECT_ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Generate static tide calendar data for the GitHub Pages site.',
    )
    parser.add_argument('--year', type=int, default=2026, help='Calendar year to generate.')
    parser.add_argument('--station', choices=STATIONS, default=DEFAULT_STATION, help='NOAA station ID.')
    parser.add_argument(
        '--daytime',
        choices=(*DAYTIMES, 'both'),
        default='both',
        help='Which solar event to match against tide predictions.',
    )
    parser.add_argument(
        '--interval',
        choices=INTERVALS,
        default='5',
        help='NOAA prediction interval in minutes. The notebook used 5.',
    )
    parser.add_argument(
        '--output',
        type=Path,
        help='Output JSON path. Defaults to docs/data/tides-{year}.json.',
    )
    return parser.parse_args()


def build_calendar_data(
    year: int,
    interval: str = '5',
    daytime: str = 'both',
    station_id: str = DEFAULT_STATION,
) -> dict[str, Any]:
    if not 1900 <= year <= 2100:
        raise ValueError('Year must be between 1900 and 2100.')
    if daytime not in (*DAYTIMES, 'both'):
        raise ValueError('Choose sunrise, sunset, or both.')
    if interval not in INTERVALS:
        raise ValueError('Choose a supported prediction interval in minutes.')
    station = get_station(station_id)
    location = station_location(station_id)
    tz = ZoneInfo(location.timezone)
    # UTC requests avoid ambiguous local timestamps at the autumn DST transition.
    start = datetime(year, 1, 1, tzinfo=tz).astimezone(UTC)
    end = datetime(year + 1, 1, 1, tzinfo=tz).astimezone(UTC) - timedelta(minutes=1)
    daytimes = DAYTIMES if daytime == 'both' else (daytime,)

    # NOAA limits interval predictions to one year per request. Half-year chunks
    # also keep responses small and cover leap years without exceeding that limit.
    frames = []
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=180) - timedelta(minutes=1), end)
        frames.append(tidal.noaa_tides(
            begin=cursor.strftime('%Y%m%d %H:%M'),
            end=chunk_end.strftime('%Y%m%d %H:%M'),
            interval=interval,
            time_zone='gmt',
            station=station_id,
        ))
        cursor = chunk_end + timedelta(minutes=1)
    predictions = pl.concat(frames).unique(subset='t').sort('t')
    predictions = tidal.normalize_amplitude(predictions)

    day_count = (date(year + 1, 1, 1) - date(year, 1, 1)).days
    dates = [date(year, 1, 1) + timedelta(days=i) for i in range(day_count)]
    sun_times = tidal.get_sun_times(dates, location).sort('date')
    samples = predictions.to_dicts()
    timestamps = [sample['t'] for sample in samples]

    records = []
    for row in sun_times.iter_rows(named=True):
        for event_name in daytimes:
            target = row[event_name]
            target_utc = target.astimezone(UTC)
            index = bisect_left(timestamps, target_utc)
            candidates = samples[max(0, index - 1):min(len(samples), index + 1)]
            tide = min(candidates, key=lambda sample: abs(sample['t'] - target_utc))
            if abs(tide['t'] - target_utc) > timedelta(minutes=int(interval)):
                raise tidal.NOAAError('NOAA predictions are incomplete for this year. Please try again.')
            tide_time = tide['t'].astimezone(tz)
            tide_date = row['date']

            records.append(
                {
                    'date': tide_date.isoformat(),
                    'day': tide_date.day,
                    'month': tide_date.month,
                    'month_name': tide_time.strftime('%B'),
                    'quarter': (tide_date.month - 1) // 3 + 1,
                    'week': tide_date.isocalendar().week,
                    'weekday': tide_date.isoweekday(),
                    'weekday_name': tide_time.strftime('%A'),
                    'daytime': event_name,
                    'sun_time': target.isoformat(),
                    'tide_time': tide_time.isoformat(),
                    'delta_minutes': round(abs((tide['t'] - target_utc).total_seconds()) / 60, 3),
                    'height_m': round(tide['v'], 4),
                    'normalized_amplitude': round(tide['amplitude'], 6),
                    'moon_phase': round(row['moon_phase'], 4),
                    'moon_phase_name': row['moon_phase_name'],
                }
            )

    records.sort(key=lambda item: (item['date'], item['daytime']))

    return {
        'generated_at': datetime.now(UTC).isoformat(),
        'year': year,
        'station': station,
        'source': {
            'name': 'NOAA Tides and Currents predictions',
            'url': tidal.url,
            'interval_minutes': int(interval),
            'time_zone': 'gmt',
        },
        'amplitude': {
            'field': 'normalized_amplitude',
            'min': -1,
            'max': 1,
            'description': 'NOAA tide height centered and scaled over the generated year.',
        },
        'records': records,
    }


def write_json(data: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')


def main() -> None:
    args = parse_args()
    suffix = '' if args.station == DEFAULT_STATION else f'-{args.station}'
    output_path = args.output or PROJECT_ROOT / 'docs' / 'data' / f'tides-{args.year}{suffix}.json'
    data = build_calendar_data(args.year, args.interval, args.daytime, args.station)
    write_json(data, output_path)
    print(f'Wrote {len(data["records"])} records to {output_path}')


if __name__ == '__main__':
    main()
