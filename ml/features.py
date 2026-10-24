"""
Feature engineering for pass-failure prediction.

Transforms raw pass data into ML-ready features with proper encoding
and scaling for gradient boosting models.
"""

import numpy as np
import pandas as pd
from typing import List, Tuple, Optional
import logging

logger = logging.getLogger(__name__)

# Feature definitions
NUMERIC_FEATURES = [
    "max_elevation_deg",
    "duration_sec",
    "kp_at_time",
    "cloud_cover_pct",
    "precip_mm",
    "temp_c",
    "humidity_pct",
    "wind_speed_kmh",
    "sat_inclination_deg",
    "sat_period_min",
    "sat_apogee_km",
    "sat_perigee_km",
    "station_lat",
    "station_lon",
]

CATEGORICAL_FEATURES = [
    "station_id",
    "flare_class",
    "transmitter_mode",
]

# Feature names for SHAP display
FEATURE_DISPLAY_NAMES = {
    "max_elevation_deg": "Max Elevation (°)",
    "duration_sec": "Duration (s)",
    "kp_at_time": "Kp Index",
    "flare_class": "Solar Flare Class",
    "cloud_cover_pct": "Cloud Cover (%)",
    "precip_mm": "Precipitation (mm)",
    "temp_c": "Temperature (°C)",
    "humidity_pct": "Humidity (%)",
    "wind_speed_kmh": "Wind Speed (km/h)",
    "sat_inclination_deg": "Sat Inclination (°)",
    "sat_period_min": "Sat Period (min)",
    "sat_apogee_km": "Sat Apogee (km)",
    "sat_perigee_km": "Sat Perigee (km)",
    "station_lat": "Station Latitude",
    "station_lon": "Station Longitude",
    "station_id": "Station",
    "transmitter_mode": "Transmitter Mode",
    "is_high_latitude": "High Latitude Station",
    "is_polar_station": "Polar Station",
    "pass_is_short": "Short Pass (<5min)",
    "elevation_bin": "Elevation Category",
}


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Engineer additional features from raw pass data.
    
    Args:
        df: DataFrame with raw pass features
        
    Returns:
        DataFrame with engineered features added
    """
    df = df.copy()
    
    # Derived features
    if "station_lat" in df.columns:
        df["is_high_latitude"] = (df["station_lat"].abs() > 60).astype(int)
        df["is_polar_station"] = (df["station_lat"].abs() > 75).astype(int)
    
    if "duration_sec" in df.columns:
        df["pass_is_short"] = (df["duration_sec"] < 300).astype(int)
    
    if "max_elevation_deg" in df.columns:
        df["elevation_bin"] = pd.cut(
            df["max_elevation_deg"],
            bins=[0, 20, 45, 70, 90],
            labels=[0, 1, 2, 3]
        ).astype(float)
    
    # Kp-latitude interaction (aurora risk)
    if "kp_at_time" in df.columns and "station_lat" in df.columns:
        df["kp_latitude_risk"] = df["kp_at_time"] * (df["station_lat"].abs() / 90)
    
    return df


def prepare_features(
    df: pd.DataFrame,
    feature_list: Optional[List[str]] = None,
) -> Tuple[pd.DataFrame, List[str]]:
    """
    Prepare features for model training/inference.
    
    Args:
        df: DataFrame with all features
        feature_list: Optional explicit list of features to use
        
    Returns:
        Tuple of (X DataFrame, list of feature names)
    """
    df = engineer_features(df)
    
    if feature_list is None:
        # Auto-detect available features
        feature_list = []
        
        for col in NUMERIC_FEATURES:
            if col in df.columns:
                feature_list.append(col)
        
        for col in CATEGORICAL_FEATURES:
            if col in df.columns:
                feature_list.append(col)
        
        # Add engineered features
        for col in ["is_high_latitude", "is_polar_station", "pass_is_short", 
                    "elevation_bin", "kp_latitude_risk"]:
            if col in df.columns:
                feature_list.append(col)
    
    # Select and clean features
    X = df[feature_list].copy()
    
    # Handle categoricals for LightGBM
    for col in CATEGORICAL_FEATURES:
        if col in X.columns:
            X[col] = X[col].astype("category")
    
    # Fill missing values
    for col in X.columns:
        if X[col].dtype.name == "category":
            X[col] = X[col].cat.add_categories(["_missing"]).fillna("_missing")
        else:
            X[col] = X[col].fillna(X[col].median() if X[col].notna().any() else 0)
    
    logger.info(f"Prepared {len(feature_list)} features for {len(X)} samples")
    
    return X, feature_list


def get_target(df: pd.DataFrame, target_col: str = "outcome_label") -> pd.Series:
    """
    Extract target variable.
    
    Note: outcome_label = 1 for good passes, 0 for bad/failed
    We predict failure probability, so we invert: 1 - outcome_label
    """
    if target_col not in df.columns:
        raise ValueError(f"Target column '{target_col}' not found")
    
    y = df[target_col].copy()
    
    # Invert: 1 = failure, 0 = success (we predict failure prob)
    y = 1 - y
    
    return y.astype(int)


def get_feature_display_name(feature: str) -> str:
    """Get human-readable name for a feature."""
    return FEATURE_DISPLAY_NAMES.get(feature, feature.replace("_", " ").title())


if __name__ == "__main__":
    from data_loader import load_training_data
    
    logging.basicConfig(level=logging.INFO)
    
    df, stats = load_training_data(min_samples=1000)
    X, features = prepare_features(df)
    y = get_target(df)
    
    print(f"\nFeatures ({len(features)}):")
    for f in features:
        print(f"  {f}: {X[f].dtype}")
    
    print(f"\nTarget distribution:")
    print(f"  Failures (1): {(y == 1).sum()}")
    print(f"  Successes (0): {(y == 0).sum()}")
