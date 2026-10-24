"""
Configuration and paths for the Ground Truth data pipeline.
"""

from pathlib import Path
from datetime import datetime, timedelta

# Base paths
ROOT_DIR = Path(__file__).parent.parent
DATA_DIR = ROOT_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"

# Ensure directories exist
RAW_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

# API endpoints
SATNOGS_NETWORK_API = "https://network.satnogs.org/api"
SATNOGS_DB_API = "https://db.satnogs.org/api"
CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
SWPC_BASE_URL = "https://services.swpc.noaa.gov"
OPEN_METEO_HISTORICAL = "https://archive-api.open-meteo.com/v1/archive"

# Rate limiting (requests per second)
# SatNOGS rate limits: ~60 requests/minute = 1 req/sec with some buffer
RATE_LIMITS = {
    "satnogs_network": 0.8,  # Conservative: 0.8 req/sec (48 req/min)
    "satnogs_db": 0.8,
    "celestrak": 0.5,
    "swpc": 2.0,
    "open_meteo": 3.0,
}

# Default data range - last 90 days for a meaningful sample
DEFAULT_DAYS_BACK = 90
DEFAULT_START_DATE = datetime.utcnow() - timedelta(days=DEFAULT_DAYS_BACK)
DEFAULT_END_DATE = datetime.utcnow()

# Observation limits
DEFAULT_OBS_LIMIT = 50000  # Target ~50k observations
MAX_OBS_LIMIT = 200000  # Max if --full flag used

# Sample sizes for committed data
SAMPLE_SIZE_OBSERVATIONS = 1000
SAMPLE_SIZE_STATIONS = 100
