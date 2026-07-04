"""Offline deterministic evaluator.

Runs deterministic checks on the FINAL OUTPUT already present in a historical
run bundle and emits recommendation objects in the PRD section 11 shape. This
path is fully OFFLINE and deterministic: it performs no network calls. The
OpenRouter-backed replay path that would select a concrete cheaper model is
DESIGN ONLY and is specified in docs/eval-engine-spike.md.
"""

import json
from collections import Counter
from datetime import UTC, datetime

# Confidence thresholds: deterministic and uncalibrated. DIR-04 will calibrate.
HIGH_MIN_RUNS = 5
MED_MIN_RUNS = 3


def _is_structured_output(text):
    """True when text parses as a JSON object or array."""
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return False
    return isinstance(parsed, (dict, list))


def _family_recommendation(label, runs):
    outputs = [(run.get("final_output") or "") for run in runs]
    non_empty = [text for text in outputs if text.strip()]
    structured = [text for text in non_empty if _is_structured_output(text)]
    run_count = len(runs)
    current_model = Counter(run["model"] for run in runs).most_common(1)[0][0]

    if structured:
        checks = ["valid_json", "non_empty_output"]
        pass_rate = len(structured) / run_count
        evidence_type = "deterministic"
        if pass_rate == 1.0 and run_count >= HIGH_MIN_RUNS:
            confidence = "high"
        elif pass_rate >= 0.9 and run_count >= MED_MIN_RUNS:
            confidence = "medium"
        else:
            confidence = "low"
    elif non_empty:
        checks = ["non_empty_output"]
        pass_rate = len(non_empty) / run_count
        evidence_type = "none"
        confidence = "abstain"
    else:
        checks = []
        pass_rate = 0.0
        evidence_type = "none"
        confidence = "abstain"

    if confidence == "abstain":
        risks = [
            "Deterministic checks do not apply to this task family "
            "(non-structured or empty output); evidence is insufficient for a "
            "substitution.",
        ]
        rollout_plan = (
            "No substitution recommended until reference-based or calibrated "
            "LLM-judge evidence exists (see docs/eval-engine-spike.md)."
        )
    else:
        risks = [
            "No candidate cheaper model has been replayed yet; this certifies "
            "only that the family is deterministically gate-able, not that a "
            "specific cheaper model passes.",
        ]
        if confidence == "low":
            risks.append("Sample size or pass rate is low; treat as weak evidence.")
        rollout_plan = (
            "Run the OpenRouter replay in docs/eval-engine-spike.md to select a "
            "candidate model, then gate the swap in CI on: " + ", ".join(checks) + "."
        )

    return {
        "task_family": label,
        "current_model": current_model,
        "recommended_model": None,
        "estimated_cost_reduction_pct": 0.0,
        "quality_score": pass_rate,
        "confidence": confidence,
        "evidence_type": evidence_type,
        "examples_evaluated": run_count,
        "risks": risks,
        "rollout_plan": rollout_plan,
    }


def build_recommendations(bundle):
    from pipeline.__main__ import infer_task_family

    grouped = {}
    for run in bundle["runs"]:
        grouped.setdefault(infer_task_family(run), []).append(run)
    return [_family_recommendation(label, runs) for label, runs in sorted(grouped.items())]


def evaluate(input_path, output_path):
    from pipeline.__main__ import load_json, validate_schema, write_json

    bundle = validate_schema(load_json(input_path), "historical-run-bundle")
    recommendations = build_recommendations(bundle)
    risk_flags = [
        "Offline deterministic evaluator only: no candidate models were "
        "replayed, so recommended_model is null for every recommendation. "
        "Reference-based and LLM-judge evaluators plus OpenRouter replay are "
        "designed in docs/eval-engine-spike.md but not executed here.",
    ]

    # Self-check: the assembled report must satisfy the recommendation-report
    # schema (top-level envelope). Mirror report()'s shape; raise on mismatch.
    # Item fields are code-guaranteed and asserted by tests/test_evaluate.py.
    preview = {
        "version": "1",
        "generated_at": datetime.now(UTC).isoformat(),
        "summary": {
            "task_family_count": len(recommendations),
            "evaluated_run_count": len(bundle["runs"]),
            "estimated_savings_usd": 0,
        },
        "recommendations": recommendations,
        "task_families": [],
        "risk_flags": risk_flags,
    }
    validate_schema(preview, "recommendation-report")

    evaluation = {
        "version": "1",
        "bundle_id": bundle["bundle_id"],
        "recommendations": recommendations,
        "risk_flags": risk_flags,
    }
    return write_json(output_path, evaluation)
