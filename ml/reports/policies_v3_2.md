# v3.2 policy layer: held-out evaluation

Generated 2026-10-24T19:04:04.476487+00:00 by `python -m ml.policies evaluate`. Ordered first-match policies on top of the v3.1.0 gate; every threshold and mined rule is fit inside the training fold. Target: Wilson lower bound (z = 1.2816) of precision >= 0.95 on each auto-decided side, on held-out stations (5 station-grouped folds) and future time (last 30%, 3h embargo). Tier A excludes the pass's own artifacts; tier B adds them (see README for why they largely restate the label).

## Label latency 1h

3604 passes, 350 stations, {'good': 1973, 'bad': 1020, 'failed': 611}.

| configuration | split | auto 'failed': n / precision / 95% CI / LB80 | auto 'ok': n / precision / 95% CI / LB80 | coverage | escalated | accuracy on auto-decided | meets target |
|---|---|---|---|---|---|---|---|
| v3.1.0 model only | held-out stations | 380 / 0.979 / 0.959–0.989 / 0.967 | 0 / – / – / – | 10.5% | 89.5% | 0.979 | yes |
| v3.1.0 model only | future time | 157 / 0.981 / 0.945–0.993 / 0.961 | 0 / – / – / – | 14.5% | 85.5% | 0.981 | yes |
| tier A, all policies | held-out stations | 448 / 0.931 / 0.903–0.951 / 0.914 | 45 / 0.978 / 0.884–0.996 / 0.929 | 13.7% | 86.3% | 0.935 | no |
| tier A, all policies | future time | 159 / 0.975 / 0.937–0.990 / 0.953 | 0 / – / – / – | 14.7% | 85.3% | 0.975 | yes |
| tier A, kept policies (v3.2) | held-out stations | 380 / 0.979 / 0.959–0.989 / 0.967 | 0 / – / – / – | 10.5% | 89.5% | 0.979 | yes |
| tier A, kept policies (v3.2) | future time | 157 / 0.981 / 0.945–0.993 / 0.961 | 0 / – / – / – | 14.5% | 85.5% | 0.981 | yes |
| tier B, all policies | held-out stations | 523 / 0.998 / 0.989–1.000 / 0.994 | 1144 / 0.993 / 0.986–0.996 / 0.989 | 46.3% | 53.7% | 0.995 | yes |
| tier B, all policies | future time | 217 / 1.000 / 0.983–1.000 / 0.992 | 347 / 0.997 / 0.984–0.999 / 0.990 | 52.2% | 47.8% | 0.998 | yes |
| tier B, kept policies (v3.2) | held-out stations | 510 / 0.998 / 0.989–1.000 / 0.993 | 1144 / 0.993 / 0.986–0.996 / 0.989 | 45.9% | 54.1% | 0.995 | yes |
| tier B, kept policies (v3.2) | future time | 217 / 1.000 / 0.983–1.000 / 0.992 | 347 / 0.997 / 0.984–0.999 / 0.990 | 52.2% | 47.8% | 0.998 | yes |

### Tier A: per-policy contribution (all policies, first match wins)

Kept: model-gate.

| policy | effect | split | decided (n) | precision | 95% CI | LB80 | coverage added (first match) | coverage lost if removed | folds enabled |
|---|---|---|---|---|---|---|---|---|---|
| model-gate | failed | stations | 253 | 0.988 | 0.966–0.996 | 0.976 | 7.0% | 7.0% | 5 |
| model-gate | failed | time | 118 | 0.983 | 0.940–0.995 | 0.960 | 10.9% | 10.9% | 1 |
| ops-outage-streak | failed | stations | 195 | 0.856 | 0.800–0.899 | 0.821 | 5.4% | 3.9% | 2 |
| ops-outage-streak | failed | time | 41 | 0.951 | 0.839–0.987 | 0.888 | 3.8% | 1.1% | 1 |
| stage2-ok | ok | stations | 45 | 0.978 | 0.884–0.996 | 0.929 | 1.2% | 1.2% | 2 |

### Tier B: per-policy contribution (all policies, first match wins)

Kept: model-gate, ops-decoded-frames, ops-no-artifacts.

| policy | effect | split | decided (n) | precision | 95% CI | LB80 | coverage added (first match) | coverage lost if removed | folds enabled |
|---|---|---|---|---|---|---|---|---|---|
| model-gate | failed | stations | 33 | 0.970 | 0.847–0.995 | 0.904 | 0.9% | 0.9% | 2 |
| model-gate | failed | time | 50 | 1.000 | 0.929–1.000 | 0.968 | 4.6% | 4.6% | 1 |
| ops-decoded-frames | ok | stations | 1144 | 0.993 | 0.986–0.996 | 0.989 | 31.7% | 31.7% | 5 |
| ops-decoded-frames | ok | time | 347 | 0.997 | 0.984–0.999 | 0.990 | 32.1% | 32.1% | 1 |
| ops-no-artifacts | failed | stations | 477 | 1.000 | 0.992–1.000 | 0.997 | 13.2% | 11.1% | 5 |
| ops-no-artifacts | failed | time | 167 | 1.000 | 0.978–1.000 | 0.990 | 15.4% | 7.8% | 1 |
| stage2-failed | failed | stations | 13 | 1.000 | 0.772–1.000 | 0.888 | 0.4% | 0.4% | 3 |

Tier A kept, future time, stations unseen in training (n=33): failed 2 @ 1.000 (0.342–1.000), ok 0 @ – (–), escalated 93.9%.

