"""Evaluate imported freeform results using only explicit reference evidence."""

from pipeline.snapshot import build_snapshot, match_candidate_results


def _check(name, status, detail=None):
    result = {"name": name, "status": status}
    if detail:
        result["detail"] = detail
    return result


def _evaluate_result(case, result):
    reference = result.get("reference")
    reference_refs = reference.get("refs", []) if reference else []
    evidence_refs = sorted(set(result.get("evidence_refs", []) + reference_refs))
    duration_ms = result.get("duration_ms")
    checks = []
    failure_code = None
    abstention_reason = None
    evidence_type = "abstain"
    evaluator = "abstain"

    if case["risk"] == "high":
        terminal_verdict = "abstain"
        abstention_reason = "high_risk_case"
    elif case["required_evidence"] == "abstain":
        terminal_verdict = "abstain"
        abstention_reason = "case_requires_abstention"
    elif reference is None:
        terminal_verdict = "abstain"
        abstention_reason = "missing_reference_evidence"
    elif reference["type"] == "reference-evidence":
        terminal_verdict = "abstain"
        evidence_type = "reference-evidence"
        checks.append(
            _check(
                "semantic_comparison",
                "not_applicable",
                "reference evidence is not calibrated for semantic comparison",
            )
        )
        abstention_reason = "uncalibrated_reference_evidence"
    else:
        evidence_type = "frozen-human-verdict"
        evaluator = "frozen-human-verdict"
        if reference["agreement"] == "disputed" or reference["verdict"] is None:
            terminal_verdict = "abstain"
            checks.append(
                _check(
                    "frozen_human_verdict",
                    "not_applicable",
                    "reviewers did not provide one agreed verdict",
                )
            )
            abstention_reason = "reference_disagreement"
            evaluator = "abstain"
        else:
            terminal_verdict = reference["verdict"]
            checks.append(
                _check(
                    "frozen_human_verdict",
                    "pass" if terminal_verdict == "pass" else "fail",
                )
            )
            if terminal_verdict == "fail":
                failure_code = "frozen_human_verdict_fail"

    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": terminal_verdict,
        "evidence_type": evidence_type,
        "evaluator": evaluator,
        "checks": checks,
        "failure_code": failure_code,
        "abstention_reason": abstention_reason,
        "timing": {
            "availability": "available" if duration_ms is not None else "unavailable",
            "duration_ms": duration_ms,
        },
        "cost_usd": result["cost_usd"],
        "evidence_refs": evidence_refs,
        "reference": reference,
    }


def _missing_result(case):
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "abstain",
        "evidence_type": "abstain",
        "evaluator": "abstain",
        "checks": [],
        "failure_code": None,
        "abstention_reason": "missing_candidate_result",
        "timing": {"availability": "unavailable", "duration_ms": None},
        "cost_usd": 0,
        "evidence_refs": [],
        "reference": None,
    }


def evaluate_freeform_candidates(corpus, candidate_bundle):
    cases, results_by_case = match_candidate_results(corpus, candidate_bundle, "reference-freeform")
    if any(case["required_evidence"] not in {"reference", "abstain"} for case in cases):
        raise ValueError("freeform evaluation requires reference or abstain evidence")

    verdicts = [
        _evaluate_result(case, results_by_case[case["case_id"]])
        if case["case_id"] in results_by_case
        else _missing_result(case)
        for case in cases
    ]
    return build_snapshot(corpus, candidate_bundle, verdicts)
