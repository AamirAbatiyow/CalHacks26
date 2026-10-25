# Demo: self-learning policy from a human decision

[← README](../README.md)

The staged seed loads six months of human rulings as labeled data and stops there: **v4 is current and no mined proposal exists yet** (v5's threshold-lowering proposal stays blocked). One human ruling on camera becomes the trigger that mines the full history and proposes v6.

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
# v4 current, v5 proposed (blocked by replay), no v6
```

What changes in staged mode, and nothing else:

- History labels are seeded (6 months of `audit_decision` rows) but no policy is mined from them.
- v5 and its threshold replay are present and blocked.
- Incoming claims are decided under v4, so **CLM-20002, CLM-20003, CLM-20004 and others wait in Approvals** (escalated, not auto-decided).
- Break It's first run is decided under v4, so its Before and After bars match (v4 / v4).

## The tip claim: CLM-20003

**Claim:** Aether Dynamics filed for their full pass fee. A geomagnetic storm (Kp just under the contract's 7.0 exclusion) knocked out 95% of the downlink.

**Decision to enter on camera:**

| Field | Value |
|---|---|
| Outcome | **approve** |
| Credit | The contract credit shown on the claim (the full pass fee) |
| Decisive evidence | **Space weather vs exclusion**, **Share of contact lost**, **Data integrity** |

The history already contains two near-threshold full-loss approvals with the same decisive marks. CLM-20003 is the third consistent ruling, which pushes the pattern to the 3-decision support threshold. Because no mined proposal exists yet, `learn_from_decision` mines every escalated label in the history and proposes the **full rule package** as v6.

CLM-20002 (Polar Data Systems, near-threshold, 100% loss) also works as the tip — the same pattern and the same result.

## The 60–90 second take

Figures below come from a local staged seed. Maincloud figures differ by a few cases from run to run because the pass history is regenerated from the current time.

| Time | Do | Show / say |
|---|---|---|
| 0:00 | Open **Approvals**. Click **CLM-20003** (Aether Dynamics). | "One more real claim to decide." |
| 0:10 | Select **approve**, enter the contract credit, check **Space weather vs exclusion**, **Share of contact lost**, and **Data integrity** as decisive. Click **Submit**. | "We just told the system: this storm was real, the data backs it up, pay the customer." |
| 0:20 | Open **Policies** (sidebar, or `#/policies`). | v6 has appeared — *Learned from CLM-20003*. The counter says roughly **3,400 escalations under v4** and a dashed line shows v6 at roughly **1,660** (≈ 50% fewer; precision up, 0 regressions). "One ruling triggered a full review of every past decision. Six months of history, 8 consistent patterns, zero contradictions." |
| 0:35 | Scroll to **What v6 enforces**. | Read one card aloud, e.g. *IF Partial downlink and Maintenance: short notice and Space weather: clear and Integrity: passed → APPROVE. N past rulings agree · 0 disagree.* "Every rule is a pattern reviewers already followed." |
| 0:45 | Scroll up and click **Promote v6 to the active Cedar policy**. | The counter counts down, the dashed line turns solid, **v6 Current** and v4 Retired appear in the sidebar. "A human promoted it. The AI can't." |
| 1:00 | Open **Break It**. | The bars show Before v4 vs After v6. Held attacks were cleared by promoting v6. "The same attacks, re-decided under the new policy." |

## Order matters

- **Decide the tip claim before any other ruling that could create a rule.** The first ruling whose pattern reaches the support threshold triggers the full mine. Deciding a different escalated claim first may produce a smaller v6 or a v6 from a different trigger; the full history-mined package still appears, but the trigger label on the Policies page would differ.
- **Do not promote v6 before deciding the tip.** Without the tip ruling, there is no v6 to promote.

## Resetting between takes or judges

| Path | Time | What it resets |
|---|---|---|
| **Rewind:** `spacetime call ground-truth-aamir rewind_demo --server maincloud` | about 1 s | Deletes v6 and later, restores the tip claim to Pending in Approvals, makes v4 current again. Reruns Break It under v4. |
| **Full reseed:** `STAGE_MINED_POLICY=1 server/reseed.sh ground-truth-aamir maincloud --yes` | 4–8 min on Maincloud | Everything |

After a `rewind_demo`:

- **Repeatable:** the full take — decide the tip → v6 appears → promote → Break It.
- **Not repeatable** without a full reseed: the Break It v7 path (decide a held attack → promote v7), because the held attacks may have been cleared.
- The audit decision and its ledger/decision-record entries from the previous take are deleted. The miner's log on *History* is clean.

`rewind_demo` fails without changing anything if there is no version after v5. Like `promote_policy_version`, any connected client can call it, so use it only on demo databases.

To return to the default state (v6 current from the start, CLM-20004/20008 auto-decided), reseed without `STAGE_MINED_POLICY`.

## Legacy flow

The previous demo started with v6 already proposed from history mining:

```bash
# Old staged seed (v6 proposed from history, not from a human decision)
# No longer the default. Documented here for reference.
# seed_learning_history_staged used to call create_proposal for all mined patterns.
```

`rewind_to_mined_proposal` still works for databases seeded with the old flow (it looks for a `history_mining` origin proposal). For the new flow, use `rewind_demo`.
