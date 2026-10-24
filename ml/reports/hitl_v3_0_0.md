# Human-in-the-loop replay (v3)

Generated 2026-10-24T15:39:56.470131+00:00 by `python -m ml.hitl simulate`. Initial model trained on 587 passes before 2026-10-21T08:39 UTC; later passes are replayed in time order. Every escalated pass gets its true SatNOGS label as the human ruling 1h after the pass ends. Refit every 2h of replay time.

- `frozen`: no updates.
- `enrich_only`: rulings only make outcomes known earlier to the history features; model unchanged.
- `warm`: enrich + continued boosting on rulings (+ replay sample), gate re-aligned to the same flagged share.
- `full`: enrich + nested refit (inner station-grouped OOF -> isotonic + Wilson 0.95 threshold).

| mode | auto 'failed' calls | precision | 95% CI (Wilson) | failures auto-decided | `failed` class auto-decided | escalated | human labels | refits | mean refit time |
|---|---|---|---|---|---|---|---|---|---|
| frozen | 93 | 0.925 | 0.853–0.963 | 22.2% | 37.4% | 89.4% | 0 | 0 | –s |
| enrich_only | 90 | 0.944 | 0.876–0.976 | 22.0% | 35.6% | 89.8% | 0 | 0 | –s |
| warm | 103 | 0.932 | 0.866–0.967 | 24.8% | 39.1% | 88.3% | 644 | 3 | 0.12s |
| full | 36 | 0.917 | 0.782–0.971 | 8.5% | 14.9% | 95.8% | 688 | 3 | 1.30s |

Failures auto-decided per replay bucket (equal pass counts, oldest first); precision in brackets:

| mode | b1 | b2 | b3 | b4 |
|---|---|---|---|---|
| frozen | 18.5% (0.94, n=16) | 19.8% (0.88, n=24) | 21.4% (0.88, n=25) | 28.9% (1.00, n=28) |
| enrich_only | 18.5% (0.94, n=16) | 20.8% (0.88, n=25) | 19.4% (0.95, n=21) | 28.9% (1.00, n=28) |
| warm | 18.5% (0.94, n=16) | 23.6% (0.89, n=28) | 24.3% (0.93, n=27) | 32.0% (0.97, n=32) |
| full | 18.5% (0.94, n=16) | 15.1% (0.89, n=18) | 0.0% (–, n=0) | 2.1% (1.00, n=2) |

![HITL replay](hitl_v3.png)
