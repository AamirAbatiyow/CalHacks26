# Ground Truth Data Pipeline

This directory contains data for the Ground Truth satellite pass prediction system.

## Directory Structure

```
data/
├── raw/                    # Cached raw API responses (gitignored, except samples)
│   ├── satnogs_observations_raw.json
│   ├── satnogs_stations_raw.json
│   ├── satnogs_db_satellites_raw.json
│   ├── satnogs_db_transmitters_raw.json
│   ├── celestrak_gp_*.json
│   ├── swpc_*.json
│   ├── open_meteo_weather_raw.json
│   └── curated_stations_raw.json
├── processed/              # Normalized output files
│   ├── stations.json
│   ├── satellites.json
│   ├── passes.json
│   ├── space_weather.json
│   ├── station_weather.json
│   ├── passes_features.parquet
│   └── passes_features.csv
├── pipeline_stats.json     # Pipeline execution statistics
└── README.md              # This file
```

## Data Sources

| Source | Description | API/URL |
|--------|-------------|---------|
| SatNOGS Network | Ground station observations | https://network.satnogs.org/api/ |
| SatNOGS DB | Satellite metadata, transmitters | https://db.satnogs.org/api/ |
| CelesTrak | TLE/OMM orbital elements | https://celestrak.org/NORAD/elements/gp.php |
| NOAA SWPC | Space weather (Kp, flares) | https://services.swpc.noaa.gov/ |
| Open-Meteo | Historical weather | https://archive-api.open-meteo.com/v1/archive |
| KSAT/AWS | Curated commercial stations | Hand-curated from public sources |

## Output Schemas

### stations.json

Ground station metadata from SatNOGS and curated commercial sources.

```json
{
  "id": 123,                          // int (SatNOGS) or str (curated)
  "name": "Station Name",             // string
  "source": "satnogs",                // "satnogs" | "ksat" | "aws"
  "latitude": 51.5074,                // float, degrees
  "longitude": -0.1278,               // float, degrees
  "altitude_m": 50,                   // float | null, meters above sea level
  "status": "Online",                 // string | null ("Online"/"Testing"/"Offline" for SatNOGS)
  "min_horizon": 10,                  // float | null, minimum elevation angle in degrees
  "antennas": ["Yagi", "Turnstile"],  // list | null, antenna types
  "bands": ["UHF", "VHF"],            // list | null, supported frequency bands
  "created": "2020-01-01T00:00:00Z",  // ISO datetime | null
  "last_seen": "2024-01-01T12:00:00Z" // ISO datetime | null
}
```

### satellites.json

Satellite metadata with TLE orbital elements.

```json
{
  "norad_id": 25544,                  // int, NORAD catalog ID
  "name": "ISS (ZARYA)",              // string
  "names": ["ISS", "ZARYA"],          // list | null, alternate names
  "status": "alive",                  // "alive" | "dead" | "re-entered" | "unknown"
  "tle_line1": "1 25544U ...",        // string | null, TLE line 1
  "tle_line2": "2 25544 ...",         // string | null, TLE line 2
  "tle_epoch": "2024-01-01T12:00:00Z", // ISO datetime | null
  "inclination_deg": 51.64,           // float | null, orbital inclination
  "period_min": 92.68,                // float | null, orbital period in minutes
  "apogee_km": 420.5,                 // float | null, apogee altitude
  "perigee_km": 418.2,                // float | null, perigee altitude
  "eccentricity": 0.0001,             // float | null, orbital eccentricity
  "transmitters": [                   // list | null
    {
      "uuid": "abc123",
      "description": "VHF Beacon",
      "downlink_low": 145800000,      // Hz
      "downlink_high": 145800000,     // Hz
      "mode": "FM",
      "alive": true,
      "baud": 1200
    }
  ],
  "launched": "1998-11-20",           // ISO date | null
  "decayed": null,                    // ISO date | null
  "image_url": "https://..."          // string | null
}
```

### passes.json

Normalized observation passes from SatNOGS Network.

```json
{
  "id": 12345678,                     // int, observation ID
  "satellite_norad_id": 25544,        // int
  "satellite_name": "ISS (ZARYA)",    // string
  "station_id": 123,                  // int
  "station_name": "Station Name",     // string
  "station_lat": 51.5074,             // float
  "station_lon": -0.1278,             // float
  "start": "2024-01-01T12:00:00Z",    // ISO datetime
  "end": "2024-01-01T12:10:00Z",      // ISO datetime
  "duration_sec": 600,                // int
  "max_elevation_deg": 45.5,          // float | null
  "status": "good",                   // "good" | "bad" | "failed" | "unknown"
  "vetted_status": "verified",        // "verified" | "unknown" | "failed" | null
  "has_waterfall": true,              // bool
  "has_audio": false,                 // bool
  "transmitter_uuid": "abc123",       // string | null
  "transmitter_mode": "FM",           // string | null
  "rise_azimuth": 45,                 // float | null, degrees
  "set_azimuth": 315                  // float | null, degrees
}
```

### space_weather.json

Space weather data from NOAA SWPC.

