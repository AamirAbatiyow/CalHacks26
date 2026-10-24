"""
Data loading and augmentation for ML training.

Loads SatNOGS observations from the pipeline's processed data and augments
with synthetic observations based on realistic parameter distributions.
"""

import json
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Tuple
import logging

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
RAW_DIR = DATA_DIR / "raw"


def load_raw_observations() -> list:
    """Load raw observations from pipeline output."""
    raw_file = RAW_DIR / "satnogs_observations_raw.json"
    if raw_file.exists():
        with open(raw_file) as f:
            return json.load(f)
    
    sample_file = RAW_DIR / "sample_observations.json"
    if sample_file.exists():
        with open(sample_file) as f:
            return json.load(f)
    
    return []


def load_stations() -> dict:
    """Load station lookup from processed data."""
    stations_file = PROCESSED_DIR / "stations.json"
    if stations_file.exists():
        with open(stations_file) as f:
            stations = json.load(f)
            return {s.get("id"): s for s in stations}
    return {}


def load_space_weather() -> dict:
    """Load space weather data."""
    sw_file = PROCESSED_DIR / "space_weather.json"
    if sw_file.exists():
        with open(sw_file) as f:
            return json.load(f)
    return {"kp_series": [], "flare_events": []}


def load_processed_features() -> Optional[pd.DataFrame]:
    """Load processed features from pipeline if available."""
    parquet_file = PROCESSED_DIR / "passes_features.parquet"
    if parquet_file.exists():
        return pd.read_parquet(parquet_file)
    
    csv_file = PROCESSED_DIR / "passes_features.csv"
    if csv_file.exists():
        return pd.read_csv(csv_file)
    
    return None


def generate_synthetic_observations(n_samples: int = 5000, seed: int = 42) -> pd.DataFrame:
    """
    Generate synthetic observations with realistic parameter distributions.
    
    Based on real SatNOGS statistics:
    - ~70% of observations are 'good', ~20% 'bad', ~10% 'failed'
    - Higher elevations correlate with better outcomes
    - High Kp index (>5) correlates with failures
    - X-class flares correlate with failures
    - Longer passes (>10 min) correlate with better outcomes
    """
    np.random.seed(seed)
    
    # Station parameters (based on real KSAT/AWS ground stations)
    stations = [
        {"id": "svalsat", "lat": 78.23, "lon": 15.39, "alt": 450},
        {"id": "trollsat", "lat": -72.01, "lon": 2.54, "alt": 1270},
        {"id": "inuvik", "lat": 68.32, "lon": -133.53, "alt": 103},
        {"id": "punta-arenas", "lat": -53.15, "lon": -70.91, "alt": 37},
        {"id": "aws-alaska", "lat": 64.86, "lon": -147.84, "alt": 137},
        {"id": "aws-oregon", "lat": 45.82, "lon": -119.29, "alt": 180},
        {"id": "aws-ohio", "lat": 40.10, "lon": -83.16, "alt": 270},
        {"id": "aws-ireland", "lat": 53.42, "lon": -7.90, "alt": 90},
        {"id": "aws-sydney", "lat": -33.92, "lon": 151.18, "alt": 25},
        {"id": "hartebeesthoek", "lat": -25.89, "lon": 27.71, "alt": 1415},
    ]
    
    records = []
    
    for i in range(n_samples):
        station = stations[np.random.randint(len(stations))]
        
        # Generate correlated features
        max_elevation = np.clip(np.random.exponential(30) + 10, 5, 90)
        duration_sec = int(np.clip(np.random.normal(600, 180), 120, 1200))
        
        # Kp index: mostly low, occasionally high storms
        if np.random.random() < 0.1:  # 10% chance of storm
            kp_index = np.clip(np.random.normal(6, 1.5), 4, 9)
        else:
            kp_index = np.clip(np.random.exponential(1.5) + 1, 0, 4)
        
        # Solar flare class: 0=None, 1=C, 2=M, 3=X
        flare_probs = [0.85, 0.10, 0.04, 0.01]
        flare_class = np.random.choice([0, 1, 2, 3], p=flare_probs)
        
        # Weather features
        cloud_cover = np.clip(np.random.beta(2, 5) * 100, 0, 100)
        temp_c = np.random.normal(10 - abs(station["lat"]) * 0.3, 15)
        humidity_pct = np.clip(np.random.normal(60, 20), 10, 100)
        wind_speed = np.clip(np.random.exponential(10), 0, 50)
        precip_mm = np.random.exponential(0.5) if np.random.random() < 0.3 else 0
        
        # Satellite orbital parameters
        sat_inclination = np.random.choice([98, 52, 28, 82, 65])  # Common inclinations
        sat_period_min = np.clip(np.random.normal(95, 10), 85, 120)
        sat_apogee_km = np.clip(np.random.normal(600, 150), 300, 1500)
        sat_perigee_km = sat_apogee_km - np.random.exponential(30)
        
        # Calculate failure probability based on features
        # This is the "ground truth" for synthetic data
        failure_prob = 0.05  # Base rate
        
        # Elevation effect: low elevation = higher failure
        if max_elevation < 20:
            failure_prob += 0.25
        elif max_elevation < 40:
            failure_prob += 0.10
        
        # Kp index effect: high Kp = radio interference
        if kp_index > 7:
            failure_prob += 0.35
        elif kp_index > 5:
            failure_prob += 0.20
        elif kp_index > 4:
            failure_prob += 0.08
        
        # Solar flare effect
        if flare_class == 3:  # X-class
            failure_prob += 0.40
        elif flare_class == 2:  # M-class
            failure_prob += 0.15
        elif flare_class == 1:  # C-class
            failure_prob += 0.05
        
        # Duration effect: short passes = harder to maintain link
        if duration_sec < 300:
            failure_prob += 0.15
        elif duration_sec < 480:
            failure_prob += 0.05
        
        # Weather effect (mainly for optical/high-freq)
        if cloud_cover > 80:
            failure_prob += 0.10
        if precip_mm > 2:
            failure_prob += 0.08
        
        # High latitude stations more susceptible to aurora
        if abs(station["lat"]) > 60 and kp_index > 4:
            failure_prob += 0.12
        
        # Clip probability
        failure_prob = np.clip(failure_prob, 0, 0.95)
        
        # Generate outcome
        is_failure = np.random.random() < failure_prob
        status = "bad" if is_failure else "good"
        outcome_label = 0 if is_failure else 1
        
        # Revenue based on duration (AWS Ground Station pricing ~$3/min)
        revenue_cents = int(duration_sec / 60 * 300)
        
        records.append({
            "pass_id": 10000000 + i,
            "satellite_norad_id": 40000 + np.random.randint(10000),
            "satellite_name": f"SAT-{40000 + np.random.randint(10000)}",
            "station_id": station["id"],
            "station_name": station["id"].replace("-", " ").title(),
            "station_lat": station["lat"],
            "station_lon": station["lon"],
            "start_time": (datetime.now() - timedelta(days=np.random.randint(180))).isoformat() + "Z",
            "duration_sec": duration_sec,
            "max_elevation_deg": round(max_elevation, 1),
            "transmitter_mode": np.random.choice(["FSK", "BPSK", "GMSK", "AFSK", "FM"]),
            "sat_inclination_deg": float(sat_inclination),
            "sat_period_min": round(sat_period_min, 2),
            "sat_apogee_km": round(sat_apogee_km, 1),
            "sat_perigee_km": round(sat_perigee_km, 1),
            "sat_eccentricity": round((sat_apogee_km - sat_perigee_km) / (sat_apogee_km + sat_perigee_km + 12756), 5),
            "kp_at_time": round(kp_index, 1),
            "flare_class": flare_class,
            "cloud_cover_pct": round(cloud_cover, 1),
            "precip_mm": round(precip_mm, 2),
            "visibility_m": np.random.choice([10000, 20000, 30000, 50000]),
            "temp_c": round(temp_c, 1),
            "humidity_pct": round(humidity_pct, 1),
            "wind_speed_kmh": round(wind_speed, 1),
            "status": status,
            "vetted_status": None,
            "has_waterfall": bool(np.random.random() < 0.7),
            "has_audio": bool(np.random.random() < 0.5),
            "outcome_label": outcome_label,
            "revenue_cents": revenue_cents,
            "true_failure_prob": round(failure_prob, 4),  # For validation
        })
    
    df = pd.DataFrame(records)
    logger.info(f"Generated {len(df)} synthetic observations")
    logger.info(f"Class balance: {df['outcome_label'].value_counts().to_dict()}")
    
    return df


