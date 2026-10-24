"""
Data processing and normalization for Ground Truth pipeline.

Transforms raw API responses into clean, normalized JSON outputs
and creates the joined training dataset.
"""

import logging
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path
from collections import defaultdict

import pandas as pd

from .config import PROCESSED_DIR, RAW_DIR
from .utils import save_json, load_json, iso_to_datetime, datetime_to_iso, logger

logger = logging.getLogger(__name__)


def process_stations(
    satnogs_stations: List[Dict],
    curated_stations: List[Dict]
) -> List[Dict[str, Any]]:
    """
    Process and normalize station data.
    
    Output schema:
    - id: int (SatNOGS) or str (curated)
    - name: str
    - source: "satnogs" | "ksat" | "aws"
    - latitude: float
    - longitude: float
    - altitude_m: float | null
    - status: str | null (for SatNOGS: Online/Testing/Offline)
    - min_horizon: float | null (minimum elevation angle)
    - antennas: list of antenna descriptions
    - bands: list of supported frequency bands
    - created: ISO datetime | null
    - last_seen: ISO datetime | null
    """
    logger.info("Processing station data...")
    
    processed = []
    
    # Process SatNOGS stations
    for station in satnogs_stations:
        # Extract antenna/band info
        antennas = []
        bands = set()
        
        antenna_data = station.get("antenna") or station.get("antennas") or []
        if isinstance(antenna_data, list):
            for ant in antenna_data:
                if isinstance(ant, dict):
                    ant_type = ant.get("antenna_type") or ant.get("type", "Unknown")
                    band = ant.get("band", "").upper() if ant.get("band") else None
                    antennas.append(ant_type)
                    if band:
                        bands.add(band)
        
        processed.append({
            "id": station.get("id"),
            "name": station.get("name", f"Station {station.get('id')}"),
            "source": "satnogs",
            "latitude": station.get("lat"),
            "longitude": station.get("lng"),
            "altitude_m": station.get("altitude"),
            "status": station.get("status"),
            "min_horizon": station.get("min_horizon"),
            "antennas": antennas if antennas else None,
            "bands": sorted(list(bands)) if bands else None,
            "created": station.get("created"),
            "last_seen": station.get("last_seen"),
            "observations_count": station.get("observations_count"),
            "observations_future": station.get("observations_future")
        })
    
    # Process curated stations
    for station in curated_stations:
        processed.append({
            "id": station.get("id"),
            "name": station.get("name"),
            "source": station.get("operator", "").lower(),
            "latitude": station.get("latitude"),
            "longitude": station.get("longitude"),
            "altitude_m": station.get("altitude_m"),
            "status": "commercial",
            "min_horizon": None,
            "antennas": None,
            "bands": station.get("capabilities"),
            "created": None,
            "last_seen": None,
            "location": station.get("location"),
            "source_url": station.get("source_url")
        })
    
    logger.info(f"Processed {len(processed)} stations")
    return processed