```json
{
  "kp_series": [                      // Planetary Kp index time series
    {
      "time": "2024-01-01T00:00:00Z", // ISO datetime
      "kp": 3.0,                      // float, 0-9 scale
      "a_index": 15                   // float | null, A index
    }
  ],
  "flare_events": [                   // Solar flare events
    {
      "begin_time": "2024-01-01T10:00:00Z",
      "peak_time": "2024-01-01T10:15:00Z",
      "end_time": "2024-01-01T10:30:00Z",
      "class": "M1.5",                // Flare class (A/B/C/M/X)
      "location": "N15W30",           // Solar coordinates
      "region": 3536                  // Active region number
    }
  ],
  "radio_blackouts": [                // Radio blackout alerts
    {
      "time": "2024-01-01T10:20:00Z",
      "scale": "R1",                  // NOAA R scale (R1-R5)
      "message": "..."
    }
  ],
  "dst_series": [...],                // Dst index time series
  "date_range": {
    "start": "2024-01-01T00:00:00Z",
    "end": "2024-04-01T00:00:00Z"
  }
}
```

### station_weather.json

Historical weather data at ground station locations.

```json
[
  {
    "station_id": 123,                // int
    "station_name": "Station Name",   // string
    "latitude": 51.5074,              // float
    "longitude": -0.1278,             // float
    "hourly_records": 2160,           // int, count of hourly records
    "hourly": [
      {
        "time": "2024-01-01T00:00",   // ISO datetime (hourly)
        "temp_c": 10.5,               // float | null, temperature
        "precip_mm": 0.0,             // float | null, precipitation
        "cloud_cover_pct": 75,        // float | null, total cloud cover
        "cloud_cover_low_pct": 50,    // float | null, low cloud cover
        "visibility_m": 10000,        // float | null, visibility
        "humidity_pct": 80,           // float | null, relative humidity
        "wind_speed_kmh": 15          // float | null, wind speed
      }
    ]
  }
]
```

### passes_features.parquet / passes_features.csv

Joined training feature table for ML model development.

| Column | Type | Description |
|--------|------|-------------|
| pass_id | int | Observation ID |
| satellite_norad_id | int | NORAD catalog ID |
| satellite_name | str | Satellite name |
| station_id | int | Ground station ID |
| station_name | str | Station name |
| station_lat | float | Station latitude |
| station_lon | float | Station longitude |
| start_time | datetime | Pass start time |
| duration_sec | int | Pass duration |
| max_elevation_deg | float | Maximum elevation angle |
| transmitter_mode | str | Transmission mode |
| sat_inclination_deg | float | Orbital inclination |
| sat_period_min | float | Orbital period |
| sat_apogee_km | float | Apogee altitude |
| sat_perigee_km | float | Perigee altitude |
| sat_eccentricity | float | Orbital eccentricity |
| kp_at_time | float | Kp index at observation time |
| cloud_cover_pct | float | Cloud cover at station |
| precip_mm | float | Precipitation at station |
| visibility_m | float | Visibility at station |
| temp_c | float | Temperature at station |
| humidity_pct | float | Humidity at station |
| wind_speed_kmh | float | Wind speed at station |
| status | str | Observation status |
| vetted_status | str | Vetted status |
| has_waterfall | bool | Waterfall image available |
| has_audio | bool | Audio recording available |
| **outcome_label** | int | **Target variable: 1=good, 0=bad/failed, null=unknown** |

## Class Balance Notes

The `outcome_label` column is the target for pass success prediction:
- `1` = "good" status (successful reception)
- `0` = "bad" or "failed" status (unsuccessful)
- `null` = unknown/pending status

For ML training, filter to rows where `outcome_label` is not null. The class balance varies by time period but typically shows:
- 60-70% good passes
- 30-40% bad/failed passes

The `vetted_status` field provides additional quality signals where human verification has occurred.

## Usage

Run the pipeline:

```bash
# Default: ~50,000 observations, 90 days history
python -m pipeline.run

# Quick test: 1,000 observations
python -m pipeline.run --quick

# Full dataset: 200,000 observations
python -m pipeline.run --full

# Custom options
python -m pipeline.run --obs-limit 10000 --days 30 --no-cache
```

## Data Freshness

Raw data is cached to avoid hitting rate limits. Use `--no-cache` to force fresh fetches.

Recommended refresh schedule:
- Observations: Daily or weekly
- TLEs: Weekly (orbital elements decay)
- Space weather: Real-time or daily
- Station weather: As needed for new observation periods

## Rate Limits

The SatNOGS Network API has rate limits (~60 requests/minute). For large fetches (>5000 observations):
- Use caching to avoid repeated requests
- Run during off-peak hours if possible
- The pipeline handles 429 errors with exponential backoff
- A full 50k observation fetch may take 30-60 minutes

CelesTrak may also be slow or unresponsive at times. The pipeline extracts TLE data from SatNOGS observations as a fallback.

## Sample Data

Small sample files are committed to `data/raw/sample_*.json` for testing and development:
- `sample_observations.json`: 100 observation records
- `sample_stations.json`: 100 station records

These allow the pipeline to be tested without making API calls.
