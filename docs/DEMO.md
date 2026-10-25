# Demo: the live v4 → v6 policy upgrade

[← README](../README.md)

By default `seed.sh` mines six months of human rulings into v6 and promotes it during the seed, so the app opens on v6. For a video or a live judge demo, the staged seed stops one step earlier: **v4 is current and v6 is proposed**. Promoting v6 on camera makes the escalation drop happen live.

## Prepare

```bash
# Maincloud (4–8 min). reseed.sh passes the variable through to seed.sh.
STAGE_MINED_POLICY=1 server/reseed.sh ground-truth-aamir maincloud --yes

# Local (about a minute), from the repo root
STAGE_MINED_POLICY=1 SPACETIMEDB_SERVER=local SPACETIMEDB_MODULE=ground-truth bash server/seed.sh
```

Keep the worker running as usual. To check the state:

```bash
spacetime sql ground-truth-aamir --server maincloud "SELECT id, status FROM policy_version"
# v4 current, v6 proposed, v5 proposed (blocked by replay)
```

What changes in staged mode, and nothing else:

- v6 and its 7 rules are `proposed`, and v4's Cedar is the active policy.
- Incoming claims are decided under v4, so **CLM-20004 and CLM-20008 wait in Approvals**. In the default seed, v6 rules auto-decide them. Promotion does not re-decide claims that are already filed.
- Break It's first run is decided under v4, so its Before and After bars match (v4 / v4) until v6 is promoted.

## The 60–90 second take

Figures below come from a local staged seed. Maincloud figures differ by a few cases from run to run because the pass history is regenerated from the current time.

| Time | Do | Show / say |
|---|---|---|
| 0:00 | Open **Policies** (`#/policies/v6`). | The sidebar shows **v4 Current** and v6 *Mined from history*. The counter says **3,387 escalations under v4, the active policy**, and a dashed line runs to proposed v6 at **1,642** (52% fewer; precision 98.86% → 99.06%). "Six months of human rulings, replayed: v6 would cut escalations in half with zero regressions." |
| 0:15 | Scroll to **What v6 enforces**. | Read one card aloud, e.g. *IF Partial downlink and Space weather: clear and Maintenance: short notice and Integrity check: passed → APPROVE. 441 past rulings agree · 0 disagree.* "Every rule is a pattern reviewers already followed at least 3 times, with no contradictions." |
| 0:30 | Optional: click **Show Cedar** on that card, then **Hide Cedar**. | "This is the actual Cedar that runs in the database. The sentence is read straight from its when-clauses." |
| 0:40 | Scroll up and click **Promote v6 to the active Cedar policy**. | The counter counts down **3,387 → 1,642**, the dashed line turns solid, **v6 Current** and v4 Retired appear in the sidebar, and the badge and every rule turn **Promoted / Active**. "A human promoted it. The AI can't." |
| 0:55 | Open **Break It**. | The banner reads *14 held attacks cleared by promoting v6*. The bars show Before v4 **31 caught / 41 held** and After **44 caught / 27 held / 1 missed**. "The same attacks, re-decided under the new policy." |
| 1:10 | Optional v7 (below). | |

### Continuing to v7 (the existing Break It talk track)

1. Still on Break It, click **Run all 72**. The promotion left a v6 clearance on the current run, and that clearance hides the *Review …* button. A fresh run gives the same v6 numbers and brings the button back.
2. Click **Review …**, rule **partial** with *Space weather vs exclusion* and *Share of contact lost* marked decisive, and save. That proposes **v7** on top of v6.
3. Click **Promote v7 and re-decide the held attacks**. Locally this cleared 25 of 26 held attacks: **68 caught / 1 held / 3 missed**.

The Approvals path works too: approve **CLM-20002** and then **CLM-20003** ($1,750 each, with *Space weather vs exclusion*, *Share of contact lost* and *Data integrity* marked decisive). The first gives 2 of 3 consistent rulings and no rule. The second proposes v7.

### Order matters

- **Promote v6 before any ruling that could create a rule.** A new rule is built on whichever version is active. With v4 active, a ruling on CLM-20003 or on a Break It attack would propose a v7 equal to v4 plus one rule, and promoting that v7 would drop v6's seven rules. The v6 panel says this next to the Promote button.
- **Leave CLM-20004 and CLM-20008 alone.** Their patterns are already v6 rules (`v6-learned-7`, `v6-learned-6`), so ruling on them proposes a v7 that duplicates an existing rule.

## Resetting between takes or judges

| Path | Time | What it resets |
|---|---|---|
| **Rewind:** `spacetime call ground-truth-aamir rewind_to_mined_proposal --server maincloud` | about 1 s | Makes v4 current and v6 and its rules proposed. Deletes every version after v6 (learned v7+, and any made with *New version*). Reruns Break It under v4. |
| **Full reseed:** `STAGE_MINED_POLICY=1 server/reseed.sh ground-truth-aamir maincloud --yes` | 4–8 min on Maincloud | Everything |

The rewind keeps the labeled decisions, decided claims, ledger, KPIs and the miner's log. After a rewind:

- **Repeatable:** the Promote v6 take, and the Break It v7 path (Run all 72 → Review → Promote v7). Tested locally: rewind → promote v6 → Run all → one partial ruling → v7 → 68 / 1 / 3.
- **Not repeatable:** the CLM-20002 → CLM-20003 Approvals path, because those claims are already decided. Do a full reseed for that.
- The miner's log on *History* still lists the deleted v7 under its old trigger, and a claim filed under the old v7 (e.g. CLM-20009) keeps its `v7-learned-1` citation.

`rewind_to_mined_proposal` fails without changing anything if there is no history-mined proposal. Like `promote_policy_version`, any connected client can call it, so use it only on demo databases.

To return to the default state (v6 current from the start, CLM-20004/20008 auto-decided), reseed without `STAGE_MINED_POLICY`.
