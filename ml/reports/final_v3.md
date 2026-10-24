# Final pass-failure classifier (v3): held-out evaluation

Generated 2026-10-24T18:06:55.342554+00:00 by `python -m ml.final_model evaluate`. Main tables use in-fold threshold rule `wilson80` (Wilson lower bound (z=1.2816) of inner OOF precision >= 0.95); the gate threshold is always picked on station-grouped out-of-fold scores *inside the training fold* and then applied once to the test fold. Failure = SatNOGS status `failed` or `bad`. Precision CIs: Wilson (binomial) and station-cluster bootstrap (resampling stations, 1,000 reps). Coverage = share of all test passes auto-decided as failed.

## Label latency 1h

3604 labeled passes with full 1h+6h history coverage (of 5365 stored observations), 350 stations, span 2026-10-20T13:01 to 2026-10-21T16:54 UTC. Status mix: {'good': 1973, 'bad': 1020, 'failed': 611}.

### Held-out stations (5 station-grouped folds)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.726 | 15 | 1.000 | 0.796–1.000 | 1.000–1.000 | 0.9% | 0.5% / 1.2% | 0.4% | – / 0.0% | 1.000 |
| pr12_state | 0.843 | 213 | 0.972 | 0.940–0.987 | 0.936–0.993 | 12.7% | 22.7% / 6.7% | 5.9% | – / 0.0% | 0.972 |
| full_causal | 0.873 | 380 | 0.979 | 0.959–0.989 | 0.960–0.997 | 22.8% | 39.0% / 13.1% | 10.5% | 0.959 / 2.1% | 0.976 |
| full_causal_mono | 0.869 | 336 | 0.976 | 0.954–0.988 | 0.953–0.996 | 20.1% | 35.4% / 11.0% | 9.3% | 0.957 / 3.2% | 0.971 |
| full_causal_mono_ev | 0.869 | 336 | 0.938 | 0.906–0.959 | 0.880–0.995 | 19.3% | 40.9% / 6.4% | 9.3% | 0.957 / 3.2% | 0.942 |
| rule_streak | 0.664 | 171 | 0.965 | 0.926–0.984 | 0.892–1.000 | 10.1% | 23.9% / 1.9% | 4.7% | – / 0.0% | 0.965 |

### Future time (train first 70%, 3h embargo)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.870 | 81 | 0.926 | 0.848–0.966 | 0.854–0.978 | 15.8% | 14.7% / 16.7% | 7.5% | – / 0.0% | 0.926 |
| pr12_state | 0.895 | 194 | 0.923 | 0.876–0.953 | 0.868–0.964 | 37.6% | 52.3% / 25.2% | 17.9% | 1.000 / 1.9% | 0.930 |
| full_causal | 0.902 | 157 | 0.981 | 0.945–0.993 | 0.950–1.000 | 32.4% | 46.3% / 20.5% | 14.5% | – / 0.0% | 0.981 |
| full_causal_mono | 0.904 | 203 | 0.951 | 0.912–0.973 | 0.905–0.982 | 40.5% | 56.0% / 27.5% | 18.8% | – / 0.0% | 0.951 |
| full_causal_mono_ev | 0.904 | 148 | 0.986 | 0.952–0.996 | 0.965–1.000 | 30.7% | 60.1% / 5.8% | 13.7% | – / 0.0% | 0.986 |
| rule_streak | 0.743 | 47 | 1.000 | 0.924–1.000 | 1.000–1.000 | 9.9% | 21.6% / 0.0% | 4.3% | – / 0.0% | 1.000 |

Future time, test stations never seen in training:

| variant | n | auto 'failed' calls | precision | 95% CI (Wilson) | recall |
|---|---|---|---|---|---|
| physics | 33 | 0 | – | – | 0.0% |
| pr12_state | 33 | 4 | 1.000 | 0.510–1.000 | 25.0% |
| full_causal | 33 | 2 | 1.000 | 0.342–1.000 | 12.5% |
| full_causal_mono | 33 | 4 | 1.000 | 0.510–1.000 | 25.0% |
| full_causal_mono_ev | 33 | 3 | 1.000 | 0.438–1.000 | 18.8% |
| rule_streak | 33 | 0 | – | – | 0.0% |

### In-fold threshold rule comparison (failed side)

