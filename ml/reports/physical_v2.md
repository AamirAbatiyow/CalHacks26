# Pass-failure model v2: physical features, held-out evaluation

Generated 2026-10-24T12:32:01.799173+00:00 by `python -m ml.evaluate_physical --save-model`.

## Dataset

- Raw SatNOGS observations fetched: 2572 in 9 random one-hour windows (2025-12-28 to 2026-09-05); vetted share 55.7%.
- Labeled passes used: **1413** ({'good': 777, 'bad': 417, 'failed': 219}), natural failure rate 45.0%; 283 stations, 368 satellites, largest station share 4.7%.

## Held-out results

Policy thresholds are chosen on validation data inside each training fold, then applied to the test fold. Recall is per side: the share of real failures auto-flagged at `P(fail) >= t_fail`, and the share of real successes auto-cleared at `P(fail) <= t_ok`. Escalated passes fall between the two thresholds. Brackets show 95% cluster-bootstrap CIs, resampled over sampling windows.

### physical+history

| metric | GroupKFold by station | forward time split |
|---|---|---|
| test passes | 1413 | 284 |
| AUC-ROC | 0.787 [0.7525, 0.8129] | 0.804 [0.7237, 0.8237] |
| accuracy @0.5 (majority baseline) | 71.8% [0.6868, 0.7432] (55.0%) | 73.9% [0.6499, 0.7848] (57.0%) |
| failure precision @0.5 | 69.3% | 70.0% |
| P>=0.95 fail side: precision / recall | 94.6% / 11.0% | 100.0% / 1.6% |
| P>=0.95 ok side: precision / recall | 90.6% / 12.4% | 87.5% / 34.6% |
| P>=0.95 escalated to human | 87.3% | 76.8% |
| P>=0.95 oracle (thresholds fit on test): fail rec / ok rec / escalated | 11.3% / 1.4% / 93.9% | 20.5% / 12.3% / 83.5% |
| P>=0.98 fail side: precision / recall | 92.5% / 5.8% | 100.0% / 1.6% |
| P>=0.98 ok side: precision / recall | 100.0% / 4.4% | 85.7% / 29.6% |
| P>=0.98 escalated to human | 94.8% | 79.6% |
| P>=0.98 oracle (thresholds fit on test): fail rec / ok rec / escalated | 8.3% / 1.4% / 95.4% | 15.6% / 8.6% / 88.4% |
| ~17% escalation band: actual escalated / accuracy on auto-decided | 15.1% / 75.8% | 21.1% / 78.6% |

### physical_only

| metric | GroupKFold by station | forward time split |
|---|---|---|
| test passes | 1413 | 284 |
| AUC-ROC | 0.784 [0.7565, 0.8052] | 0.730 [0.6663, 0.7852] |
| accuracy @0.5 (majority baseline) | 71.8% [0.6899, 0.7455] (55.0%) | 66.5% [0.6397, 0.7089] (57.0%) |
| failure precision @0.5 | 69.5% | 59.7% |
| P>=0.95 fail side: precision / recall | 90.6% / 12.1% | 83.3% / 8.2% |
| P>=0.95 ok side: precision / recall | 96.1% / 9.5% | 78.8% / 32.1% |
| P>=0.95 escalated to human | 88.5% | 72.5% |
| P>=0.95 oracle (thresholds fit on test): fail rec / ok rec / escalated | 1.7% / 7.6% / 94.8% | 4.9% / 21.6% / 85.2% |
| P>=0.98 fail side: precision / recall | 91.4% / 8.3% | 83.3% / 8.2% |
| P>=0.98 ok side: precision / recall | 97.7% / 5.5% | 87.0% / 29.0% |
| P>=0.98 escalated to human | 92.8% | 76.8% |
| P>=0.98 oracle (thresholds fit on test): fail rec / ok rec / escalated | 1.7% / 4.1% / 97.0% | 4.9% / 14.2% / 89.8% |
| ~17% escalation band: actual escalated / accuracy on auto-decided | 15.6% / 75.6% | 24.3% / 70.7% |

### history_only

| metric | GroupKFold by station | forward time split |
|---|---|---|
| test passes | 1413 | 284 |
| AUC-ROC | 0.645 [0.6004, 0.6715] | 0.746 [0.6364, 0.7882] |
| accuracy @0.5 (majority baseline) | 60.5% [0.5738, 0.6302] (55.0%) | 65.5% [0.5823, 0.6914] (57.0%) |
| failure precision @0.5 | 54.3% | 62.5% |
| P>=0.95 fail side: precision / recall | 88.9% / 1.3% | n/a (no pass cleared threshold) / 0.0% |
| P>=0.95 ok side: precision / recall | 77.8% / 3.6% | 87.8% / 26.5% |
| P>=0.95 escalated to human | 96.8% | 82.7% |
| P>=0.95 oracle (thresholds fit on test): fail rec / ok rec / escalated | 0.9% / 0.5% / 99.2% | 5.7% / 14.2% / 89.1% |
| P>=0.98 fail side: precision / recall | 88.9% / 1.3% | n/a (no pass cleared threshold) / 0.0% |
| P>=0.98 ok side: precision / recall | 77.8% / 3.6% | 86.8% / 20.4% |
| P>=0.98 escalated to human | 96.8% | 86.6% |
| P>=0.98 oracle (thresholds fit on test): fail rec / ok rec / escalated | 0.9% / 0.5% / 99.2% | 5.7% / 8.6% / 92.6% |
| ~17% escalation band: actual escalated / accuracy on auto-decided | 7.6% / 61.2% | 38.4% / 74.9% |