def process_satellites(
    satnogs_satellites: Dict[int, Dict],
    celestrak_satellites: Dict[int, Dict],
    transmitters_by_norad: Dict[int, List[Dict]]
) -> List[Dict[str, Any]]:
    """
    Process and normalize satellite data with TLE information.
    
    Output schema:
    - norad_id: int
    - name: str
    - names: list of alternate names
    - status: "alive" | "dead" | "re-entered" | "unknown"
    - tle_line1: str | null
    - tle_line2: str | null
    - tle_epoch: ISO datetime | null
    - inclination_deg: float | null
    - period_min: float | null
    - apogee_km: float | null
    - perigee_km: float | null
    - transmitters: list of transmitter info
    - launched: ISO date | null
    """
    logger.info("Processing satellite data...")
    
    # Get all unique NORAD IDs
    all_norad_ids = set(satnogs_satellites.keys()) | set(celestrak_satellites.keys())
    
    processed = []
    
    for norad_id in sorted(all_norad_ids):
        satnogs = satnogs_satellites.get(norad_id, {})
        celestrak = celestrak_satellites.get(norad_id, {})
        transmitters = transmitters_by_norad.get(norad_id, [])
        
        # Use SatNOGS name if available, fallback to CelesTrak
        name = satnogs.get("name") or celestrak.get("OBJECT_NAME") or f"NORAD {norad_id}"
        
        # Get alternate names
        names = []
        if satnogs.get("names"):
            names = satnogs["names"].split("|") if isinstance(satnogs["names"], str) else satnogs["names"]
        
        # Satellite status
        status = satnogs.get("status", "unknown")
        if status not in ["alive", "dead", "re-entered"]:
            status = "unknown"
        
        # Extract orbital elements from CelesTrak or observation TLEs
        tle_line1 = celestrak.get("TLE_LINE1") or celestrak.get("tle_line1")
        tle_line2 = celestrak.get("TLE_LINE2") or celestrak.get("tle_line2")
        tle_epoch = celestrak.get("EPOCH")
        
        # Calculate orbital parameters
        inclination = celestrak.get("INCLINATION")
        mean_motion = celestrak.get("MEAN_MOTION")
        eccentricity = celestrak.get("ECCENTRICITY")
        
        period_min = None
        if mean_motion and mean_motion > 0:
            period_min = 1440.0 / mean_motion  # minutes per day / revs per day
        
        # Approximate apogee/perigee (simplified)
        apogee_km = None
        perigee_km = None
        if mean_motion and eccentricity is not None:
            earth_radius = 6378.137
            semi_major = (398600.4418 / ((mean_motion * 2 * 3.14159265 / 86400) ** 2)) ** (1/3)
            apogee_km = round(semi_major * (1 + eccentricity) - earth_radius, 1)
            perigee_km = round(semi_major * (1 - eccentricity) - earth_radius, 1)
        
        # Process transmitters
        tx_list = []
        for tx in transmitters:
            tx_info = {
                "uuid": tx.get("uuid"),
                "description": tx.get("description"),
                "downlink_low": tx.get("downlink_low"),
                "downlink_high": tx.get("downlink_high"),
                "mode": tx.get("mode"),
                "alive": tx.get("alive", True),
                "baud": tx.get("baud")
            }
            tx_list.append(tx_info)
        
        processed.append({
            "norad_id": norad_id,
            "name": name,
            "names": names if names else None,
            "status": status,
            "tle_line1": tle_line1,
            "tle_line2": tle_line2,
            "tle_epoch": tle_epoch,
            "inclination_deg": inclination,
            "period_min": round(period_min, 2) if period_min else None,
            "apogee_km": apogee_km,
            "perigee_km": perigee_km,
            "eccentricity": eccentricity,
            "transmitters": tx_list if tx_list else None,
            "launched": satnogs.get("launched"),
            "decayed": satnogs.get("decayed"),
            "image_url": satnogs.get("image")
        })
    
    logger.info(f"Processed {len(processed)} satellites")
    return processed


def process_passes(
    observations: List[Dict],
    stations_lookup: Dict[int, Dict],
    satellites_lookup: Dict[int, Dict]
) -> List[Dict[str, Any]]:
    """
    Process observations into normalized passes.
    
    Output schema:
    - id: int (observation ID)
    - satellite_norad_id: int
    - satellite_name: str
    - station_id: int
    - station_name: str
    - start: ISO datetime
    - end: ISO datetime
    - duration_sec: int
    - max_elevation_deg: float | null
    - status: "good" | "bad" | "failed" | "unknown"
    - vetted_status: "verified" | "unknown" | "failed" | null
    - has_waterfall: bool
    - has_audio: bool
    - transmitter_uuid: str | null
    - transmitter_mode: str | null
    """
    logger.info("Processing observation passes...")
    
    processed = []
    status_counts = defaultdict(int)
    vetted_counts = defaultdict(int)
    
    for obs in observations:
        obs_id = obs.get("id")
        
        # Get satellite info
        norad_id = obs.get("norad_cat_id")
        sat_info = satellites_lookup.get(norad_id, {})
        sat_name = sat_info.get("name") or obs.get("satellite", {}).get("name") or f"NORAD {norad_id}"
        
        # Get station info
        station_id = obs.get("ground_station")
        station_info = stations_lookup.get(station_id, {})
        station_name = station_info.get("name") or f"Station {station_id}"
        
        # Parse times
        start_str = obs.get("start")
        end_str = obs.get("end")
        
        start_dt = iso_to_datetime(start_str) if start_str else None
        end_dt = iso_to_datetime(end_str) if end_str else None
        
        duration_sec = None
        if start_dt and end_dt:
            duration_sec = int((end_dt - start_dt).total_seconds())
        
        # Status mapping
        status_raw = obs.get("status", "").lower()
        status = "unknown"
        if "good" in status_raw:
            status = "good"
        elif "bad" in status_raw:
            status = "bad"
        elif "fail" in status_raw:
            status = "failed"
        
        # Vetted status
        vetted_raw = obs.get("vetted_status", "").lower() if obs.get("vetted_status") else ""
        vetted_status = None
        if "verified" in vetted_raw or vetted_raw == "good":
            vetted_status = "verified"
        elif "failed" in vetted_raw or vetted_raw == "bad":
            vetted_status = "failed"
        elif vetted_raw:
            vetted_status = "unknown"
        
        status_counts[status] += 1
        vetted_counts[vetted_status or "null"] += 1
        
        # Media availability
        has_waterfall = bool(obs.get("waterfall") or obs.get("waterfall_url"))
        has_audio = bool(obs.get("payload") or obs.get("audio_url"))
        
        # Transmitter info
        transmitter = obs.get("transmitter") or obs.get("transmitter_uuid")
        transmitter_mode = obs.get("transmitter_mode") or obs.get("mode")
        
        processed.append({
            "id": obs_id,
            "satellite_norad_id": norad_id,
            "satellite_name": sat_name,
            "station_id": station_id,
            "station_name": station_name,
            "station_lat": station_info.get("latitude") or station_info.get("lat"),
            "station_lon": station_info.get("longitude") or station_info.get("lng"),
            "start": start_str,
            "end": end_str,
            "duration_sec": duration_sec,
            "max_elevation_deg": obs.get("max_altitude"),
            "status": status,
            "vetted_status": vetted_status,
            "has_waterfall": has_waterfall,
            "has_audio": has_audio,
            "transmitter_uuid": transmitter,
            "transmitter_mode": transmitter_mode,
            "rise_azimuth": obs.get("rise_azimuth"),
            "set_azimuth": obs.get("set_azimuth")
        })
    
    logger.info(f"Processed {len(processed)} passes")
    logger.info(f"Status distribution: {dict(status_counts)}")
    logger.info(f"Vetted distribution: {dict(vetted_counts)}")
    
    return processed


