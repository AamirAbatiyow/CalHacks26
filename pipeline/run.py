"""
Main pipeline runner for Ground Truth data pipeline.

Usage:
    python -m pipeline.run [options]
    
Options:
    --full          Fetch maximum data (200k observations)
    --quick         Quick test run (1000 observations)
    --no-cache      Bypass cached data
    --obs-limit N   Set specific observation limit
    --days N        Days of history to fetch (default: 90)
"""

import argparse
import json
import sys
import logging
from datetime import datetime, date, timedelta
from pathlib import Path

from .config import (
    RAW_DIR, PROCESSED_DIR, DATA_DIR,
    DEFAULT_OBS_LIMIT, MAX_OBS_LIMIT, DEFAULT_DAYS_BACK
)
from .utils import save_json, PipelineStats, logger
from .fetch_satnogs import fetch_satnogs_data
from .fetch_satnogs_db import fetch_satnogs_db_data
from .fetch_celestrak import fetch_celestrak_data
from .fetch_swpc import fetch_swpc_data
from .fetch_weather import fetch_weather_data
from .curated_stations import get_curated_stations
from .process import (
    process_stations, process_satellites, process_passes,
    process_space_weather, process_station_weather,
    create_training_features, save_processed_data
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)


def run_pipeline(
    obs_limit: int = DEFAULT_OBS_LIMIT,
    days_back: int = DEFAULT_DAYS_BACK,
    use_cache: bool = True,
    skip_weather: bool = False
) -> dict:
    """
    Run the complete data pipeline.
    
    Args:
        obs_limit: Maximum observations to fetch
        days_back: Days of historical data
        use_cache: Whether to use cached raw data
        skip_weather: Skip fetching station weather (faster)
    
    Returns:
        Dict with pipeline statistics and results
    """
    stats = PipelineStats()
    
    print("\n" + "="*60)
    print("GROUND TRUTH DATA PIPELINE")
    print("="*60)
    print(f"Observations limit: {obs_limit:,}")
    print(f"Days of history: {days_back}")
    print(f"Use cache: {use_cache}")
    print("="*60 + "\n")
    
    # ========================================
    # STEP 1: Fetch raw data from all sources
    # ========================================
    
    print("\n[1/7] Fetching SatNOGS Network data (observations + stations)...")
    try:
        satnogs_result = fetch_satnogs_data(
            obs_limit=obs_limit,
            days_back=days_back,
            use_cache=use_cache
        )
        stats.record("satnogs_observations", len(satnogs_result["observations"]))
        stats.record("satnogs_stations", len(satnogs_result["stations"]))
        stats.record("unique_satellites", len(satnogs_result["unique_norad_ids"]))
        print(f"   ✓ {len(satnogs_result['observations']):,} observations, {len(satnogs_result['stations']):,} stations")
    except Exception as e:
        logger.error(f"SatNOGS Network fetch failed: {e}")
        stats.record_error("satnogs_network", str(e))
        satnogs_result = {"observations": [], "stations": [], "unique_norad_ids": [], "stats": {}}
    
    print("\n[2/7] Fetching SatNOGS DB data (satellite metadata + transmitters)...")
    try:
        satnogs_db_result = fetch_satnogs_db_data(
            norad_ids=satnogs_result.get("unique_norad_ids"),
            use_cache=use_cache
        )
        stats.record("satnogs_db_satellites", len(satnogs_db_result["satellites"]))
        stats.record("satnogs_db_transmitters", len(satnogs_db_result["transmitters"]))
        print(f"   ✓ {len(satnogs_db_result['satellites']):,} satellites, {len(satnogs_db_result['transmitters']):,} transmitters")
    except Exception as e:
        logger.error(f"SatNOGS DB fetch failed: {e}")
        stats.record_error("satnogs_db", str(e))
        satnogs_db_result = {"satellites": {}, "transmitters": [], "transmitters_by_norad": {}}
    
    print("\n[3/7] Fetching CelesTrak TLE/OMM data...")
    try:
        celestrak_result = fetch_celestrak_data(
            norad_ids=satnogs_result.get("unique_norad_ids"),
            use_cache=use_cache,
            observations=satnogs_result.get("observations")
        )
        stats.record("celestrak_satellites", len(celestrak_result["satellites"]))
        stats.record("celestrak_with_tle", celestrak_result["stats"].get("with_tle_lines", 0))
        tle_source = celestrak_result["stats"].get("source", "unknown")
        print(f"   ✓ {len(celestrak_result['satellites']):,} satellites with TLE data (source: {tle_source})")
    except Exception as e:
        logger.error(f"CelesTrak fetch failed: {e}")
        stats.record_error("celestrak", str(e))
        celestrak_result = {"satellites": {}}
    
    print("\n[4/7] Fetching NOAA SWPC space weather data...")
    try:
        swpc_result = fetch_swpc_data(use_cache=use_cache)
        stats.record("swpc_kp_records", swpc_result["stats"]["kp_index_records"])
        stats.record("swpc_flare_events", swpc_result["stats"]["solar_flare_events"])
        print(f"   ✓ {swpc_result['stats']['kp_index_records']:,} Kp records, {swpc_result['stats']['solar_flare_events']:,} flare events")
    except Exception as e:
        logger.error(f"SWPC fetch failed: {e}")
        stats.record_error("swpc", str(e))
        swpc_result = {"kp_index": [], "solar_flares": [], "alerts": []}
    
    print("\n[5/7] Loading curated ground station data (KSAT, AWS)...")
    try:
        curated_result = get_curated_stations()
        stats.record("curated_ksat_stations", curated_result["stats"]["ksat_stations"])
        stats.record("curated_aws_stations", curated_result["stats"]["aws_stations"])
        print(f"   ✓ {curated_result['stats']['ksat_stations']} KSAT, {curated_result['stats']['aws_stations']} AWS stations")
    except Exception as e:
        logger.error(f"Curated stations load failed: {e}")
        stats.record_error("curated_stations", str(e))
        curated_result = {"all_stations": []}
    
    # Weather fetching (can be slow, optional skip)
    weather_result = {"weather_by_station": {}, "stats": {"stations_with_data": 0}}
    
    if not skip_weather:
        print("\n[6/7] Fetching Open-Meteo weather data for stations...")
        try:
            # Only fetch weather for stations that have observations
            active_station_ids = set(satnogs_result.get("unique_station_ids", []))
            active_stations = [
                s for s in satnogs_result.get("stations", [])
                if s.get("id") in active_station_ids
            ][:100]  # Limit to 100 stations for reasonable API usage
            
            if active_stations:
                end_date = date.today()
                start_date = end_date - timedelta(days=days_back)
                
                weather_result = fetch_weather_data(
                    stations=active_stations,
                    start_date=start_date,
                    end_date=end_date,
                    use_cache=use_cache
                )
                stats.record("weather_stations", weather_result["stats"]["stations_with_data"])
                stats.record("weather_hourly_records", weather_result["stats"]["total_hourly_records"])
                print(f"   ✓ Weather for {weather_result['stats']['stations_with_data']} stations")
            else:
                print("   ⚠ No active stations for weather fetch")
        except Exception as e:
            logger.error(f"Weather fetch failed: {e}")
            stats.record_error("open_meteo", str(e))
    else:
        print("\n[6/7] Skipping weather data fetch (--skip-weather)")
        stats.record("weather_stations", 0)
    
    # ========================================
    # STEP 2: Process and normalize data
    # ========================================
    
    print("\n[7/7] Processing and normalizing data...")
    
    # Process stations
    processed_stations = process_stations(
        satnogs_result.get("stations", []),
        curated_result.get("all_stations", [])
    )
    stats.record("processed_stations", len(processed_stations))
    
    # Build station lookup
    stations_lookup = {}
    for s in processed_stations:
        sid = s.get("id")
        if sid:
            stations_lookup[sid] = s
    
    # Process satellites
    processed_satellites = process_satellites(
        satnogs_db_result.get("satellites", {}),
        celestrak_result.get("satellites", {}),
        satnogs_db_result.get("transmitters_by_norad", {})
    )
    stats.record("processed_satellites", len(processed_satellites))
    
    # Build satellite lookup
    satellites_lookup = {s.get("norad_id"): s for s in processed_satellites}
    
    # Process passes
    processed_passes = process_passes(
        satnogs_result.get("observations", []),
        stations_lookup,
        satellites_lookup
    )
    stats.record("processed_passes", len(processed_passes))
    
    # Process space weather
    processed_space_weather = process_space_weather(swpc_result)
    stats.record("processed_kp_records", len(processed_space_weather.get("kp_series", [])))
    stats.record("processed_flare_events", len(processed_space_weather.get("flare_events", [])))
    
    # Process station weather
    processed_station_weather = process_station_weather(
        weather_result.get("weather_by_station", {}),
        stations_lookup
    )
    stats.record("processed_weather_stations", len(processed_station_weather))
    
    # Create training features
    features_df = create_training_features(
        processed_passes,
        processed_space_weather,
        processed_station_weather,
        satellites_lookup
    )
    stats.record("training_rows", len(features_df))
    stats.record("training_columns", len(features_df.columns))
    
    # Class balance
    if "outcome_label" in features_df.columns:
        label_counts = features_df["outcome_label"].value_counts(dropna=False).to_dict()
        stats.record("class_balance", {str(k): v for k, v in label_counts.items()})
    
    # ========================================
    # STEP 3: Save processed outputs
    # ========================================
    
    print("\nSaving processed outputs...")
    
    outputs = save_processed_data(
        processed_stations,
        processed_satellites,
        processed_passes,
        processed_space_weather,
        processed_station_weather,
        features_df
    )
    
    # Calculate date ranges
    date_ranges = {}
    
    if processed_passes:
        pass_dates = [p.get("start") for p in processed_passes if p.get("start")]
        if pass_dates:
            date_ranges["observations"] = {
                "start": min(pass_dates),
                "end": max(pass_dates)
            }
    
    if processed_space_weather.get("date_range"):
        date_ranges["space_weather"] = processed_space_weather["date_range"]
    
    stats.record("date_ranges", date_ranges)
    
    # Save pipeline stats
    summary = stats.get_summary()
    save_json(summary, DATA_DIR / "pipeline_stats.json")
    
    # ========================================
    # STEP 4: Print summary
    # ========================================
    
    print("\n" + "="*60)
    print("PIPELINE COMPLETE")
    print("="*60)
    print(f"\nDuration: {summary['duration_seconds']:.1f} seconds")
    
    print("\n📊 ROW COUNTS:")
    print(f"   stations.json:          {stats.stats.get('processed_stations', 0):,} rows")
    print(f"   satellites.json:        {stats.stats.get('processed_satellites', 0):,} rows")
    print(f"   passes.json:            {stats.stats.get('processed_passes', 0):,} rows")
    print(f"   space_weather.json:     {stats.stats.get('processed_kp_records', 0):,} Kp records, {stats.stats.get('processed_flare_events', 0)} flares")
    print(f"   station_weather.json:   {stats.stats.get('processed_weather_stations', 0):,} stations")
    print(f"   passes_features.*:      {stats.stats.get('training_rows', 0):,} rows × {stats.stats.get('training_columns', 0)} columns")
    
    print("\n📅 DATE RANGES:")
    for source, dr in date_ranges.items():
        print(f"   {source}: {dr.get('start', 'N/A')} to {dr.get('end', 'N/A')}")
    
    if stats.errors:
        print("\n⚠️  ERRORS/RATE LIMITS:")
        for err in stats.errors:
            print(f"   {err['source']}: {err['error']}")
    
    print("\n📁 OUTPUT FILES:")
    for name, path in outputs.items():
        size = Path(path).stat().st_size / 1024
        print(f"   {name}: {size:.1f} KB")
    
    print("\n" + "="*60)
    
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="Ground Truth Data Pipeline - Fetch and process satellite observation data"
    )
    parser.add_argument(
        "--full", action="store_true",
        help=f"Fetch maximum data ({MAX_OBS_LIMIT:,} observations)"
    )
    parser.add_argument(
        "--quick", action="store_true",
        help="Quick test run (1,000 observations)"
    )
    parser.add_argument(
        "--no-cache", action="store_true",
        help="Bypass cached raw data"
    )
    parser.add_argument(
        "--obs-limit", type=int, default=None,
        help=f"Observation limit (default: {DEFAULT_OBS_LIMIT:,})"
    )
    parser.add_argument(
        "--days", type=int, default=DEFAULT_DAYS_BACK,
        help=f"Days of history to fetch (default: {DEFAULT_DAYS_BACK})"
    )
    parser.add_argument(
        "--skip-weather", action="store_true",
        help="Skip fetching station weather data (faster)"
    )
    
    args = parser.parse_args()
    
    # Determine observation limit
    if args.quick:
        obs_limit = 1000
    elif args.full:
        obs_limit = MAX_OBS_LIMIT
    elif args.obs_limit:
        obs_limit = args.obs_limit
    else:
        obs_limit = DEFAULT_OBS_LIMIT
    
    # Run pipeline
    try:
        summary = run_pipeline(
            obs_limit=obs_limit,
            days_back=args.days,
            use_cache=not args.no_cache,
            skip_weather=args.skip_weather
        )
        
        if summary.get("errors"):
            sys.exit(1)
        sys.exit(0)
        
    except KeyboardInterrupt:
        print("\n\nPipeline interrupted by user")
        sys.exit(130)
    except Exception as e:
        logger.exception(f"Pipeline failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