### LEAKY_raw_station_id+physical

| metric | GroupKFold by station | forward time split |
|---|---|---|
| test passes | 1413 | 284 |
| AUC-ROC | 0.785 [0.7591, 0.8058] | 0.741 [0.6625, 0.8076] |
| accuracy @0.5 (majority baseline) | 71.3% [0.6807, 0.741] (55.0%) | 67.6% [0.6629, 0.7089] (57.0%) |
| failure precision @0.5 | 68.9% | 60.9% |
| P>=0.95 fail side: precision / recall | 93.8% / 11.9% | 90.0% / 7.4% |
| P>=0.95 ok side: precision / recall | 91.8% / 8.6% | 83.6% / 37.7% |
| P>=0.95 escalated to human | 89.1% | 70.8% |
| P>=0.95 oracle (thresholds fit on test): fail rec / ok rec / escalated | 9.6% / 5.5% / 92.3% | 6.6% / 16.7% / 87.3% |
| P>=0.98 fail side: precision / recall | 97.6% / 6.3% | 90.0% / 7.4% |
| P>=0.98 ok side: precision / recall | 100.0% / 4.4% | 83.1% / 33.3% |
| P>=0.98 escalated to human | 94.7% | 73.6% |
| P>=0.98 oracle (thresholds fit on test): fail rec / ok rec / escalated | 5.8% / 2.7% / 95.9% | 6.6% / 6.2% / 93.7% |
| ~17% escalation band: actual escalated / accuracy on auto-decided | 15.6% / 75.4% | 20.4% / 71.2% |

## Feature importance (physical+history)

| feature | gain share, GroupKFold | gain share, time split | mean abs SHAP, final model |
|---|---|---|---|
| sat_bstar | 7.6% | 7.3% | 0.220 |
| station_hist_rate | 7.2% | 4.8% | 0.212 |
| station_band_hist_rate | 6.3% | 7.8% | 0.243 |
| log_baud | 5.5% | 5.5% | 0.197 |
| tle_age_days | 4.7% | 5.0% | 0.132 |
| sat_age_years | 4.4% | 4.1% | 0.122 |
| downlink_freq_mhz | 3.9% | 3.1% | 0.054 |
| geomag_abs_lat | 3.9% | 5.0% | 0.153 |
| station_age_days | 3.6% | 3.0% | 0.061 |
| tx_hist_rate | 3.6% | 4.5% | 0.173 |
| local_solar_hour | 3.5% | 3.9% | 0.088 |
| station_altitude_m | 3.4% | 3.6% | 0.060 |
| sat_inclination_deg | 3.3% | 3.8% | 0.049 |
| sun_elevation_deg | 3.3% | 3.1% | 0.061 |
| duration_sec | 3.2% | 3.6% | 0.068 |
| sat_hist_rate | 2.9% | 1.2% | 0.245 |
| station_min_horizon_deg | 2.9% | 3.4% | 0.179 |
| kp_x_geomag_lat | 2.8% | 2.4% | 0.043 |
| station_abs_lat | 2.7% | 2.5% | 0.083 |
| sat_apogee_km | 2.5% | 3.3% | 0.060 |
| elevation_margin_deg | 2.2% | 2.1% | 0.086 |
| sat_perigee_km | 2.0% | 2.0% | 0.044 |
| azimuth_span_deg | 1.9% | 1.4% | 0.037 |
| antenna_type | 1.8% | 1.3% | 0.169 |
| sat_mean_motion | 1.5% | 1.8% | 0.023 |
| max_elevation_deg | 1.4% | 2.0% | 0.039 |
| freq_offset_khz | 1.0% | 1.1% | 0.052 |
| kp_at_time | 1.0% | 0.6% | 0.024 |
| station_band_hist_log_n | 0.9% | 0.9% | 0.023 |
| station_hist_log_n | 0.8% | 0.7% | 0.006 |
| band | 0.7% | 0.9% | 0.044 |
| kp_max_24h | 0.6% | 0.8% | 0.021 |
| sat_hist_log_n | 0.6% | 0.4% | 0.029 |
| station_14d_hist_rate | 0.6% | 0.7% | 0.023 |
| tx_hist_log_n | 0.6% | 0.2% | 0.009 |
| station_n_antennas | 0.6% | 0.8% | 0.023 |
| transmitter_mode | 0.5% | 1.1% | 0.032 |
| station_14d_hist_log_n | 0.3% | 0.1% | 0.010 |
| self_scheduled | 0.1% | 0.2% | 0.010 |
| is_night | 0.1% | 0.1% | 0.001 |
| transmitter_type | 0.0% | 0.0% | 0.000 |
| station_min_culmination_deg | 0.0% | 0.0% | 0.000 |
| antenna_covers_freq | 0.0% | 0.0% | 0.000 |
| tle_source | 0.0% | 0.0% | 0.000 |