def load_training_data(min_samples: int = 2000, use_synthetic: bool = True) -> Tuple[pd.DataFrame, dict]:
    """
    Load training data, augmenting with synthetic data if needed.
    
    Returns:
        Tuple of (DataFrame, stats dict)
    """
    stats = {
        "real_samples": 0,
        "synthetic_samples": 0,
        "total_samples": 0,
        "class_balance": {},
    }
    
    # Try to load processed features first
    df = load_processed_features()
    
    if df is not None and len(df) > 0:
        # Filter to labeled samples only
        df = df[df["outcome_label"].notna()].copy()
        stats["real_samples"] = len(df)
        logger.info(f"Loaded {len(df)} real labeled samples from pipeline")
    else:
        df = pd.DataFrame()
        logger.info("No processed features found")
    
    # Augment with synthetic data if needed
    if use_synthetic and len(df) < min_samples:
        needed = min_samples - len(df)
        synthetic_df = generate_synthetic_observations(n_samples=needed)
        
        # Align columns
        if len(df) > 0:
            common_cols = list(set(df.columns) & set(synthetic_df.columns))
            df = pd.concat([df[common_cols], synthetic_df[common_cols]], ignore_index=True)
        else:
            df = synthetic_df
        
        stats["synthetic_samples"] = needed
        logger.info(f"Added {needed} synthetic samples")
    
    stats["total_samples"] = len(df)
    
    if len(df) > 0:
        stats["class_balance"] = df["outcome_label"].value_counts().to_dict()
    
    return df, stats


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    df, stats = load_training_data(min_samples=3000)
    print(f"\nLoaded training data:")
    print(f"  Real samples: {stats['real_samples']}")
    print(f"  Synthetic samples: {stats['synthetic_samples']}")
    print(f"  Total: {stats['total_samples']}")
    print(f"  Class balance: {stats['class_balance']}")
    print(f"\nColumns: {list(df.columns)}")