| variant | rule | held-out stations: calls / precision (Wilson CI) / recall | future time: calls / precision (Wilson CI) / recall |
|---|---|---|---|
| physics | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| physics | wilson80 | 15 / 1.000 (0.796–1.000) / 0.9% | 81 / 0.926 (0.848–0.966) / 15.8% |
| physics | point97 | 26 / 1.000 (0.871–1.000) / 1.6% | 92 / 0.935 (0.865–0.970) / 18.1% |
| physics | point95 | 73 / 0.973 (0.905–0.992) / 4.4% | 123 / 0.927 (0.867–0.961) / 23.9% |
| pr12_state | wilson95 | 164 / 0.982 (0.948–0.994) / 9.9% | 0 / – (–) / 0.0% |
| pr12_state | wilson80 | 213 / 0.972 (0.940–0.987) / 12.7% | 194 / 0.923 (0.876–0.953) / 37.6% |
| pr12_state | point97 | 215 / 0.972 (0.940–0.987) / 12.8% | 194 / 0.923 (0.876–0.953) / 37.6% |
| pr12_state | point95 | 360 / 0.972 (0.950–0.985) / 21.5% | 244 / 0.906 (0.863–0.936) / 46.4% |
| full_causal | wilson95 | 168 / 0.976 (0.940–0.991) / 10.1% | 115 / 1.000 (0.968–1.000) / 24.2% |
| full_causal | wilson80 | 380 / 0.979 (0.959–0.989) / 22.8% | 157 / 0.981 (0.945–0.993) / 32.4% |
| full_causal | point97 | 366 / 0.984 (0.965–0.992) / 22.1% | 157 / 0.981 (0.945–0.993) / 32.4% |
| full_causal | point95 | 498 / 0.954 (0.932–0.969) / 29.1% | 266 / 0.906 (0.865–0.936) / 50.6% |
| full_causal_mono | wilson95 | 268 / 0.981 (0.957–0.992) / 16.1% | 154 / 0.974 (0.935–0.990) / 31.5% |
| full_causal_mono | wilson80 | 336 / 0.976 (0.954–0.988) / 20.1% | 203 / 0.951 (0.912–0.973) / 40.5% |
| full_causal_mono | point97 | 296 / 0.976 (0.952–0.988) / 17.7% | 190 / 0.958 (0.919–0.979) / 38.2% |
| full_causal_mono | point95 | 459 / 0.965 (0.944–0.978) / 27.2% | 244 / 0.922 (0.882–0.950) / 47.3% |
| full_causal_mono_ev | wilson95 | 266 / 0.966 (0.937–0.982) / 15.8% | 0 / – (–) / 0.0% |
| full_causal_mono_ev | wilson80 | 336 / 0.938 (0.906–0.959) / 19.3% | 148 / 0.986 (0.952–0.996) / 30.7% |
| full_causal_mono_ev | point97 | 334 / 0.937 (0.906–0.959) / 19.2% | 150 / 0.980 (0.943–0.993) / 30.9% |
| full_causal_mono_ev | point95 | 391 / 0.941 (0.913–0.960) / 22.6% | 152 / 0.974 (0.934–0.990) / 31.1% |
| rule_streak | wilson95 | 66 / 1.000 (0.945–1.000) / 4.0% | 0 / – (–) / 0.0% |
| rule_streak | wilson80 | 171 / 0.965 (0.926–0.984) / 10.1% | 47 / 1.000 (0.924–1.000) / 9.9% |
| rule_streak | point97 | 201 / 0.930 (0.886–0.958) / 11.5% | 66 / 1.000 (0.945–1.000) / 13.9% |
| rule_streak | point95 | 287 / 0.892 (0.851–0.923) / 15.7% | 66 / 1.000 (0.945–1.000) / 13.9% |

Per-fold precision of `full_causal` on held-out stations (wilson80): 0.979 (n=96), 1.000 (n=54), 0.985 (n=67), 1.000 (n=28), 0.963 (n=135)

## Label latency 3h

3390 labeled passes with full 3h+6h history coverage (of 5365 stored observations), 348 stations, span 2026-10-20T15:00 to 2026-10-21T16:54 UTC. Status mix: {'good': 1858, 'bad': 947, 'failed': 585}.

### Held-out stations (5 station-grouped folds)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.781 | 11 | 1.000 | 0.741–1.000 | 1.000–1.000 | 0.7% | 0.2% / 1.1% | 0.3% | – / 0.0% | 1.000 |
| pr12_state | 0.835 | 70 | 0.943 | 0.862–0.978 | 0.841–1.000 | 4.3% | 5.0% / 3.9% | 2.1% | – / 0.0% | 0.943 |
| full_causal | 0.868 | 94 | 0.904 | 0.828–0.949 | 0.806–1.000 | 5.5% | 8.5% / 3.7% | 2.8% | – / 0.0% | 0.904 |
| full_causal_mono | 0.866 | 121 | 0.967 | 0.918–0.987 | 0.920–1.000 | 7.6% | 12.5% / 4.6% | 3.6% | 0.909 / 0.6% | 0.958 |
| full_causal_mono_ev | 0.866 | 108 | 0.917 | 0.849–0.956 | 0.842–1.000 | 6.5% | 12.8% / 2.5% | 3.2% | 0.909 / 0.6% | 0.915 |
| rule_streak | 0.632 | 161 | 0.907 | 0.852–0.943 | 0.818–1.000 | 9.5% | 19.1% / 3.6% | 4.7% | – / 0.0% | 0.907 |