Tier B kept, future time, stations unseen in training (n=33): failed 9 @ 1.000 (0.701–1.000), ok 11 @ 1.000 (0.741–1.000), escalated 39.4%.

## Label latency 3h

3390 passes, 348 stations, {'good': 1858, 'bad': 947, 'failed': 585}.

| configuration | split | auto 'failed': n / precision / 95% CI / LB80 | auto 'ok': n / precision / 95% CI / LB80 | coverage | escalated | accuracy on auto-decided | meets target |
|---|---|---|---|---|---|---|---|
| v3.1.0 model only | held-out stations | 94 / 0.904 / 0.828–0.949 / 0.858 | 0 / – / – / – | 2.8% | 97.2% | 0.904 | no |
| v3.1.0 model only | future time | 0 / – / – / – | 0 / – / – / – | 0.0% | 100.0% | – | yes |
| tier A, all policies | held-out stations | 209 / 0.919 / 0.874–0.949 / 0.891 | 295 / 0.973 / 0.947–0.986 / 0.958 | 14.9% | 85.1% | 0.950 | no |
| tier A, all policies | future time | 109 / 0.954 / 0.897–0.980 / 0.921 | 0 / – / – / – | 10.7% | 89.3% | 0.954 | no |
| tier A, kept policies (v3.2) | held-out stations | 0 / – / – / – | 0 / – / – / – | 0.0% | 100.0% | – | yes |
| tier A, kept policies (v3.2) | future time | 0 / – / – / – | 0 / – / – / – | 0.0% | 100.0% | – | yes |
| tier B, all policies | held-out stations | 548 / 0.987 / 0.974–0.994 / 0.979 | 1082 / 0.993 / 0.985–0.996 / 0.988 | 48.1% | 51.9% | 0.991 | yes |
| tier B, all policies | future time | 197 / 0.990 / 0.964–0.997 / 0.976 | 318 / 0.997 / 0.982–0.999 / 0.990 | 50.6% | 49.4% | 0.994 | yes |
| tier B, kept policies (v3.2) | held-out stations | 453 / 1.000 / 0.992–1.000 / 0.996 | 1082 / 0.993 / 0.985–0.996 / 0.988 | 45.3% | 54.7% | 0.995 | yes |
| tier B, kept policies (v3.2) | future time | 159 / 1.000 / 0.976–1.000 / 0.990 | 318 / 0.997 / 0.982–0.999 / 0.990 | 46.9% | 53.1% | 0.998 | yes |

### Tier A: per-policy contribution (all policies, first match wins)

Kept: none.

| policy | effect | split | decided (n) | precision | 95% CI | LB80 | coverage added (first match) | coverage lost if removed | folds enabled |
|---|---|---|---|---|---|---|---|---|---|
| model-gate | failed | stations | 62 | 0.952 | 0.867–0.983 | 0.904 | 1.8% | 1.8% | 2 |
| ops-outage-streak | failed | stations | 95 | 0.853 | 0.768–0.910 | 0.800 | 2.8% | 2.3% | 1 |
| ops-outage-streak | failed | time | 55 | 0.909 | 0.804–0.961 | 0.847 | 5.4% | 4.2% | 1 |
| stage2-failed | failed | stations | 52 | 1.000 | 0.931–1.000 | 0.969 | 1.5% | 1.5% | 2 |
| stage2-failed | failed | time | 54 | 1.000 | 0.934–1.000 | 0.970 | 5.3% | 5.3% | 1 |
| stage2-ok | ok | stations | 295 | 0.973 | 0.947–0.986 | 0.958 | 8.7% | 8.7% | 5 |

### Tier B: per-policy contribution (all policies, first match wins)

Kept: ops-decoded-frames, ops-no-artifacts.

| policy | effect | split | decided (n) | precision | 95% CI | LB80 | coverage added (first match) | coverage lost if removed | folds enabled |
|---|---|---|---|---|---|---|---|---|---|
| model-gate | failed | stations | 29 | 1.000 | 0.883–1.000 | 0.946 | 0.9% | 0.9% | 1 |
| ops-decoded-frames | ok | stations | 1082 | 0.993 | 0.985–0.996 | 0.988 | 31.9% | 31.8% | 5 |
| ops-decoded-frames | ok | time | 318 | 0.997 | 0.982–0.999 | 0.990 | 31.3% | 30.8% | 1 |
| ops-no-artifacts | failed | stations | 453 | 1.000 | 0.992–1.000 | 0.996 | 13.4% | 11.4% | 5 |
| ops-no-artifacts | failed | time | 159 | 1.000 | 0.976–1.000 | 0.990 | 15.6% | 13.1% | 1 |
| phys-stale-tle | failed | stations | 10 | 0.800 | 0.490–0.943 | 0.602 | 0.3% | 0.3% | 1 |
| phys-stale-tle | failed | time | 12 | 1.000 | 0.757–1.000 | 0.880 | 1.2% | 1.0% | 1 |
| stage2-failed | failed | stations | 56 | 0.911 | 0.807–0.961 | 0.849 | 1.7% | 1.7% | 1 |
| stage2-failed | failed | time | 26 | 0.923 | 0.759–0.979 | 0.828 | 2.6% | 2.6% | 1 |

Tier A kept, future time, stations unseen in training (n=36): failed 0 @ – (–), ok 0 @ – (–), escalated 100.0%.

Tier B kept, future time, stations unseen in training (n=36): failed 9 @ 1.000 (0.701–1.000), ok 11 @ 1.000 (0.741–1.000), escalated 44.4%.