def process_space_weather(swpc_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process space weather data into normalized format.
    
    Output schema:
    - kp_series: list of {time, kp, a_index}
    - flare_events: list of {time, class, location, peak_flux}
    - radio_blackouts: list of {time, scale, region}
    - date_range: {start, end}
    """
    logger.info("Processing space weather data...")
    
    # Process Kp index
    kp_series = []
    kp_data = swpc_data.get("kp_index", [])
    
    for record in kp_data:
        if isinstance(record, dict):
            time_tag = record.get("time_tag")
            kp_value = record.get("kp") or record.get("Kp")
            
            # Handle different Kp formats
            if kp_value is not None:
                try:
                    if isinstance(kp_value, str):
                        # Handle Kp like "4+" or "3-"
                        kp_clean = kp_value.replace("+", ".33").replace("-", ".67").replace("o", "")
                        kp_value = float(kp_clean) if kp_clean else None
                    else:
                        kp_value = float(kp_value)
                except (ValueError, TypeError):
                    kp_value = None
            
            if time_tag:
                kp_series.append({
                    "time": time_tag,
                    "kp": kp_value,
                    "a_index": record.get("a_running") or record.get("Ap")
                })
    
    # Process solar flares
    flare_events = []
    flare_data = swpc_data.get("solar_flares", [])
    
    for record in flare_data:
        if isinstance(record, dict):
            begin_time = record.get("begin_time") or record.get("beginTime")
            peak_time = record.get("max_time") or record.get("peakTime")
            flare_class = record.get("class_type") or record.get("classType") or record.get("currentClass")
            
            if begin_time or peak_time:
                flare_events.append({
                    "begin_time": begin_time,
                    "peak_time": peak_time,
                    "end_time": record.get("end_time") or record.get("endTime"),
                    "class": flare_class,
                    "location": record.get("location") or record.get("sourceLocation"),
                    "region": record.get("region") or record.get("activeRegionNum")
                })
    
    # Process alerts for radio blackouts
    radio_blackouts = []
    alerts = swpc_data.get("alerts", [])
    
    for alert in alerts:
        if isinstance(alert, dict):
            message = alert.get("message", "").lower()
            if "radio" in message or "blackout" in message or alert.get("SWPC_Scale", "").startswith("R"):
                radio_blackouts.append({
                    "time": alert.get("issue_datetime") or alert.get("IssueTime"),
                    "scale": alert.get("SWPC_Scale"),
                    "message": alert.get("message"),
                    "serial_number": alert.get("serial_number")
                })
    
    # Calculate date range
    all_times = []
    for kp in kp_series:
        if kp.get("time"):
            try:
                all_times.append(iso_to_datetime(kp["time"]))
            except:
                pass
    
    date_range = {}
    if all_times:
        date_range = {
            "start": datetime_to_iso(min(all_times)),
            "end": datetime_to_iso(max(all_times))
        }
    
    result = {
        "kp_series": kp_series,
        "flare_events": flare_events,
        "radio_blackouts": radio_blackouts,
        "dst_series": swpc_data.get("dst_index", []),
        "date_range": date_range,
        "stats": {
            "kp_records": len(kp_series),
            "flare_events": len(flare_events),
            "blackout_alerts": len(radio_blackouts)
        }
    }
    
    logger.info(f"Processed space weather: {result['stats']}")
    return result


def process_station_weather(
    weather_by_station: Dict[int, Dict],
    stations_lookup: Dict[int, Dict]
) -> List[Dict[str, Any]]:
    """
    Process station weather data.
    
    Output schema per station:
    - station_id: int
    - station_name: str
    - latitude: float
    - longitude: float
    - hourly: list of {time, temp_c, precip_mm, cloud_cover_pct, visibility_m}
    """
    logger.info("Processing station weather data...")
    
    processed = []
    
    for station_id, weather in weather_by_station.items():
        station_info = stations_lookup.get(station_id, {})
        
        hourly_data = []
        if weather and "hourly" in weather:
            hourly = weather["hourly"]
            times = hourly.get("time", [])
            
            for i, time_str in enumerate(times):
                hourly_data.append({
                    "time": time_str,
                    "temp_c": hourly.get("temperature_2m", [None])[i] if i < len(hourly.get("temperature_2m", [])) else None,
                    "precip_mm": hourly.get("precipitation", [None])[i] if i < len(hourly.get("precipitation", [])) else None,
                    "cloud_cover_pct": hourly.get("cloud_cover", [None])[i] if i < len(hourly.get("cloud_cover", [])) else None,
                    "cloud_cover_low_pct": hourly.get("cloud_cover_low", [None])[i] if i < len(hourly.get("cloud_cover_low", [])) else None,
                    "visibility_m": hourly.get("visibility", [None])[i] if i < len(hourly.get("visibility", [])) else None,
                    "humidity_pct": hourly.get("relative_humidity_2m", [None])[i] if i < len(hourly.get("relative_humidity_2m", [])) else None,
                    "wind_speed_kmh": hourly.get("wind_speed_10m", [None])[i] if i < len(hourly.get("wind_speed_10m", [])) else None
                })
        
        processed.append({
            "station_id": station_id,
            "station_name": station_info.get("name"),
            "latitude": weather.get("latitude") or station_info.get("latitude"),
            "longitude": weather.get("longitude") or station_info.get("longitude"),
            "hourly_records": len(hourly_data),
            "hourly": hourly_data
        })
    
    logger.info(f"Processed weather for {len(processed)} stations")
    return processed


def create_training_features(
    passes: List[Dict],
    space_weather: Dict[str, Any],
    station_weather: List[Dict],
    satellites_lookup: Dict[int, Dict]
) -> pd.DataFrame:
    """
    Create joined training feature table.
    
    Features:
    - pass_id, satellite_norad_id, station_id
    - start_time, duration_sec, max_elevation_deg
    - satellite: inclination, period, apogee, perigee
    - station: latitude, longitude, altitude
    - space_weather: kp_at_time, kp_3h_avg
    - weather: cloud_cover, precip, visibility
    - outcome: status label (good/bad/failed)
    """
    logger.info("Creating training feature table...")
    
    # Build Kp lookup by hour
    kp_by_hour = {}
    for kp in space_weather.get("kp_series", []):
        time_str = kp.get("time")
        if time_str:
            try:
                dt = iso_to_datetime(time_str)
                hour_key = dt.strftime("%Y-%m-%d-%H")
                kp_by_hour[hour_key] = kp.get("kp")
            except:
                pass
    
    # Build station weather lookup
    weather_lookup = {}
    for sw in station_weather:
        station_id = sw.get("station_id")
        if station_id:
            weather_lookup[station_id] = {}
            for record in sw.get("hourly", []):
                time_str = record.get("time")
                if time_str:
                    weather_lookup[station_id][time_str] = record
    
    features = []
    
    for pass_data in passes:
        pass_id = pass_data.get("id")
        norad_id = pass_data.get("satellite_norad_id")
        station_id = pass_data.get("station_id")
        
        # Get satellite orbital data
        sat = satellites_lookup.get(norad_id, {})
        
        # Get pass timing
        start_str = pass_data.get("start")
        start_dt = None
        if start_str:
            try:
                start_dt = iso_to_datetime(start_str)
            except:
                pass
        
        # Get Kp at observation time
        kp_at_time = None
        if start_dt:
            hour_key = start_dt.strftime("%Y-%m-%d-%H")
            kp_at_time = kp_by_hour.get(hour_key)
            
            # Try nearby hours if not found
            if kp_at_time is None:
                for delta in [-1, 1, -2, 2, -3, 3]:
                    alt_dt = start_dt + timedelta(hours=delta)
                    alt_key = alt_dt.strftime("%Y-%m-%d-%H")
                    kp_at_time = kp_by_hour.get(alt_key)
                    if kp_at_time is not None:
                        break
        
        # Get weather at observation time
        weather_at_time = {}
        if station_id and station_id in weather_lookup and start_dt:
            hour_str = start_dt.strftime("%Y-%m-%dT%H:00")
            weather_at_time = weather_lookup[station_id].get(hour_str, {})
        
        # Map status to numeric label
        status = pass_data.get("status", "unknown")
        label = None
        if status == "good":
            label = 1
        elif status in ["bad", "failed"]:
            label = 0
        
        features.append({
            "pass_id": pass_id,
            "satellite_norad_id": norad_id,
            "satellite_name": pass_data.get("satellite_name"),
            "station_id": station_id,
            "station_name": pass_data.get("station_name"),
            "station_lat": pass_data.get("station_lat"),
            "station_lon": pass_data.get("station_lon"),
            "start_time": start_str,
            "duration_sec": pass_data.get("duration_sec"),
            "max_elevation_deg": pass_data.get("max_elevation_deg"),
            "transmitter_mode": pass_data.get("transmitter_mode"),
            "sat_inclination_deg": sat.get("inclination_deg"),
            "sat_period_min": sat.get("period_min"),
            "sat_apogee_km": sat.get("apogee_km"),
            "sat_perigee_km": sat.get("perigee_km"),
            "sat_eccentricity": sat.get("eccentricity"),
            "kp_at_time": kp_at_time,
            "cloud_cover_pct": weather_at_time.get("cloud_cover_pct"),
            "precip_mm": weather_at_time.get("precip_mm"),
            "visibility_m": weather_at_time.get("visibility_m"),
            "temp_c": weather_at_time.get("temp_c"),
            "humidity_pct": weather_at_time.get("humidity_pct"),
            "wind_speed_kmh": weather_at_time.get("wind_speed_kmh"),
            "status": status,
            "vetted_status": pass_data.get("vetted_status"),
            "has_waterfall": pass_data.get("has_waterfall"),
            "has_audio": pass_data.get("has_audio"),
            "outcome_label": label
        })
    
    df = pd.DataFrame(features)
    
    # Log class balance
    if "outcome_label" in df.columns:
        label_counts = df["outcome_label"].value_counts(dropna=False)
        logger.info(f"Outcome label distribution:\n{label_counts}")
    
    logger.info(f"Created training table with {len(df)} rows, {len(df.columns)} columns")
    return df


def save_processed_data(
    stations: List[Dict],
    satellites: List[Dict],
    passes: List[Dict],
    space_weather: Dict,
    station_weather: List[Dict],
    features_df: pd.DataFrame
) -> Dict[str, str]:
    """Save all processed data to files."""
    
    logger.info("Saving processed data...")
    
    outputs = {}
    
    # Save JSON files
    save_json(stations, PROCESSED_DIR / "stations.json")
    outputs["stations.json"] = str(PROCESSED_DIR / "stations.json")
    
    save_json(satellites, PROCESSED_DIR / "satellites.json")
    outputs["satellites.json"] = str(PROCESSED_DIR / "satellites.json")
    
    save_json(passes, PROCESSED_DIR / "passes.json")
    outputs["passes.json"] = str(PROCESSED_DIR / "passes.json")
    
    save_json(space_weather, PROCESSED_DIR / "space_weather.json")
    outputs["space_weather.json"] = str(PROCESSED_DIR / "space_weather.json")
    
    save_json(station_weather, PROCESSED_DIR / "station_weather.json")
    outputs["station_weather.json"] = str(PROCESSED_DIR / "station_weather.json")
    
    # Save training features
    features_df.to_parquet(PROCESSED_DIR / "passes_features.parquet", index=False)
    outputs["passes_features.parquet"] = str(PROCESSED_DIR / "passes_features.parquet")
    
    features_df.to_csv(PROCESSED_DIR / "passes_features.csv", index=False)
    outputs["passes_features.csv"] = str(PROCESSED_DIR / "passes_features.csv")
    
    logger.info(f"Saved {len(outputs)} output files")
    return outputs
