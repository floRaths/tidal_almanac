from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import polars as pl

import tidal


DAYTIMES = ("sunrise", "sunset")
PROJECT_ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate static tide calendar data for the GitHub Pages site.",
    )
    parser.add_argument("--year", type=int, default=2026, help="Calendar year to generate.")
    parser.add_argument(
        "--daytime",
        choices=(*DAYTIMES, "both"),
        default="both",
        help="Which solar event to match against tide predictions.",
    )
    parser.add_argument(
        "--interval",
        default="5",
        help="NOAA prediction interval in minutes. The notebook used 5.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output JSON path. Defaults to docs/data/tides-{year}.json.",
    )
    return parser.parse_args()


def build_calendar_data(year: int, interval: str, daytime: str) -> dict[str, Any]:
    begin = f"{year}0101"
    end = f"{year}1231"
    daytimes = DAYTIMES if daytime == "both" else (daytime,)

    predictions = tidal.noaa_tides(begin=begin, end=end, interval=interval)
    predictions = tidal.normalize_amplitude(predictions)

    dates = predictions.select(pl.col("t").dt.date().unique().sort()).to_series().to_list()
    sun_times = tidal.get_sun_times(dates).sort("date")

    records = []
    for row in sun_times.iter_rows(named=True):
        for event_name in daytimes:
            target = row[event_name]
            target_naive = target.replace(tzinfo=None)
            tide = nearest_tide(predictions, target_naive)
            tide_time = tide["t"]
            tide_date = tide_time.date()

            records.append(
                {
                    "date": tide_date.isoformat(),
                    "day": tide_date.day,
                    "month": tide_date.month,
                    "month_name": tide_time.strftime("%B"),
                    "quarter": (tide_date.month - 1) // 3 + 1,
                    "week": tide_date.isocalendar().week,
                    "weekday": tide_date.isoweekday(),
                    "weekday_name": tide_time.strftime("%A"),
                    "daytime": event_name,
                    "sun_time": target.isoformat(),
                    "tide_time": tide_time.isoformat(),
                    "delta_minutes": round(abs((tide_time - target_naive).total_seconds()) / 60, 3),
                    "height_m": round(tide["v"], 4),
                    "normalized_amplitude": round(tide["amplitude"], 6),
                    "moon_phase": round(row["moon_phase"], 4),
                    "moon_phase_name": row["moon_phase_name"],
                }
            )

    records.sort(key=lambda item: (item["date"], item["daytime"]))

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "year": year,
        "station": {
            "id": tidal.base_params["station"],
            "name": tidal.city.name,
            "region": tidal.city.region,
            "timezone": tidal.city.timezone,
            "latitude": tidal.city.latitude,
            "longitude": tidal.city.longitude,
            "datum": tidal.base_params["datum"],
            "units": tidal.base_params["units"],
        },
        "source": {
            "name": "NOAA Tides and Currents predictions",
            "url": tidal.url,
            "interval_minutes": int(interval),
            "time_zone": "lst_ldt",
        },
        "amplitude": {
            "field": "normalized_amplitude",
            "min": -1,
            "max": 1,
            "description": "NOAA tide height centered and scaled over the generated year.",
        },
        "records": records,
    }


def nearest_tide(predictions: pl.DataFrame, target: datetime) -> dict[str, Any]:
    return (
        predictions.with_columns((pl.col("t") - pl.lit(target)).abs().alias("delta"))
        .sort("delta")
        .drop("delta")
        .row(0, named=True)
    )


def write_json(data: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    output_path = args.output or PROJECT_ROOT / "docs" / "data" / f"tides-{args.year}.json"
    data = build_calendar_data(args.year, args.interval, args.daytime)
    write_json(data, output_path)
    print(f"Wrote {len(data['records'])} records to {output_path}")


if __name__ == "__main__":
    main()
