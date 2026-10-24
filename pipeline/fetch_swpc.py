"""
Fetch space weather data from NOAA Space Weather Prediction Center (SWPC).

SWPC provides real-time and historical data on:
- Planetary Kp index (geomagnetic activity)
- Solar X-ray flux and flare events
- Radio blackout alerts
- Geomagnetic storm warnings

API docs: https://services.swpc.noaa.gov/
"""

import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path

from .config import SWPC_BASE_URL, RAW_DIR, RATE_LIMITS
from .utils import RateLimiter, CacheManager, fetch_with_retry, save_json, logger

logger = logging.getLogger(__name__)


# SWPC data products
SWPC_PRODUCTS = {
    "kp_index": "/products/noaa-planetary-k-index.json",
    "kp_forecast": "/products/noaa-planetary-k-index-forecast.json",
    "solar_flares": "/json/goes/primary/xray-flares-latest.json",
    "xray_flux": "/json/goes/primary/xrays-6-hour.json",
    "geomag_storm": "/products/noaa-scales.json",
    "dst_index": "/products/kyoto-dst.json",
    "solar_wind": "/products/solar-wind/plasma-7-day.json",
    "radio_blackouts": "/products/alerts-watches-warnings.json",
}


class SWPCFetcher:
    """Fetcher for NOAA SWPC space weather data."""
    
    def __init__(self, cache_dir: Optional[Path] = None):
        self.base_url = SWPC_BASE_URL
        self.rate_limiter = RateLimiter(RATE_LIMITS["swpc"])
        self.cache_dir = cache_dir or RAW_DIR / "swpc_cache"
        self.cache = CacheManager(self.cache_dir)
    
    def _fetch_product(
        self, 
        product_key: str, 
        use_cache: bool = True
    ) -> Any:
        """Fetch a SWPC data product."""
        if product_key not in SWPC_PRODUCTS:
            raise ValueError(f"Unknown SWPC product: {product_key}")
        
        url = f"{self.base_url}{SWPC_PRODUCTS[product_key]}"
        
        if use_cache:
            cached = self.cache.get(url)
            if cached:
                logger.debug(f"Using cached {product_key} data")
                return cached
        
        try:
            response = fetch_with_retry(url, rate_limiter=self.rate_limiter)
            data = response.json()
            
            self.cache.set(url, data)
            return data
            
        except Exception as e:
            logger.error(f"Error fetching SWPC {product_key}: {e}")
            return None
    
    def fetch_kp_index(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch planetary Kp index data.
        
        Kp index measures global geomagnetic activity (0-9 scale).
        Higher Kp can affect radio propagation and satellite operations.
        
        Returns list of records with:
        - time_tag: timestamp
        - kp: Kp index value (0-9)
        - a_running: running average A index
        - station_count: number of reporting stations
        """
        logger.info("Fetching SWPC Kp index data...")
        
        data = self._fetch_product("kp_index", use_cache=use_cache)
        
        if data:
            # SWPC returns array with header row
            if isinstance(data, list) and len(data) > 1:
                headers = data[0] if isinstance(data[0], list) else None
                records = data[1:] if headers else data
                
                # Convert to dict format if array
                if records and isinstance(records[0], list):
                    if headers:
                        records = [dict(zip(headers, row)) for row in records]
                
                save_json(records, RAW_DIR / "swpc_kp_index_raw.json")
                logger.info(f"Fetched {len(records)} Kp index records")
                return records
        
        return []
    
    def fetch_kp_forecast(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """Fetch Kp index forecast data."""
        logger.info("Fetching SWPC Kp forecast data...")
        
        data = self._fetch_product("kp_forecast", use_cache=use_cache)
        
        if data:
            if isinstance(data, list) and len(data) > 1:
                headers = data[0] if isinstance(data[0], list) else None
                records = data[1:] if headers else data
                
                if records and isinstance(records[0], list) and headers:
                    records = [dict(zip(headers, row)) for row in records]
                
                save_json(records, RAW_DIR / "swpc_kp_forecast_raw.json")
                logger.info(f"Fetched {len(records)} Kp forecast records")
                return records
        
        return []
    
    def fetch_solar_flares(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch solar flare event data.
        
        Solar flares are classified by X-ray intensity:
        - A, B, C: minor
        - M: moderate (can cause brief radio blackouts)
        - X: major (can cause radio blackouts and radiation storms)
        
        Returns list of flare events with:
        - begin_time, max_time, end_time
        - class_type: flare class (e.g., M1.5, X2.3)
        - optical_class
        - location: solar coordinates
        """
        logger.info("Fetching SWPC solar flare data...")
        
        data = self._fetch_product("solar_flares", use_cache=use_cache)
        
        if data:
            # Data may be nested
            if isinstance(data, dict):
                data = data.get("events", data.get("data", [data]))
            
            if isinstance(data, list):
                save_json(data, RAW_DIR / "swpc_solar_flares_raw.json")
                logger.info(f"Fetched {len(data)} solar flare records")
                return data
        
        return []
    
    def fetch_xray_flux(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch X-ray flux measurements from GOES satellites.
        
        Returns time series of X-ray flux values used for flare detection.
        """
        logger.info("Fetching SWPC X-ray flux data...")
        
        data = self._fetch_product("xray_flux", use_cache=use_cache)
        
        if data:
            if isinstance(data, list):
                save_json(data, RAW_DIR / "swpc_xray_flux_raw.json")
                logger.info(f"Fetched {len(data)} X-ray flux records")
                return data
        
        return []
    
    def fetch_alerts_warnings(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch active alerts, watches, and warnings.
        
        Includes:
        - Geomagnetic storm warnings
        - Solar radiation storm warnings
        - Radio blackout alerts
        """
        logger.info("Fetching SWPC alerts and warnings...")
        
        data = self._fetch_product("radio_blackouts", use_cache=use_cache)
        
        if data:
            if isinstance(data, list):
                save_json(data, RAW_DIR / "swpc_alerts_raw.json")
                logger.info(f"Fetched {len(data)} alert records")
                return data
        
        return []
    
    def fetch_geomag_scales(self, use_cache: bool = True) -> Dict[str, Any]:
        """
        Fetch NOAA space weather scales data.
        
        Provides current conditions on:
        - R scale (Radio Blackouts, R1-R5)
        - S scale (Solar Radiation Storms, S1-S5)
        - G scale (Geomagnetic Storms, G1-G5)
        """
        logger.info("Fetching SWPC geomagnetic scales...")
        
        data = self._fetch_product("geomag_storm", use_cache=use_cache)
        
        if data:
            save_json(data, RAW_DIR / "swpc_geomag_scales_raw.json")
            return data
        
        return {}
    
    def fetch_dst_index(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch Dst (Disturbance Storm Time) index.
        
        Dst measures the magnitude of geomagnetic storms.
        Negative values indicate storm activity.
        """
        logger.info("Fetching SWPC Dst index data...")
        
        data = self._fetch_product("dst_index", use_cache=use_cache)
        
        if data:
            if isinstance(data, list) and len(data) > 1:
                headers = data[0] if isinstance(data[0], list) else None
                records = data[1:] if headers else data
                
                if records and isinstance(records[0], list) and headers:
                    records = [dict(zip(headers, row)) for row in records]
                
                save_json(records, RAW_DIR / "swpc_dst_index_raw.json")
                logger.info(f"Fetched {len(records)} Dst index records")
                return records
        
        return []


def fetch_swpc_data(use_cache: bool = True) -> Dict[str, Any]:
    """
    Main function to fetch all SWPC space weather data.
    
    Returns dict with:
    - kp_index: list of Kp index records
    - kp_forecast: list of Kp forecast records
    - solar_flares: list of flare events
    - xray_flux: list of X-ray flux measurements
    - alerts: list of alerts/warnings
    - geomag_scales: current space weather scales
    - dst_index: list of Dst index records
    - stats: fetch statistics
    """
    fetcher = SWPCFetcher()
    
    kp_index = fetcher.fetch_kp_index(use_cache=use_cache)
    kp_forecast = fetcher.fetch_kp_forecast(use_cache=use_cache)
    solar_flares = fetcher.fetch_solar_flares(use_cache=use_cache)
    xray_flux = fetcher.fetch_xray_flux(use_cache=use_cache)
    alerts = fetcher.fetch_alerts_warnings(use_cache=use_cache)
    geomag_scales = fetcher.fetch_geomag_scales(use_cache=use_cache)
    dst_index = fetcher.fetch_dst_index(use_cache=use_cache)
    
    # Calculate date range from Kp data
    date_range = {}
    if kp_index:
        times = []
        for record in kp_index:
            time_tag = record.get("time_tag") if isinstance(record, dict) else None
            if time_tag:
                try:
                    times.append(datetime.fromisoformat(time_tag.replace("Z", "+00:00")))
                except (ValueError, TypeError):
                    pass
        if times:
            date_range = {
                "start": min(times).isoformat(),
                "end": max(times).isoformat()
            }
    
    stats = {
        "kp_index_records": len(kp_index),
        "kp_forecast_records": len(kp_forecast),
        "solar_flare_events": len(solar_flares),
        "xray_flux_records": len(xray_flux),
        "alert_records": len(alerts),
        "dst_index_records": len(dst_index),
        "date_range": date_range
    }
    
    return {
        "kp_index": kp_index,
        "kp_forecast": kp_forecast,
        "solar_flares": solar_flares,
        "xray_flux": xray_flux,
        "alerts": alerts,
        "geomag_scales": geomag_scales,
        "dst_index": dst_index,
        "stats": stats
    }


if __name__ == "__main__":
    # Test fetch
    result = fetch_swpc_data()
    print(f"Kp index records: {result['stats']['kp_index_records']}")
    print(f"Solar flare events: {result['stats']['solar_flare_events']}")
    print(f"Date range: {result['stats']['date_range']}")
