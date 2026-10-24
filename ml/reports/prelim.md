# Final pass-failure classifier (v3): held-out evaluation

Generated 2026-10-24T15:21:45.061806+00:00 by `python -m ml.final_model evaluate`. Main tables use in-fold threshold rule `wilson80` (Wilson lower bound (z=1.2816) of inner OOF precision >= 0.95); the gate threshold is always picked on station-grouped out-of-fold scores *inside the training fold* and then applied once to the test fold. Failure = SatNOGS status `failed` or `bad`. Precision CIs: Wilson (binomial) and station-cluster bootstrap (resampling stations, 1,000 reps). Coverage = share of all test passes auto-decided as failed.

## Label latency 1h

1216 labeled passes with full 1h+6h history coverage (of 2846 stored observations), 288 stations, span 2026-10-21T06:01 to 2026-10-21T14:56 UTC. Status mix: {'good': 675, 'bad': 293, 'failed': 248}.

### Held-out stations (5 station-grouped folds)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.776 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| pr12_state | 0.868 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 0.965 / 4.7% | 0.965 |
| full_causal | 0.871 | 28 | 0.964 | 0.823–0.994 | 0.867–1.000 | 5.0% | 7.7% / 2.7% | 2.3% | 0.930 / 7.1% | 0.939 |
| full_causal_mono | 0.872 | 13 | 1.000 | 0.772–1.000 | 1.000–1.000 | 2.4% | 3.2% / 1.7% | 1.1% | 0.918 / 8.1% | 0.928 |
| rule_streak | 0.688 | 67 | 1.000 | 0.946–1.000 | 1.000–1.000 | 12.4% | 26.6% / 0.3% | 5.5% | – / 0.0% | 1.000 |

### Future time (train first 70%, 3h embargo)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.742 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| pr12_state | 0.784 | 33 | 0.909 | 0.764–0.969 | 0.774–1.000 | 18.0% | 32.4% / 8.1% | 9.0% | – / 0.0% | 0.909 |
| full_causal | 0.813 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| full_causal_mono | 0.817 | 39 | 0.949 | 0.831–0.986 | 0.846–1.000 | 22.2% | 38.2% / 11.1% | 10.7% | – / 0.0% | 0.949 |
| rule_streak | 0.674 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |

Future time, test stations never seen in training:

| variant | n | auto 'failed' calls | precision | 95% CI (Wilson) | recall |
|---|---|---|---|---|---|
| physics | 108 | 0 | – | – | 0.0% |
| pr12_state | 108 | 5 | 0.400 | 0.118–0.769 | 5.9% |
| full_causal | 108 | 0 | – | – | 0.0% |
| full_causal_mono | 108 | 2 | 0.000 | 0.000–0.658 | 0.0% |
| rule_streak | 108 | 0 | – | – | 0.0% |

### In-fold threshold rule comparison (failed side)

| variant | rule | held-out stations: calls / precision (Wilson CI) / recall | future time: calls / precision (Wilson CI) / recall |
|---|---|---|---|
| physics | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| physics | wilson80 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| physics | point97 | 7 / 1.000 (0.646–1.000) / 1.3% | 0 / – (–) / 0.0% |
| physics | point95 | 7 / 1.000 (0.646–1.000) / 1.3% | 0 / – (–) / 0.0% |
| pr12_state | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| pr12_state | wilson80 | 0 / – (–) / 0.0% | 33 / 0.909 (0.764–0.969) / 18.0% |
| pr12_state | point97 | 43 / 0.930 (0.814–0.976) / 7.4% | 34 / 0.882 (0.734–0.953) / 18.0% |
| pr12_state | point95 | 73 / 0.932 (0.849–0.970) / 12.6% | 37 / 0.865 (0.720–0.941) / 19.2% |
| full_causal | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal | wilson80 | 28 / 0.964 (0.823–0.994) / 5.0% | 0 / – (–) / 0.0% |
| full_causal | point97 | 46 / 0.978 (0.887–0.996) / 8.3% | 50 / 0.900 (0.786–0.957) / 26.9% |
| full_causal | point95 | 129 / 0.891 (0.826–0.934) / 21.3% | 57 / 0.877 (0.768–0.939) / 29.9% |
| full_causal_mono | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal_mono | wilson80 | 13 / 1.000 (0.772–1.000) / 2.4% | 39 / 0.949 (0.831–0.986) / 22.2% |
| full_causal_mono | point97 | 50 / 0.980 (0.895–0.996) / 9.1% | 53 / 0.925 (0.821–0.970) / 29.3% |
| full_causal_mono | point95 | 126 / 0.897 (0.831–0.939) / 20.9% | 55 / 0.891 (0.782–0.949) / 29.3% |
| rule_streak | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| rule_streak | wilson80 | 67 / 1.000 (0.946–1.000) / 12.4% | 0 / – (–) / 0.0% |
| rule_streak | point97 | 77 / 0.948 (0.874–0.980) / 13.5% | 18 / 1.000 (0.824–1.000) / 10.8% |
| rule_streak | point95 | 88 / 0.932 (0.859–0.968) / 15.2% | 34 / 0.912 (0.770–0.970) / 18.6% |

