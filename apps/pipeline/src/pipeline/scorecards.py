"""Compute conservative v1 scorecards and release gates."""

from math import ceil, floor


THRESHOLDS = {
    "quality": 0.90,
    "recommendation_precision": 0.95,
    "safe_opportunity_recall": 0.80,
    "required_abstention": 1.0,
    "coverage": 1.0,
    "speed_median_improvement": 0.10,
    "speed_p95_regression": 0.20,
    "cost": 0.0,
}
MIN_REVIEW_CASES = 10


def _percentile(values, quantile):
    values = sorted(values)
    if not values:
        return None
    position = (len(values) - 1) * quantile
    lower = floor(position)
    upper = ceil(position)
    if lower == upper:
        return round(values[lower], 3)
    weight = position - lower
    return round(values[lower] + (values[upper] - values[lower]) * weight, 3)


def _metric(value, numerator, denominator, threshold, status, evidence_refs, details=None):
    return {
        "value": value,
        "numerator": numerator,
        "denominator": denominator,
        "threshold": threshold,
        "status": status,
        "evidence_refs": sorted(set(evidence_refs)),
        "details": details or {},
    }


def _ratio_metric(numerator, denominator, threshold, evidence_refs, details=None):
    if not denominator:
        return _metric(
            None, numerator, denominator, threshold, "unavailable", evidence_refs, details
        )
    value = numerator / denominator
    status = (
        "review" if denominator < MIN_REVIEW_CASES else "pass" if value >= threshold else "fail"
    )
    return _metric(value, numerator, denominator, threshold, status, evidence_refs, details)


def _references(verdicts):
    return [reference for verdict in verdicts for reference in verdict["evidence_refs"]]


def _quality_scorecard(cases, verdicts):
    case_by_id = {case["case_id"]: case for case in cases}
    eligible = [
        verdict
        for verdict in verdicts
        if case_by_id[verdict["case_id"]]["risk"] == "normal"
        and verdict["terminal_verdict"] in {"pass", "fail"}
    ]
    passed = sum(verdict["terminal_verdict"] == "pass" for verdict in eligible)
    overall = _ratio_metric(
        passed,
        len(eligible),
        THRESHOLDS["quality"],
        _references(eligible),
        {"eligible_case_count": len(eligible)},
    )
    by_family = {}
    for family in sorted({case["pipeline_family"] for case in cases}):
        family_verdicts = [
            verdict
            for verdict in eligible
            if case_by_id[verdict["case_id"]]["pipeline_family"] == family
        ]
        family_passed = sum(verdict["terminal_verdict"] == "pass" for verdict in family_verdicts)
        by_family[family] = _ratio_metric(
            family_passed,
            len(family_verdicts),
            THRESHOLDS["quality"],
            _references(family_verdicts),
            {"eligible_case_count": len(family_verdicts)},
        )
    return {"overall": overall, "by_family": by_family}


def _label_scorecards(cases, verdicts):
    case_by_id = {case["case_id"]: case for case in cases}
    labeled = [
        (case_by_id[verdict["case_id"]], verdict)
        for verdict in verdicts
        if case_by_id[verdict["case_id"]].get("labels", {}).get("recommendation")
        in {"safe", "unsafe"}
    ]
    predicted = [
        (case, verdict) for case, verdict in labeled if verdict["terminal_verdict"] == "pass"
    ]
    true_positive = sum(case["labels"]["recommendation"] == "safe" for case, _ in predicted)
    safe_opportunities = sum(case["labels"]["recommendation"] == "safe" for case, _ in labeled)
    refs = _references([verdict for _, verdict in labeled])
    precision = _ratio_metric(
        true_positive,
        len(predicted),
        THRESHOLDS["recommendation_precision"],
        refs,
        {"labeled_case_count": len(labeled)},
    )
    recall = _ratio_metric(
        true_positive,
        safe_opportunities,
        THRESHOLDS["safe_opportunity_recall"],
        refs,
        {"labeled_case_count": len(labeled)},
    )
    return precision, recall


def _abstention_scorecard(cases, verdicts):
    case_by_id = {case["case_id"]: case for case in cases}
    required = [
        verdict
        for verdict in verdicts
        if case_by_id[verdict["case_id"]]["risk"] == "high"
        or case_by_id[verdict["case_id"]]["required_evidence"] == "abstain"
        or case_by_id[verdict["case_id"]].get("labels", {}).get("required_abstention", False)
    ]
    caught = sum(verdict["terminal_verdict"] == "abstain" for verdict in required)
    return _ratio_metric(
        caught,
        len(required),
        THRESHOLDS["required_abstention"],
        _references(required),
        {"required_case_count": len(required)},
    )


