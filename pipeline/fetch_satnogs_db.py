"""
Fetch data from SatNOGS DB API.

API docs: https://db.satnogs.org/api/
Provides satellite metadata and transmitter information.
"""

import logging
from typing import Optional, List, Dict, Any
from pathlib import Path

from tqdm import tqdm

from .config import SATNOGS_DB_API, RAW_DIR, RATE_LIMITS
from .utils import RateLimiter, CacheManager, fetch_with_retry, save_json, logger

logger = logging.getLogger(__name__)


class SatNOGSDBFetcher:
    """Fetcher for SatNOGS DB API data."""
    
    def __init__(self, cache_dir: Optional[Path] = None):
        self.base_url = SATNOGS_DB_API
        self.rate_limiter = RateLimiter(RATE_LIMITS["satnogs_db"])
        self.cache_dir = cache_dir or RAW_DIR / "satnogs_db_cache"
        self.cache = CacheManager(self.cache_dir)
    
    def fetch_satellites(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch satellite catalog from SatNOGS DB.
        
        Returns list of satellite records with:
        - sat_id (SatNOGS UUID), norad_cat_id (NORAD catalog ID)
        - name, names (alternate names)
        - status (alive/dead/re-entered)
        - image URL, description
        - launched, deployed, decayed dates
        """
        logger.info("Fetching SatNOGS DB satellites...")
        
        cache_key = "satellites_all"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Using cached satellite data ({len(cached)} satellites)")
                return cached
        
        url = f"{self.base_url}/satellites/"
        all_satellites = []
        seen_ids = set()
        
        try:
            # SatNOGS DB API returns all satellites in one request
            response = fetch_with_retry(url, rate_limiter=self.rate_limiter, timeout=60)
            data = response.json()
            
            if data:
                for sat in data:
                    sat_id = sat.get("sat_id") or sat.get("norad_cat_id")
                    if sat_id and sat_id not in seen_ids:
                        all_satellites.append(sat)
                        seen_ids.add(sat_id)
                
                logger.info(f"Fetched {len(all_satellites)} unique satellites")
                
        except Exception as e:
            logger.error(f"Error fetching satellites: {e}")
        
        if all_satellites:
            self.cache.set(cache_key, all_satellites)
            save_json(all_satellites, RAW_DIR / "satnogs_db_satellites_raw.json")
        
        logger.info(f"Total satellites fetched: {len(all_satellites)}")
        return all_satellites
    
    def fetch_satellites_by_norad(
        self, 
        norad_ids: List[int], 
        use_cache: bool = True
    ) -> Dict[int, Dict[str, Any]]:
        """
        Fetch specific satellites by NORAD ID.
        
        Args:
            norad_ids: List of NORAD catalog IDs to fetch
            use_cache: Whether to use cached data
        
        Returns:
            Dict mapping NORAD ID to satellite record
        """
        logger.info(f"Fetching satellite data for {len(norad_ids)} NORAD IDs...")
        
        # First try to get all satellites and filter
        all_satellites = self.fetch_satellites(use_cache=use_cache)
        
        # Build lookup by NORAD ID
        norad_lookup = {}
        for sat in all_satellites:
            norad_id = sat.get("norad_cat_id")
            if norad_id and norad_id in norad_ids:
                norad_lookup[norad_id] = sat
        
        logger.info(f"Found {len(norad_lookup)}/{len(norad_ids)} satellites in SatNOGS DB")
        return norad_lookup
    
    def fetch_transmitters(
        self, 
        satellite_uuid: Optional[str] = None,
        use_cache: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Fetch transmitter information.
        
        Transmitters include:
        - uuid, description
        - alive, type, uplink_low, uplink_high
        - downlink_low, downlink_high
        - mode, baud, invert
        - norad_cat_id (associated satellite)
        
        Args:
            satellite_uuid: Optional SatNOGS satellite UUID to filter by
            use_cache: Whether to use cached data
        
        Returns:
            List of transmitter records
        """
        logger.info("Fetching SatNOGS DB transmitters...")
        
        cache_key = f"transmitters_{satellite_uuid or 'all'}"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Using cached transmitter data ({len(cached)} transmitters)")
                return cached
        
        url = f"{self.base_url}/transmitters/"
        all_transmitters = []
        seen_ids = set()
        
        params = {}
        if satellite_uuid:
            params["satellite__sat_id"] = satellite_uuid
        
        try:
            response = fetch_with_retry(url, params=params if params else None, rate_limiter=self.rate_limiter, timeout=60)
            data = response.json()
            
            if data:
                for tx in data:
                    tx_id = tx.get("uuid")
                    if tx_id and tx_id not in seen_ids:
                        all_transmitters.append(tx)
                        seen_ids.add(tx_id)
                
                logger.info(f"Fetched {len(all_transmitters)} unique transmitters")
                
        except Exception as e:
            logger.error(f"Error fetching transmitters: {e}")
        
        if all_transmitters:
            self.cache.set(cache_key, all_transmitters)
            save_json(all_transmitters, RAW_DIR / "satnogs_db_transmitters_raw.json")
        
        logger.info(f"Total transmitters fetched: {len(all_transmitters)}")
        return all_transmitters
    
    def fetch_modes(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch modulation modes catalog.
        
        Returns list of mode records with:
        - id, name (e.g., FM, AFSK, CW)
        """
        logger.info("Fetching SatNOGS DB modes...")
        
        cache_key = "modes_all"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Using cached modes data ({len(cached)} modes)")
                return cached
        
        url = f"{self.base_url}/modes/"
        try:
            response = fetch_with_retry(url, rate_limiter=self.rate_limiter)
            modes = response.json()
            
            if modes:
                self.cache.set(cache_key, modes)
                save_json(modes, RAW_DIR / "satnogs_db_modes_raw.json")
            
            logger.info(f"Total modes fetched: {len(modes)}")
            return modes
            
        except Exception as e:
            logger.error(f"Error fetching modes: {e}")
            return []


def fetch_satnogs_db_data(
    norad_ids: Optional[List[int]] = None,
    use_cache: bool = True
) -> Dict[str, Any]:
    """
    Main function to fetch all SatNOGS DB data.
    
    Args:
        norad_ids: Optional list of NORAD IDs to filter satellites
        use_cache: Whether to use cached data
    
    Returns dict with:
    - satellites: dict mapping NORAD ID to satellite record
    - transmitters: list of transmitter records
    - modes: list of mode records
    - stats: fetch statistics
    """
    fetcher = SatNOGSDBFetcher()
    
    if norad_ids:
        satellites = fetcher.fetch_satellites_by_norad(norad_ids, use_cache=use_cache)
    else:
        all_sats = fetcher.fetch_satellites(use_cache=use_cache)
        satellites = {sat.get("norad_cat_id"): sat for sat in all_sats if sat.get("norad_cat_id")}
    
    transmitters = fetcher.fetch_transmitters(use_cache=use_cache)
    modes = fetcher.fetch_modes(use_cache=use_cache)
    
    # Group transmitters by NORAD ID
    transmitters_by_norad = {}
    for tx in transmitters:
        norad_id = tx.get("norad_cat_id")
        if norad_id:
            if norad_id not in transmitters_by_norad:
                transmitters_by_norad[norad_id] = []
            transmitters_by_norad[norad_id].append(tx)
    
    # Build modes lookup
    modes_lookup = {m.get("id"): m.get("name") for m in modes}
    
    stats = {
        "satellites_count": len(satellites),
        "transmitters_count": len(transmitters),
        "modes_count": len(modes),
        "satellites_with_transmitters": len(transmitters_by_norad)
    }
    
    return {
        "satellites": satellites,
        "transmitters": transmitters,
        "transmitters_by_norad": transmitters_by_norad,
        "modes": modes,
        "modes_lookup": modes_lookup,
        "stats": stats
    }


if __name__ == "__main__":
    # Test fetch
    result = fetch_satnogs_db_data()
    print(f"Fetched {result['stats']['satellites_count']} satellites")
    print(f"Fetched {result['stats']['transmitters_count']} transmitters")
