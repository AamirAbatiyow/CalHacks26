"""
Shared utilities for the Ground Truth data pipeline.
"""

import json
import time
import hashlib
import logging
from pathlib import Path
from datetime import datetime
from typing import Any, Optional
from functools import wraps

import requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class RateLimiter:
    """Simple rate limiter using token bucket algorithm."""
    
    def __init__(self, rate: float):
        self.rate = rate  # requests per second
        self.last_request = 0.0
        self.min_interval = 1.0 / rate
    
    def wait(self):
        """Wait if necessary to respect rate limit."""
        now = time.time()
        elapsed = now - self.last_request
        if elapsed < self.min_interval:
            sleep_time = self.min_interval - elapsed
            time.sleep(sleep_time)
        self.last_request = time.time()


class CacheManager:
    """Manages caching of raw API responses."""
    
    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
    
    def _get_cache_key(self, url: str, params: Optional[dict] = None) -> str:
        """Generate a cache key from URL and params."""
        key_str = url
        if params:
            key_str += json.dumps(params, sort_keys=True)
        return hashlib.md5(key_str.encode()).hexdigest()
    
    def get(self, url: str, params: Optional[dict] = None) -> Optional[Any]:
        """Get cached response if available."""
        cache_key = self._get_cache_key(url, params)
        cache_file = self.cache_dir / f"{cache_key}.json"
        if cache_file.exists():
            try:
                with open(cache_file, 'r') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError):
                return None
        return None
    
    def set(self, url: str, data: Any, params: Optional[dict] = None):
        """Cache a response."""
        cache_key = self._get_cache_key(url, params)
        cache_file = self.cache_dir / f"{cache_key}.json"
        with open(cache_file, 'w') as f:
            json.dump(data, f)
    
    def clear(self):
        """Clear all cached data."""
        for f in self.cache_dir.glob("*.json"):
            f.unlink()


@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=2, max=30),
    retry=retry_if_exception_type((requests.exceptions.RequestException, requests.exceptions.Timeout))
)
def fetch_with_retry(url: str, params: Optional[dict] = None, 
                     rate_limiter: Optional[RateLimiter] = None,
                     timeout: int = 30) -> requests.Response:
    """Fetch URL with retry logic and optional rate limiting."""
    if rate_limiter:
        rate_limiter.wait()
    
    response = requests.get(url, params=params, timeout=timeout)
    response.raise_for_status()
    return response


def save_json(data: Any, filepath: Path, indent: int = 2):
    """Save data as JSON."""
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=indent, default=str)
    logger.info(f"Saved {filepath} ({filepath.stat().st_size / 1024:.1f} KB)")


def load_json(filepath: Path) -> Any:
    """Load data from JSON file."""
    with open(filepath, 'r') as f:
        return json.load(f)


def iso_to_datetime(iso_str: str) -> datetime:
    """Parse ISO datetime string."""
    if iso_str is None:
        return None
    iso_str = iso_str.replace('Z', '+00:00')
    try:
        return datetime.fromisoformat(iso_str)
    except ValueError:
        from dateutil import parser
        return parser.parse(iso_str)


def datetime_to_iso(dt: datetime) -> str:
    """Convert datetime to ISO string."""
    if dt is None:
        return None
    return dt.isoformat().replace('+00:00', 'Z')


class PipelineStats:
    """Track pipeline execution statistics."""
    
    def __init__(self):
        self.stats = {}
        self.errors = []
        self.start_time = datetime.utcnow()
    
    def record(self, key: str, value: Any):
        """Record a statistic."""
        self.stats[key] = value
    
    def record_error(self, source: str, error: str):
        """Record an error."""
        self.errors.append({"source": source, "error": str(error), "time": datetime.utcnow().isoformat()})
    
    def get_summary(self) -> dict:
        """Get summary of all stats."""
        return {
            "stats": self.stats,
            "errors": self.errors,
            "duration_seconds": (datetime.utcnow() - self.start_time).total_seconds()
        }