def _coverage_scorecard(verdicts):
    covered = sum(bool(verdict["evidence_refs"]) for verdict in verdicts)
    return _ratio_metric(
        covered,
        len(verdicts),
        THRESHOLDS["coverage"],
        _references(verdicts),
        {"abstain_count": sum(verdict["terminal_verdict"] == "abstain" for verdict in verdicts)},
    )


def _speed_scorecard(cases, candidate_bundle):
    case_ids = {case["case_id"] for case in cases}
    paired = [
        result
        for result in candidate_bundle["results"]
        if result["case_id"] in case_ids
        and result.get("duration_ms") is not None
        and result.get("baseline_duration_ms") is not None
        and result["baseline_duration_ms"] > 0
    ]
    missing = len(case_ids) - len(paired)
    candidate_times = [result["duration_ms"] for result in paired]
    baseline_times = [result["baseline_duration_ms"] for result in paired]
    candidate_p50 = _percentile(candidate_times, 0.50)
    candidate_p95 = _percentile(candidate_times, 0.95)
    baseline_p50 = _percentile(baseline_times, 0.50)
    baseline_p95 = _percentile(baseline_times, 0.95)
    median_improvement = (
        round((baseline_p50 - candidate_p50) / baseline_p50, 6) if baseline_p50 else None
    )
    p95_regression = (
        round((candidate_p95 - baseline_p95) / baseline_p95, 6) if baseline_p95 else None
    )
    details = {
        "paired_case_count": len(paired),
        "missing_case_count": missing,
        "candidate_p50_ms": candidate_p50,
        "candidate_p95_ms": candidate_p95,
        "baseline_p50_ms": baseline_p50,
        "baseline_p95_ms": baseline_p95,
        "median_improvement_pct": median_improvement,
        "p95_regression_pct": p95_regression,
    }
    refs = [reference for result in paired for reference in result.get("evidence_refs", [])]
    if missing or not paired or median_improvement is None or p95_regression is None:
        return _metric(
            median_improvement,
            len(paired),
            len(case_ids),
            THRESHOLDS["speed_median_improvement"],
            "unavailable",
            refs,
            details,
        )
    status = "fail" if p95_regression > THRESHOLDS["speed_p95_regression"] else "pass"
    return _metric(
        median_improvement,
        len(paired),
        len(case_ids),
        THRESHOLDS["speed_median_improvement"],
        status,
        refs,
        details,
    )


def _confidence_scorecard(quality):
    overall = quality["overall"]
    sample_count = overall["denominator"]
    pass_rate = overall["value"]
    if not sample_count:
        level = "abstain"
        status = "unavailable"
    elif sample_count >= 20 and pass_rate >= 0.95:
        level = "high"
        status = "pass"
    elif sample_count >= 10 and pass_rate >= 0.90:
        level = "medium"
        status = "pass"
    else:
        level = "low"
        status = "review"
    return {
        "level": level,
        "status": status,
        "sample_count": sample_count,
        "pass_rate": pass_rate,
        "evidence_refs": overall["evidence_refs"],
    }


def _gate(gate_id, status, threshold, observed, evidence_refs, detail):
    return {
        "id": gate_id,
        "status": status,
        "threshold": threshold,
        "observed": observed,
        "evidence_refs": sorted(set(evidence_refs)),
        "detail": detail,
    }


def _overall_status(gates):
    statuses = {gate["status"] for gate in gates}
    if "fail" in statuses:
        return "fail"
    if "review" in statuses:
        return "review"
    if "unavailable" in statuses:
        return "review"
    return "pass"


def _faster_claim_status(speed):
    if speed["status"] == "unavailable":
        return "unavailable"
    details = speed["details"]
    if (
        details["median_improvement_pct"] >= THRESHOLDS["speed_median_improvement"]
        and details["p95_regression_pct"] <= 0
    ):
        return "pass"
    return "review"


