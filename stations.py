"""Supported NOAA harmonic stations and their IANA display time zones."""

from astral import LocationInfo

STATIONS = {
    '9410840': {'name': 'Santa Monica', 'region': 'California, USA', 'timezone': 'America/Los_Angeles', 'latitude': 34.0083, 'longitude': -118.5},
    '9410230': {'name': 'La Jolla', 'region': 'California, USA', 'timezone': 'America/Los_Angeles', 'latitude': 32.8669, 'longitude': -117.2571},
    '9414290': {'name': 'San Francisco', 'region': 'California, USA', 'timezone': 'America/Los_Angeles', 'latitude': 37.8063, 'longitude': -122.4659},
    '9447130': {'name': 'Seattle', 'region': 'Washington, USA', 'timezone': 'America/Los_Angeles', 'latitude': 47.6026, 'longitude': -122.3393},
    '8518750': {'name': 'The Battery', 'region': 'New York, USA', 'timezone': 'America/New_York', 'latitude': 40.7006, 'longitude': -74.0142},
    '8443970': {'name': 'Boston', 'region': 'Massachusetts, USA', 'timezone': 'America/New_York', 'latitude': 42.35389, 'longitude': -71.05028},
}
DEFAULT_STATION = '9410840'


def get_station(station_id: str) -> dict:
    if station_id not in STATIONS:
        raise ValueError('Choose a supported NOAA station.')
    return {'id': station_id, **STATIONS[station_id], 'datum': 'MLLW', 'units': 'metric'}


def station_location(station_id: str) -> LocationInfo:
    station = get_station(station_id)
    return LocationInfo(*(station[key] for key in ('name', 'region', 'timezone', 'latitude', 'longitude')))
