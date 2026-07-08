from datetime import date

import polars as pl
import requests
from astral import LocationInfo, moon
from astral.sun import sun

url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
base_params = {
    'station': '9410840',  # Santa Monica
    'application': 'my_app',
    'datum': 'MLLW',
    'units': 'metric',
    'format': 'json',
}

city = LocationInfo(
    'Santa Monica',
    'USA',
    'America/Los_Angeles',
    34.0195,
    -118.4912,
)


def noaa_tides(begin='20260624', end='20260626', interval='6', time_zone='lst_ldt'):

    params = {
        **base_params,
        'product': 'predictions',
        'begin_date': begin,
        'end_date': end,
        'interval': interval,
        'time_zone': time_zone,
    }

    r = requests.get(url, params=params)
    r.raise_for_status()
    js = r.json()

    df = pl.DataFrame(js['predictions'])
    df = df.with_columns(pl.col('t').str.to_datetime('%Y-%m-%d %H:%M')).cast({'v': pl.Float64})
    return df


def normalize_amplitude(df):
    mean = df['v'].mean()
    df = df.with_columns((pl.col('v') - mean).alias('v_centered')).with_columns(
        (
            2
            * (
                (pl.col('v_centered') - pl.col('v_centered').min())
                / (pl.col('v_centered').max() - pl.col('v_centered').min())
            )
            - 1
        ).alias('amplitude')
    )

    return df


def col_to_hour(df, time_col, new_col_name=None):
    new_col_name = new_col_name or f'{time_col}_hour'
    df = df.with_columns((pl.col(time_col).dt.hour() + pl.col(time_col).dt.minute() / 60).alias(new_col_name))
    return df


def get_sun_times(dates):

    res = []
    for day in dates:
        y, m, d = day.strftime('%Y-%m-%d').split('-')

        s = sun(city.observer, date=date(int(y), int(m), int(d)), tzinfo=city.timezone)

        sunrise = s['sunrise']  # .isoformat()[11:16]
        sunset = s['sunset']  # .isoformat()[11:16]

        sun_times = {'date': day, 'sunrise': sunrise, 'sunset': sunset}

        p = moon.phase(date(int(y), int(m), int(d)))

        sun_times['moon_phase'] = p
        sun_times['moon_phase_name'] = moon_phase_name(p)
        res.append(sun_times)

    sun_times = pl.DataFrame(res)
    sun_times = sun_times.with_columns(pl.col('sunrise').dt.truncate('1m'))
    sun_times = sun_times.with_columns(pl.col('sunset').dt.truncate('1m'))

    for col in ['sunrise', 'sunset']:
        sun_times = col_to_hour(sun_times, col)

    return sun_times


def moon_phase_name(p):
    moon_phases = {
        'New Moon': lambda p: p < 1.75 or p >= 26.25,
        'Waxing Crescent': lambda p: 1.75 <= p < 5.25,
        'First Quarter': lambda p: 5.25 <= p < 8.75,
        'Waxing Gibbous': lambda p: 8.75 <= p < 12.25,
        'Full Moon': lambda p: 12.25 <= p < 15.75,
        'Waning Gibbous': lambda p: 15.75 <= p < 19.25,
        'Last Quarter': lambda p: 19.25 <= p < 22.75,
        'Waning Crescent': lambda p: 22.75 <= p < 26.25,
    }

    return next(name for name, condition in moon_phases.items() if condition(p))