def compute_scorecards(corpus, candidate_bundle, verdicts):
    quality = _quality_scorecard(corpus["cases"], verdicts)
    precision, recall = _label_scorecards(corpus["cases"], verdicts)
    abstention = _abstention_scorecard(corpus["cases"], verdicts)
    coverage = _coverage_scorecard(verdicts)
    speed = _speed_scorecard(corpus["cases"], candidate_bundle)
    faster_claim_status = _faster_claim_status(speed)
    confidence = _confidence_scorecard(quality)
    case_by_id = {case["case_id"]: case for case in corpus["cases"]}
    unsafe_recommendations = [
        verdict
        for verdict in verdicts
        if verdict["terminal_verdict"] == "pass"
        and (
            case_by_id[verdict["case_id"]]["risk"] == "high"
            or case_by_id[verdict["case_id"]].get("labels", {}).get("recommendation") == "unsafe"
        )
    ]
    unsafe_refs = _references(unsafe_recommendations)
    safety_status = "pass" if not unsafe_recommendations else "fail"
    safety = _metric(
        len(unsafe_recommendations),
        0,
        len(verdicts),
        0,
        safety_status,
        unsafe_refs,
        {"unsafe_recommendation_count": len(unsafe_recommendations)},
    )
    remediation = _metric(
        None,
        0,
        0,
        1.0,
        "unavailable",
        [],
        {"reason": "remediation proof is not part of benchmark snapshots yet"},
    )
    cost_value = candidate_bundle.get("evaluation_cost_usd", 0)
    cost = _metric(
        cost_value,
        1 if cost_value == 0 else 0,
        1,
        THRESHOLDS["cost"],
        "pass" if cost_value == 0 else "fail",
        _references(verdicts),
        {"candidate_cost_usd": sum(verdict["cost_usd"] for verdict in verdicts)},
    )
    scorecards = {
        "safety": safety,
        "quality": quality,
        "recommendation_precision": precision,
        "safe_opportunity_recall": recall,
        "required_abstention": abstention,
        "coverage": coverage,
        "speed": speed,
        "confidence": confidence,
        "remediation": remediation,
        "cost": cost,
    }
    gates = [
        _gate(
            "zero-unsafe-substitutions",
            safety["status"],
            safety["threshold"],
            safety["value"],
            safety["evidence_refs"],
            "No high-risk or frozen-unsafe case may produce a passing recommendation.",
        ),
        _gate(
            "quality",
            quality["overall"]["status"],
            quality["overall"]["threshold"],
            quality["overall"]["value"],
            quality["overall"]["evidence_refs"],
            "Normal-risk pass rate must meet the v1 quality floor with at least ten eligible cases.",
        ),
        _gate(
            "recommendation-precision",
            precision["status"],
            precision["threshold"],
            precision["value"],
            precision["evidence_refs"],
            "Precision is unavailable without frozen safe or unsafe recommendation labels.",
        ),
        _gate(
            "safe-opportunity-recall",
            recall["status"],
            recall["threshold"],
            recall["value"],
            recall["evidence_refs"],
            "Recall counts abstentions as missed safe opportunities.",
        ),
        _gate(
            "required-abstention",
            abstention["status"],
            abstention["threshold"],
            abstention["value"],
            abstention["evidence_refs"],
            "Every high-risk or explicitly abstention-required case must abstain.",
        ),
        _gate(
            "evidence-coverage",
            coverage["status"],
            coverage["threshold"],
            coverage["value"],
            coverage["evidence_refs"],
            "Every terminal verdict must retain evidence provenance.",
        ),
        _gate(
            "speed",
            speed["status"],
            THRESHOLDS["speed_p95_regression"],
            speed["details"]["p95_regression_pct"],
            speed["evidence_refs"],
            "Paired p95 wall time may not regress by more than twenty percent.",
        ),
        _gate(
            "faster-speed-claim",
            faster_claim_status,
            THRESHOLDS["speed_median_improvement"],
            speed["value"],
            speed["evidence_refs"],
            "A faster claim requires at least ten percent paired median improvement and no p95 regression.",
        ),
        _gate(
            "confidence",
            confidence["status"],
            None,
            None,
            confidence["evidence_refs"],
            f"Confidence level is {confidence['level']}.",
        ),
        _gate(
            "remediation-proof",
            remediation["status"],
            remediation["threshold"],
            remediation["value"],
            remediation["evidence_refs"],
            remediation["details"]["reason"],
        ),
        _gate(
            "offline-cost",
            cost["status"],
            cost["threshold"],
            cost["value"],
            cost["evidence_refs"],
            "Imported benchmark evaluation must spend zero external evaluator cost.",
        ),
    ]
    replay = candidate_bundle.get("replay")
    if replay and replay["status"] == "budget_exhausted":
        gates.append(
            _gate(
                "replay-budget",
                "fail",
                replay["max_cost_usd"],
                replay["actual_cost_usd"],
                _references(verdicts),
                "Budget exhaustion creates a partial snapshot that cannot pass a release gate.",
            )
        )
    elif replay and replay["status"] == "failed":
        gates.append(
            _gate(
                "replay-budget",
                "fail",
                replay["max_cost_usd"],
                replay["actual_cost_usd"],
                _references(verdicts),
                "Replay failed before producing a complete candidate bundle.",
            )
        )
    required_gates = [gate for gate in gates if gate["id"] != "remediation-proof"]
    gates.append(
        _gate(
            "standard-benchmark",
            _overall_status(required_gates),
            None,
            None,
            [reference for gate in required_gates for reference in gate["evidence_refs"]],
            "Overall imported benchmark release status; unavailable evidence becomes review.",
        )
    )
    return scorecards, gates
