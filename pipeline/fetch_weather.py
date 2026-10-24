"""
Fetch historical weather data from Open-Meteo.

Open-Meteo provides free historical weather data by location and date.
API docs: https://open-meteo.com/en/docs/historical-weather-api
"""

import logging
from datetime import datetime, timedelta, date
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from collections import defaultdict

from tqdm import tqdm

from .config import OPEN_METEO_HISTORICAL, RAW_DIR, RATE_LIMITS
from .utils import RateLimiter, CacheManager, fetch_with_retry, save_json, logger

logger = logging.getLogger(__name__)


class OpenMeteoFetcher:
    """Fetcher for Open-Meteo historical weather data."""
    
    def __init__(self, cache_dir: Optional[Path] = None):
        self.base_url = OPEN_METEO_HISTORICAL
        self.rate_limiter = RateLimiter(RATE_LIMITS["open_meteo"])
        self.cache_dir = cache_dir or RAW_DIR / "open_meteo_cache"
        self.cache = CacheManager(self.cache_dir)
    
    def fetch_weather_for_location(
        self,
        lat: float,
        lon: float,
        start_date: date,
        end_date: date,
        station_id: Optional[int] = None,
        use_cache: bool = True
    ) -> Dict[str, Any]:
        """
        Fetch historical weather for a specific location and date range.
        
        Returns hourly data with:
        - time: ISO timestamp
        - temperature_2m: temperature at 2m (°C)
        - precipitation: precipitation amount (mm)
        - cloud_cover: total cloud cover (%)
        - cloud_cover_low, cloud_cover_mid, cloud_cover_high
        - visibility: visibility (m)
        - wind_speed_10m: wind speed at 10m (km/h)
        - relative_humidity_2m: relative humidity (%)
        
        Args:
            lat: Latitude
            lon: Longitude
            start_date: Start date
            end_date: End date
            station_id: Optional station ID for caching
            use_cache: Whether to use cached data
        
        Returns:
            Dict with hourly weather data
        """
        cache_key = f"weather_{lat:.2f}_{lon:.2f}_{start_date}_{end_date}"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                return cached
        
        params = {
            "latitude": lat,
            "longitude": lon,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "hourly": ",".join([
                "temperature_2m",
                "precipitation",
                "cloud_cover",
                "cloud_cover_low",
                "cloud_cover_mid", 
                "cloud_cover_high",
                "visibility",
                "wind_speed_10m",
                "relative_humidity_2m"
            ]),
            "timezone": "UTC"
        }
        
        try:
            response = fetch_with_retry(
                self.base_url,
                params=params,
                rate_limiter=self.rate_limiter,
                timeout=60
            )
            data = response.json()
            
            # Add location info
            data["station_id"] = station_id
            data["request_lat"] = lat
            data["request_lon"] = lon
            
            self.cache.set(cache_key, data)
            return data
            
        except Exception as e:
            logger.error(f"Error fetching weather for ({lat}, {lon}): {e}")
            return {}
    
    def fetch_weather_for_stations(
        self,
        stations: List[Dict[str, Any]],
        start_date: date,
        end_date: date,
        use_cache: bool = True
    ) -> Dict[int, Dict[str, Any]]:
        """
        Fetch weather data for multiple stations.
        
        Args:
            stations: List of station dicts with id, lat, lng/lon
            start_date: Start date
            end_date: End date
            use_cache: Whether to use cached data
        
        Returns:
            Dict mapping station ID to weather data
        """
        logger.info(f"Fetching weather for {len(stations)} stations...")
        
        weather_by_station = {}
        
        for station in tqdm(stations, desc="Fetching station weather"):
            station_id = station.get("id")
            lat = station.get("lat") or station.get("latitude")
            lon = station.get("lng") or station.get("lon") or station.get("longitude")
            
            if station_id is None or lat is None or lon is None:
                continue
            
            weather = self.fetch_weather_for_location(
                lat=float(lat),
                lon=float(lon),
                start_date=start_date,
                end_date=end_date,
                station_id=station_id,
                use_cache=use_cache
            )
            
            if weather:
                weather_by_station[station_id] = weather
        
        logger.info(f"Fetched weather for {len(weather_by_station)} stations")
        return weather_by_station
    
    def get_weather_at_time(
        self,
        weather_data: Dict[str, Any],
        target_time: datetime
    ) -> Optional[Dict[str, Any]]:
        """
        Extract weather conditions at a specific time from hourly data.
        
        Returns the hourly record closest to the target time.
        """
        if not weather_data or "hourly" not in weather_data:
            return None
        
        hourly = weather_data["hourly"]
        times = hourly.get("time", [])
        
        if not times:
            return None
        
        # Find closest time
        target_str = target_time.strftime("%Y-%m-%dT%H:00")
        
        try:
            idx = times.index(target_str)
        except ValueError:
            # Find nearest hour
            min_diff = float("inf")
            idx = 0
            for i, t in enumerate(times):
                try:
                    t_dt = datetime.fromisoformat(t)
                    diff = abs((t_dt - target_time).total_seconds())
                    if diff < min_diff:
                        min_diff = diff
                        idx = i
                except (ValueError, TypeError):
                    continue
        
        # Extract values at this index
        result = {"time": times[idx]}
        for key in hourly:
            if key != "time" and isinstance(hourly[key], list) and idx < len(hourly[key]):
                result[key] = hourly[key][idx]
        
        return result


def fetch_weather_data(
    stations: List[Dict[str, Any]],
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    use_cache: bool = True
) -> Dict[str, Any]:
    """
    Main function to fetch weather data for stations.
    
    Args:
        stations: List of station dicts
        start_date: Start date (defaults to 90 days ago)
        end_date: End date (defaults to today)
        use_cache: Whether to use cached data
    
    Returns dict with:
    - weather_by_station: dict mapping station ID to weather data
    - stats: fetch statistics
    """
    if end_date is None:
        end_date = date.today()
    if start_date is None:
        start_date = end_date - timedelta(days=90)
    
    fetcher = OpenMeteoFetcher()
    
    weather_by_station = fetcher.fetch_weather_for_stations(
        stations=stations,
        start_date=start_date,
        end_date=end_date,
        use_cache=use_cache
    )
    
    # Calculate stats
    total_hours = 0
    stations_with_data = 0
    
    for station_id, weather in weather_by_station.items():
        if weather and "hourly" in weather:
            hours = len(weather["hourly"].get("time", []))
            total_hours += hours
            if hours > 0:
                stations_with_data += 1
    
    stats = {
        "stations_requested": len(stations),
        "stations_with_data": stations_with_data,
        "total_hourly_records": total_hours,
        "date_range": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat()
        }
    }
    
    # Save raw data
    save_json(weather_by_station, RAW_DIR / "open_meteo_weather_raw.json")
    
    return {
        "weather_by_station": weather_by_station,
        "stats": stats
    }


if __name__ == "__main__":
    # Test with sample stations
    test_stations = [
        {"id": 1, "lat": 51.5074, "lng": -0.1278, "name": "London"},
        {"id": 2, "lat": 40.7128, "lng": -74.0060, "name": "New York"},
    ]
    
    result = fetch_weather_data(
        stations=test_stations,
        start_date=date.today() - timedelta(days=7),
        end_date=date.today()
    )
    
    print(f"Fetched weather for {result['stats']['stations_with_data']} stations")
    print(f"Total hourly records: {result['stats']['total_hourly_records']}")
