"""
Map calibrated failure scores to the Rust confidence gate.

`confidence_gate::determine_route` auto-decides at confidence >= 95 (and
amount <= $300), sends 80-94 to human approval and escalates below 80. The
model therefore reports, as `confidence_percent`, the precision measured on
held-out stations for the strictest operating point the pass clears. A
"failed" call is auto-decided only when that measured precision is >= 95%.
Everything else, including every "pass was fine" call, goes to a human.
"""

from typing import Dict, List, Optional

AUTO_CONFIDENCE = 95
HUMAN_APPROVAL_CONFIDENCE = 80


def build_gate(operating_points: List[Dict], auto_precision: float = 0.95) -> Dict:
    """`operating_points`: [{"target", "threshold", "heldout_precision", ...}].

    The auto threshold is the lowest threshold whose *measured* held-out
    precision reaches `auto_precision` (not the nominal target, which nested
    evaluation showed is usually missed by 0.5-1.5 points).
    """
    pts = sorted([p for p in operating_points if p.get("threshold") is not None],
                 key=lambda p: p["threshold"])
    auto = [p for p in pts if (p.get("heldout_precision") or 0) >= auto_precision]
    return {
        "auto_precision": auto_precision,
        "operating_points": pts,
        "auto_threshold": auto[0]["threshold"] if auto else None,
    }


def gate_decision(prob: float, gate: Optional[Dict]) -> Dict:
    if not gate:
        return {"confidence_percent": min(int(prob * 100), AUTO_CONFIDENCE - 1),
                "route": "human", "operating_point": None}
    cleared = [p for p in gate["operating_points"] if prob >= p["threshold"]]
    if not cleared:
        return {"confidence_percent": min(int(prob * 100), HUMAN_APPROVAL_CONFIDENCE - 1),
                "route": "human", "operating_point": None}
    best = max(cleared, key=lambda p: p["threshold"])
    confidence = int((best.get("heldout_precision") or 0) * 100)
    auto = gate["auto_threshold"] is not None and prob >= gate["auto_threshold"]
    confidence = max(confidence, AUTO_CONFIDENCE) if auto else min(confidence, AUTO_CONFIDENCE - 1)
    return {"confidence_percent": confidence, "route": "auto" if auto else "human",
            "operating_point": best["target"]}