### Future time (train first 70%, 3h embargo)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.871 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 0.955 / 2.2% | 0.955 |
| pr12_state | 0.893 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| full_causal | 0.887 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| full_causal_mono | 0.887 | 144 | 0.910 | 0.852–0.946 | 0.835–0.963 | 28.8% | 39.4% / 20.6% | 14.2% | 0.985 / 6.4% | 0.933 |
| full_causal_mono_ev | 0.887 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 0.985 / 6.4% | 0.985 |
| rule_streak | 0.734 | 29 | 1.000 | 0.883–1.000 | 1.000–1.000 | 6.4% | 13.6% / 0.8% | 2.9% | – / 0.0% | 1.000 |

Future time, test stations never seen in training:

| variant | n | auto 'failed' calls | precision | 95% CI (Wilson) | recall |
|---|---|---|---|---|---|
| physics | 36 | 0 | – | – | 0.0% |
| pr12_state | 36 | 0 | – | – | 0.0% |
| full_causal | 36 | 0 | – | – | 0.0% |
| full_causal_mono | 36 | 1 | 1.000 | 0.207–1.000 | 5.9% |
| full_causal_mono_ev | 36 | 0 | – | – | 0.0% |
| rule_streak | 36 | 0 | – | – | 0.0% |

### In-fold threshold rule comparison (failed side)

| variant | rule | held-out stations: calls / precision (Wilson CI) / recall | future time: calls / precision (Wilson CI) / recall |
|---|---|---|---|
| physics | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| physics | wilson80 | 11 / 1.000 (0.741–1.000) / 0.7% | 0 / – (–) / 0.0% |
| physics | point97 | 56 / 1.000 (0.936–1.000) / 3.7% | 6 / 1.000 (0.610–1.000) / 1.3% |
| physics | point95 | 79 / 0.975 (0.912–0.993) / 5.0% | 166 / 0.886 (0.828–0.925) / 32.3% |
| pr12_state | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| pr12_state | wilson80 | 70 / 0.943 (0.862–0.978) / 4.3% | 0 / – (–) / 0.0% |
| pr12_state | point97 | 140 / 0.964 (0.919–0.985) / 8.8% | 4 / 1.000 (0.510–1.000) / 0.9% |
| pr12_state | point95 | 188 / 0.957 (0.918–0.978) / 11.7% | 217 / 0.899 (0.851–0.932) / 42.9% |
| full_causal | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal | wilson80 | 94 / 0.904 (0.828–0.949) / 5.5% | 0 / – (–) / 0.0% |
| full_causal | point97 | 166 / 0.946 (0.900–0.971) / 10.2% | 119 / 0.924 (0.862–0.960) / 24.2% |
| full_causal | point95 | 331 / 0.949 (0.919–0.968) / 20.5% | 184 / 0.897 (0.844–0.933) / 36.3% |
| full_causal_mono | wilson95 | 16 / 0.938 (0.717–0.989) / 1.0% | 0 / – (–) / 0.0% |
| full_causal_mono | wilson80 | 121 / 0.967 (0.918–0.987) / 7.6% | 144 / 0.910 (0.852–0.946) / 28.8% |
| full_causal_mono | point97 | 127 / 0.976 (0.933–0.992) / 8.1% | 144 / 0.910 (0.852–0.946) / 28.8% |
| full_causal_mono | point95 | 254 / 0.961 (0.929–0.978) / 15.9% | 192 / 0.911 (0.863–0.944) / 38.5% |
| full_causal_mono_ev | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal_mono_ev | wilson80 | 108 / 0.917 (0.849–0.956) / 6.5% | 0 / – (–) / 0.0% |
| full_causal_mono_ev | point97 | 174 / 0.948 (0.905–0.973) / 10.8% | 81 / 0.988 (0.933–0.998) / 17.6% |
| full_causal_mono_ev | point95 | 249 / 0.936 (0.898–0.960) / 15.2% | 97 / 0.979 (0.928–0.994) / 20.9% |
| rule_streak | wilson95 | 134 / 0.888 (0.824–0.931) / 7.8% | 0 / – (–) / 0.0% |
| rule_streak | wilson80 | 161 / 0.907 (0.852–0.943) / 9.5% | 29 / 1.000 (0.883–1.000) / 6.4% |
| rule_streak | point97 | 166 / 0.910 (0.856–0.944) / 9.9% | 40 / 0.975 (0.871–0.996) / 8.6% |
| rule_streak | point95 | 173 / 0.913 (0.862–0.947) / 10.3% | 40 / 0.975 (0.871–0.996) / 8.6% |

Per-fold precision of `full_causal` on held-out stations (wilson80): – (n=0), 0.946 (n=37), 0.877 (n=57), – (n=0), – (n=0)

![held-out stations PR](final_v3_pr_station.png)

![future time PR](final_v3_pr_time.png)
