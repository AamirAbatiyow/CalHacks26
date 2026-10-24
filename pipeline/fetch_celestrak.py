"""
Fetch TLE/OMM data from CelesTrak.

CelesTrak provides NORAD two-line element sets (TLEs) and
Orbital Mean-Elements Message (OMM) data in JSON format.

Docs: https://celestrak.org/NORAD/documentation/gp-data-formats.php
"""

import logging
from typing import Optional, List, Dict, Any, Set
from pathlib import Path
from datetime import datetime

from tqdm import tqdm

from .config import CELESTRAK_GP_URL, RAW_DIR, RATE_LIMITS
from .utils import RateLimiter, CacheManager, fetch_with_retry, save_json, logger

logger = logging.getLogger(__name__)

# CelesTrak GP catalog groups for active satellites
CELESTRAK_GROUPS = [
    "active",  # All active satellites (large)
    "stations",  # Space stations (ISS, etc.)
    "weather",  # Weather satellites
    "noaa",  # NOAA satellites
    "goes",  # GOES satellites
    "amateur",  # Amateur radio satellites
    "cubesat",  # CubeSats
    "sarsat",  # Search & Rescue
    "argos",  # ARGOS data collection
]


class CelesTrakFetcher:
    """Fetcher for CelesTrak GP/TLE data."""
    
    def __init__(self, cache_dir: Optional[Path] = None):
        self.base_url = CELESTRAK_GP_URL
        self.rate_limiter = RateLimiter(RATE_LIMITS["celestrak"])
        self.cache_dir = cache_dir or RAW_DIR / "celestrak_cache"
        self.cache = CacheManager(self.cache_dir)
    
    def fetch_gp_by_group(
        self, 
        group: str = "active",
        use_cache: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Fetch GP data for a satellite group.
        
        GP (General Perturbations) data includes:
        - OBJECT_NAME, OBJECT_ID, NORAD_CAT_ID
        - EPOCH (TLE epoch time)
        - MEAN_MOTION, ECCENTRICITY, INCLINATION
        - RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY
        - BSTAR (drag term)
        - TLE_LINE1, TLE_LINE2 (raw TLE strings)
        
        Args:
            group: CelesTrak group name (e.g., "active", "weather")
            use_cache: Whether to use cached data
        
        Returns:
            List of GP/OMM records
        """
        logger.info(f"Fetching CelesTrak GP data for group: {group}")
        
        cache_key = f"gp_group_{group}"
        if use_cache:
            cached = self.cache.get(cache_key)
            if cached:
                logger.info(f"Using cached GP data ({len(cached)} records)")
                return cached
        
        params = {
            "GROUP": group,
            "FORMAT": "json"
        }
        
        try:
            response = fetch_with_retry(
                self.base_url, 
                params=params, 
                rate_limiter=self.rate_limiter,
                timeout=60  # Can be slow for large groups
            )
            data = response.json()
            
            if data:
                self.cache.set(cache_key, data)
                save_json(data, RAW_DIR / f"celestrak_gp_{group}_raw.json")
            
            logger.info(f"Fetched {len(data)} GP records for group {group}")
            return data
            
        except Exception as e:
            logger.error(f"Error fetching GP data for group {group}: {e}")
            return []
    
    def fetch_gp_by_norad_ids(
        self,
        norad_ids: List[int],
        use_cache: bool = True
    ) -> Dict[int, Dict[str, Any]]:
        """
        Fetch GP data for specific NORAD IDs.
        
        CelesTrak allows fetching by CATNR (catalog number).
        
        Args:
            norad_ids: List of NORAD catalog IDs
            use_cache: Whether to use cached data
        
        Returns:
            Dict mapping NORAD ID to GP record
        """
        logger.info(f"Fetching CelesTrak GP data for {len(norad_ids)} satellites...")
        
        # First try to get from active satellites group (most comprehensive)
        active_data = self.fetch_gp_by_group("active", use_cache=use_cache)
        
        # Build lookup by NORAD ID
        norad_lookup = {}
        norad_set = set(norad_ids)
        
        for record in active_data:
            norad_id = record.get("NORAD_CAT_ID")
            if norad_id and norad_id in norad_set:
                norad_lookup[norad_id] = record
        
        logger.info(f"Found {len(norad_lookup)}/{len(norad_ids)} satellites in active group")
        
        # For missing satellites, try individual lookups (rate-limited)
        missing = norad_set - set(norad_lookup.keys())
        if missing and len(missing) <= 100:  # Only do individual lookups for reasonable counts
            logger.info(f"Fetching {len(missing)} missing satellites individually...")
            
            for norad_id in tqdm(list(missing)[:100], desc="Individual TLE lookups"):
                cache_key = f"gp_norad_{norad_id}"
                if use_cache:
                    cached = self.cache.get(cache_key)
                    if cached:
                        if cached:  # Could be empty list if not found
                            norad_lookup[norad_id] = cached[0] if isinstance(cached, list) else cached
                        continue
                
                try:
                    params = {"CATNR": norad_id, "FORMAT": "json"}
                    response = fetch_with_retry(
                        self.base_url,
                        params=params,
                        rate_limiter=self.rate_limiter
                    )
                    data = response.json()
                    
                    self.cache.set(cache_key, data)
                    
                    if data:
                        record = data[0] if isinstance(data, list) else data
                        norad_lookup[norad_id] = record
                        
                except Exception as e:
                    logger.debug(f"Could not fetch GP for NORAD {norad_id}: {e}")
        
        logger.info(f"Total satellites with GP data: {len(norad_lookup)}")
        return norad_lookup
    
    def fetch_all_active(self, use_cache: bool = True) -> List[Dict[str, Any]]:
        """
        Fetch all active satellites.
        
        This is a large dataset (~8000+ satellites).
        """
        return self.fetch_gp_by_group("active", use_cache=use_cache)


def extract_tles_from_observations(observations: List[Dict]) -> Dict[int, Dict[str, Any]]:
    """
    Extract TLE data from SatNOGS observations as a fallback.
    
    Observations include tle0, tle1, tle2 fields with the TLE used for scheduling.
    """
    logger.info("Extracting TLE data from observations...")
    
    satellites = {}
    for obs in observations:
        norad_id = obs.get("norad_cat_id")
        tle0 = obs.get("tle0")  # Satellite name line
        tle1 = obs.get("tle1")  # TLE line 1
        tle2 = obs.get("tle2")  # TLE line 2
        
        if norad_id and tle1 and tle2 and norad_id not in satellites:
            satellites[norad_id] = {
                "NORAD_CAT_ID": norad_id,
                "OBJECT_NAME": tle0.strip() if tle0 else f"NORAD {norad_id}",
                "TLE_LINE0": tle0,
                "TLE_LINE1": tle1,
                "TLE_LINE2": tle2,
                "TLE_SOURCE": obs.get("tle_source"),
                "source": "satnogs_observation"
            }
    
    logger.info(f"Extracted TLEs for {len(satellites)} satellites from observations")
    return satellites


def fetch_celestrak_data(
    norad_ids: Optional[List[int]] = None,
    use_cache: bool = True,
    observations: Optional[List[Dict]] = None
) -> Dict[str, Any]:
    """
    Main function to fetch CelesTrak data.
    
    Args:
        norad_ids: Optional list of specific NORAD IDs to fetch
        use_cache: Whether to use cached data
        observations: Optional observations list to extract TLEs from as fallback
    
    Returns dict with:
    - satellites: dict mapping NORAD ID to GP record (with TLE lines)
    - stats: fetch statistics
    """
    fetcher = CelesTrakFetcher()
    satellites = {}
    
    try:
        if norad_ids:
            satellites = fetcher.fetch_gp_by_norad_ids(norad_ids, use_cache=use_cache)
        else:
            # Fetch all active satellites
            active_data = fetcher.fetch_all_active(use_cache=use_cache)
            for record in active_data:
                norad_id = record.get("NORAD_CAT_ID")
                if norad_id:
                    satellites[norad_id] = record
    except Exception as e:
        logger.warning(f"CelesTrak fetch failed: {e}")
    
    # If CelesTrak failed or returned little data, try to extract from observations
    if len(satellites) == 0 and observations:
        logger.info("CelesTrak unavailable, extracting TLEs from observations...")
        satellites = extract_tles_from_observations(observations)
    elif observations:
        # Supplement with observation TLEs for missing satellites
        obs_tles = extract_tles_from_observations(observations)
        added = 0
        for norad_id, tle_data in obs_tles.items():
            if norad_id not in satellites:
                satellites[norad_id] = tle_data
                added += 1
        if added > 0:
            logger.info(f"Added {added} TLEs from observations")
    
    # Extract TLE epoch date range
    epochs = []
    for sat in satellites.values():
        epoch_str = sat.get("EPOCH")
        if epoch_str:
            try:
                epochs.append(datetime.fromisoformat(epoch_str.replace("Z", "+00:00")))
            except (ValueError, TypeError):
                pass
    
    epoch_range = {}
    if epochs:
        epoch_range = {
            "earliest": min(epochs).isoformat(),
            "latest": max(epochs).isoformat()
        }
    
    stats = {
        "satellites_count": len(satellites),
        "with_tle_lines": sum(1 for s in satellites.values() if s.get("TLE_LINE1")),
        "source": "celestrak" if any(s.get("source") != "satnogs_observation" for s in satellites.values()) else "observations",
        "epoch_range": epoch_range
    }
    
    # Save combined data
    if satellites:
        save_json(list(satellites.values()), RAW_DIR / "celestrak_gp_combined_raw.json")
    
    return {
        "satellites": satellites,
        "stats": stats
    }


if __name__ == "__main__":
    # Test fetch
    result = fetch_celestrak_data()
    print(f"Fetched {result['stats']['satellites_count']} satellites")
    print(f"With TLE lines: {result['stats']['with_tle_lines']}")
