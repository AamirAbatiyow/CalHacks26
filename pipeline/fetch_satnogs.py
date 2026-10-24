"""
Fetch data from SatNOGS Network API.

API docs: https://network.satnogs.org/api/
Endpoints:
- /api/observations/ - observation records
- /api/stations/ - ground station metadata
"""

import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pathlib import Path

import requests
from tqdm import tqdm

from .config import SATNOGS_NETWORK_API, RAW_DIR, RATE_LIMITS, DEFAULT_OBS_LIMIT
from .utils import (
    RateLimiter, CacheManager, fetch_with_retry, save_json, load_json, logger
)

logger = logging.getLogger(__name__)


class SatNOGSNetworkFetcher:
    """Fetcher for SatNOGS Network API data."""
    
    def __init__(self, cache_dir: Optional[Path] = None):
        self.base_url = SATNOGS_NETWORK_API
        self.rate_limiter = RateLimiter(RATE_LIMITS["satnogs_network"])
        self.cache_dir = cache_dir or RAW_DIR / "satnogs_network_cache"
        self.cache = CacheManager(self.cache_dir)
    
    def fetch_stations(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch all ground stations from SatNOGS Network.
        
        Returns list of station records with:
        - id, name, lat, lng, altitude
        - antenna info, status, min_horizon
        - created, last_seen timestamps
        """
        logger.info("Fetching SatNOGS stations...")
        
        cache_key = "stations_all"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Using cached stations data ({len(cached)} stations)")
                return cached
        
        url = f"{self.base_url}/stations/"
        all_stations = []
        seen_ids = set()
        
        try:
            # SatNOGS API returns all stations in one request (no pagination needed)
            response = fetch_with_retry(url, rate_limiter=self.rate_limiter, timeout=60)
            data = response.json()
            
            if data:
                # Deduplicate by station ID
                for station in data:
                    station_id = station.get("id")
                    if station_id and station_id not in seen_ids:
                        all_stations.append(station)
                        seen_ids.add(station_id)
                
                logger.info(f"Fetched {len(all_stations)} unique stations")
                
        except Exception as e:
            logger.error(f"Error fetching stations: {e}")
        
        if all_stations:
            self.cache.set(cache_key, all_stations)
            save_json(all_stations, RAW_DIR / "satnogs_stations_raw.json")
        
        logger.info(f"Total stations fetched: {len(all_stations)}")
        return all_stations
    
    def fetch_observations(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        limit: int = DEFAULT_OBS_LIMIT,
        use_cache: bool = True,
        satellite_norad_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetch observations from SatNOGS Network.
        
        Observations include:
        - id, satellite NORAD ID, station ID
        - start, end timestamps
        - status (good/bad/failed), vetted_status
        - waterfall, audio file URLs
        - transmitter info
        
        Args:
            start_date: Filter observations after this date
            end_date: Filter observations before this date
            limit: Maximum number of observations to fetch
            use_cache: Whether to use cached data
            satellite_norad_id: Filter by specific satellite
        
        Returns:
            List of observation records
        """
        logger.info(f"Fetching SatNOGS observations (limit: {limit})...")
        
        if end_date is None:
            end_date = datetime.utcnow()
        if start_date is None:
            start_date = end_date - timedelta(days=90)
        
        cache_key = f"observations_{start_date.date()}_{end_date.date()}_{limit}"
        if satellite_norad_id:
            cache_key += f"_sat{satellite_norad_id}"
        
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Using cached observations ({len(cached)} records)")
                return cached
        
        # Build initial URL with date filters
        params = {
            "start": start_date.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": end_date.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "format": "json"
        }
        if satellite_norad_id:
            params["satellite__norad_cat_id"] = satellite_norad_id
        
        all_observations = []
        seen_ids = set()
        
        pbar = tqdm(total=limit, desc="Fetching observations")
        
        # Start with base URL
        import urllib.parse
        url = f"{self.base_url}/observations/?" + urllib.parse.urlencode(params)
        
        retry_delay = 2
        max_retries = 5
        
        while len(all_observations) < limit and url:
            try:
                self.rate_limiter.wait()
                response = requests.get(url, timeout=30)
                
                # Handle rate limiting
                if response.status_code == 429:
                    retry_after = int(response.headers.get("Retry-After", retry_delay))
                    logger.warning(f"Rate limited, waiting {retry_after} seconds...")
                    import time
                    time.sleep(retry_after)
                    retry_delay = min(retry_delay * 2, 120)  # Exponential backoff
                    continue
                
                response.raise_for_status()
                retry_delay = 2  # Reset on success
                
                data = response.json()
                
                if not data:
                    break
                
                new_count = 0
                for obs in data:
                    obs_id = obs.get("id")
                    if obs_id and obs_id not in seen_ids:
                        all_observations.append(obs)
                        seen_ids.add(obs_id)
                        new_count += 1
                
                pbar.update(new_count)
                
                # Get next page from Link header
                link_header = response.headers.get("Link", "")
                url = None
                
                if link_header:
                    # Parse Link header to find "next" relation
                    for part in link_header.split(","):
                        if 'rel="next"' in part:
                            # Extract URL from <...>
                            url_match = part.split(";")[0].strip()
                            if url_match.startswith("<") and url_match.endswith(">"):
                                url = url_match[1:-1]
                                break
                
                if not url or new_count == 0:
                    break
                    
            except Exception as e:
                logger.error(f"Error fetching observations: {e}")
                break
        
        pbar.close()
        
        # Sort by start time (newest first) and trim to limit
        all_observations.sort(key=lambda x: x.get("start", ""), reverse=True)
        all_observations = all_observations[:limit]
        
        if all_observations:
            self.cache.set(cache_key, all_observations)
            save_json(all_observations, RAW_DIR / "satnogs_observations_raw.json")
        
        # Log class balance for ML training
        status_counts = {}
        vetted_counts = {}
        for obs in all_observations:
            status = obs.get("status", "unknown")
            vetted = obs.get("vetted_status", "unknown")
            status_counts[status] = status_counts.get(status, 0) + 1
            vetted_counts[vetted] = vetted_counts.get(vetted, 0) + 1
        
        logger.info(f"Total observations fetched: {len(all_observations)}")
        logger.info(f"Status distribution: {status_counts}")
        logger.info(f"Vetted status distribution: {vetted_counts}")
        
        return all_observations
    
    def get_unique_satellites(self, observations: List[Dict]) -> List[int]:
        """Extract unique NORAD IDs from observations."""
        norad_ids = set()
        for obs in observations:
            norad_id = obs.get("norad_cat_id") or obs.get("satellite", {}).get("norad_cat_id")
            if norad_id:
                norad_ids.add(norad_id)
        return sorted(list(norad_ids))
    
    def get_unique_stations(self, observations: List[Dict]) -> List[int]:
        """Extract unique station IDs from observations."""
        station_ids = set()
        for obs in observations:
            station_id = obs.get("ground_station") or obs.get("station_id")
            if station_id:
                station_ids.add(station_id)
        return sorted(list(station_ids))


def fetch_satnogs_data(
    obs_limit: int = DEFAULT_OBS_LIMIT,
    days_back: int = 90,
    use_cache: bool = True
) -> Dict[str, Any]:
    """
    Main function to fetch all SatNOGS Network data.
    
    Returns dict with:
    - observations: list of observation records
    - stations: list of station records
    - unique_norad_ids: list of NORAD IDs in observations
    - stats: fetch statistics
    """
    fetcher = SatNOGSNetworkFetcher()
    
    end_date = datetime.utcnow()
    start_date = end_date - timedelta(days=days_back)
    
    stations = fetcher.fetch_stations(use_cache=use_cache)
    observations = fetcher.fetch_observations(
        start_date=start_date,
        end_date=end_date,
        limit=obs_limit,
        use_cache=use_cache
    )
    
    unique_norad_ids = fetcher.get_unique_satellites(observations)
    unique_station_ids = fetcher.get_unique_stations(observations)
    
    # Calculate stats
    status_counts = {}
    for obs in observations:
        status = obs.get("status", "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1
    
    stats = {
        "observations_count": len(observations),
        "stations_count": len(stations),
        "unique_satellites": len(unique_norad_ids),
        "unique_stations_in_obs": len(unique_station_ids),
        "date_range": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat()
        },
        "status_distribution": status_counts
    }
    
    return {
        "observations": observations,
        "stations": stations,
        "unique_norad_ids": unique_norad_ids,
        "unique_station_ids": unique_station_ids,
        "stats": stats
    }


if __name__ == "__main__":
    # Test fetch
    result = fetch_satnogs_data(obs_limit=100, days_back=30)
    print(f"Fetched {result['stats']['observations_count']} observations")
    print(f"Fetched {result['stats']['stations_count']} stations")
    print(f"Status distribution: {result['stats']['status_distribution']}")