Per-fold precision of `full_causal_mono` on held-out stations (wilson80): – (n=0), – (n=0), – (n=0), – (n=0), 1.000 (n=13)

## Label latency 3h

960 labeled passes with full 3h+6h history coverage (of 2846 stored observations), 266 stations, span 2026-10-21T08:00 to 2026-10-21T14:56 UTC. Status mix: {'good': 534, 'bad': 238, 'failed': 188}.

### Held-out stations (5 station-grouped folds)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.703 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 1.000 / 0.5% | 1.000 |
| pr12_state | 0.787 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 0.875 / 0.8% | 0.875 |
| full_causal | 0.811 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 0.875 / 2.5% | 0.875 |
| full_causal_mono | 0.815 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | 0.812 / 1.7% | 0.812 |
| rule_streak | 0.642 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |

### Future time (train first 70%, 3h embargo)

| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) | recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage | accuracy on auto-decided (both sides) |
|---|---|---|---|---|---|---|---|---|---|---|
| physics | 0.635 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| pr12_state | 0.668 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| full_causal | 0.725 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| full_causal_mono | 0.725 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |
| rule_streak | 0.638 | 0 | – | – | – | 0.0% | 0.0% / 0.0% | 0.0% | – / 0.0% | – |

Future time, test stations never seen in training:

| variant | n | auto 'failed' calls | precision | 95% CI (Wilson) | recall |
|---|---|---|---|---|---|
| physics | 132 | 0 | – | – | 0.0% |
| pr12_state | 132 | 0 | – | – | 0.0% |
| full_causal | 132 | 0 | – | – | 0.0% |
| full_causal_mono | 132 | 0 | – | – | 0.0% |
| rule_streak | 132 | 0 | – | – | 0.0% |

### In-fold threshold rule comparison (failed side)

| variant | rule | held-out stations: calls / precision (Wilson CI) / recall | future time: calls / precision (Wilson CI) / recall |
|---|---|---|---|
| physics | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| physics | wilson80 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| physics | point97 | 15 / 0.867 (0.621–0.963) / 3.1% | 0 / – (–) / 0.0% |
| physics | point95 | 20 / 0.800 (0.584–0.919) / 3.8% | 0 / – (–) / 0.0% |
| pr12_state | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| pr12_state | wilson80 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| pr12_state | point97 | 37 / 0.946 (0.823–0.985) / 8.2% | 0 / – (–) / 0.0% |
| pr12_state | point95 | 52 / 0.904 (0.794–0.958) / 11.0% | 0 / – (–) / 0.0% |
| full_causal | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal | wilson80 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal | point97 | 11 / 0.818 (0.523–0.949) / 2.1% | 66 / 0.621 (0.501–0.729) / 33.3% |
| full_causal | point95 | 22 / 0.909 (0.722–0.975) / 4.7% | 66 / 0.621 (0.501–0.729) / 33.3% |
| full_causal_mono | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal_mono | wilson80 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| full_causal_mono | point97 | 14 / 0.929 (0.685–0.987) / 3.1% | 65 / 0.615 (0.494–0.724) / 32.5% |
| full_causal_mono | point95 | 38 / 0.895 (0.759–0.958) / 8.0% | 65 / 0.615 (0.494–0.724) / 32.5% |
| rule_streak | wilson95 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| rule_streak | wilson80 | 0 / – (–) / 0.0% | 0 / – (–) / 0.0% |
| rule_streak | point97 | 42 / 0.857 (0.722–0.933) / 8.5% | 0 / – (–) / 0.0% |
| rule_streak | point95 | 55 / 0.891 (0.782–0.949) / 11.5% | 0 / – (–) / 0.0% |

Per-fold precision of `full_causal_mono` on held-out stations (wilson80): – (n=0), – (n=0), – (n=0), – (n=0), – (n=0)

![held-out stations PR](prelim_pr_station.png)

![future time PR](prelim_pr_time.png)
