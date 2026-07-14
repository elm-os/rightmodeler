"""Evaluate imported tool trajectories with deterministic comparisons."""

from pipeline.snapshot import build_snapshot, match_candidate_results


def _status(matches):
    return "pass" if matches else "fail"


def _call_ids(trajectory):
    return [call["call_id"] for call in trajectory["tool_calls"]]


def _tool_names(trajectory):
    return [call["tool_name"] for call in trajectory["tool_calls"]]


def _arguments(trajectory):
    return [call["arguments"] for call in trajectory["tool_calls"]]


def _retry_signature(trajectory):
    return [(call["attempt"], call["status"]) for call in trajectory["tool_calls"]]


def _loop_signature(trajectory):
    return [
        (call.get("loop_id"), call.get("iteration"))
        for call in trajectory["tool_calls"]
        if "loop_id" in call or "iteration" in call
    ]


def _recovery_signature(trajectory):
    calls = trajectory["tool_calls"]
    return [
        (call["tool_name"], call["attempt"], next_call["attempt"])
        for index, call in enumerate(calls)
        if call["status"] == "error"
        for next_call in calls[index + 1 :]
        if next_call["tool_name"] == call["tool_name"]
        and next_call["status"] == "success"
        and next_call["attempt"] > call["attempt"]
    ]


def _optional_status(candidate_signature, reference_signature):
    if not candidate_signature and not reference_signature:
        return "not_applicable"
    return _status(candidate_signature == reference_signature)


def _risk_flags(trajectory):
    calls = trajectory["tool_calls"]
    flags = []
    if len(calls) > 1:
        flags.append("downstream")
    if _loop_signature(trajectory):
        flags.append("loop")
    if _recovery_signature(trajectory):
        flags.append("recovery")
    return sorted(flags)


def _trajectory_comparison(case, result, candidate_trajectory, reference_trajectory):
    candidate_output_matches_trajectory = (
        result["output_text"] == candidate_trajectory["final_output"]
    )
    checks = {
        "tool_name": _status(
            _tool_names(candidate_trajectory) == _tool_names(reference_trajectory)
        ),
        "arguments": _status(_arguments(candidate_trajectory) == _arguments(reference_trajectory)),
        "ordering": _status(_call_ids(candidate_trajectory) == _call_ids(reference_trajectory)),
        "retries": _status(
            _retry_signature(candidate_trajectory) == _retry_signature(reference_trajectory)
        ),
        "loops": _optional_status(
            _loop_signature(candidate_trajectory), _loop_signature(reference_trajectory)
        ),
        "recovery": _optional_status(
            _recovery_signature(candidate_trajectory), _recovery_signature(reference_trajectory)
        ),
        "terminal_state": _status(
            candidate_trajectory["terminal_state"] == reference_trajectory["terminal_state"]
        ),
        "final_output": _status(
            candidate_output_matches_trajectory
            and candidate_trajectory["final_output"] == reference_trajectory["final_output"]
        ),
    }
    trajectory_evidence = {**checks, "risk_flags": _risk_flags(candidate_trajectory)}
    failed_checks = [name for name, status in checks.items() if status == "fail"]
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "fail" if failed_checks else "pass",
        "evidence_type": "trajectory",
        "evaluator": "tool-trajectory",
        "checks": [],
        "failure_code": "trajectory_mismatch" if failed_checks else None,
        "abstention_reason": None,
        "timing": {
            "availability": "available" if result.get("duration_ms") is not None else "unavailable",
            "duration_ms": result.get("duration_ms"),
        },
        "cost_usd": result["cost_usd"],
        "evidence_refs": sorted(
            set(result.get("evidence_refs", [])) | set(result["reference"].get("refs", []))
        ),
        "trajectory": trajectory_evidence,
        "reference": result["reference"],
    }


def _abstention(case, result, reason):
    reference = result.get("reference")
    reference_refs = reference.get("refs", []) if reference else []
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "abstain",
        "evidence_type": "abstain",
        "evaluator": "abstain",
        "checks": [],
        "failure_code": None,
        "abstention_reason": reason,
        "timing": {
            "availability": "available" if result.get("duration_ms") is not None else "unavailable",
            "duration_ms": result.get("duration_ms"),
        },
        "cost_usd": result["cost_usd"],
        "evidence_refs": sorted(set(result.get("evidence_refs", [])) | set(reference_refs)),
        "trajectory": None,
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
        "trajectory": None,
        "reference": None,
    }


def evaluate_tool_trajectories(corpus, candidate_bundle):
    cases, results_by_case = match_candidate_results(corpus, candidate_bundle, "tool-trajectory")
    if any(case["required_evidence"] not in {"trajectory", "abstain"} for case in cases):
        raise ValueError("tool evaluation requires trajectory or abstain evidence")

    verdicts = []
    for case in cases:
        result = results_by_case.get(case["case_id"])
        if result is None:
            verdicts.append(_missing_result(case))
            continue
        if case["risk"] == "high":
            verdicts.append(_abstention(case, result, "high_risk_case"))
            continue
        if case["required_evidence"] == "abstain":
            verdicts.append(_abstention(case, result, "case_requires_abstention"))
            continue
        reference = result.get("reference")
        if reference is None or reference["type"] != "reference-trajectory":
            verdicts.append(_abstention(case, result, "missing_reference_trajectory"))
            continue
        candidate_trajectory = result.get("trajectory")
        if candidate_trajectory is None:
            verdicts.append(_abstention(case, result, "missing_candidate_trajectory"))
            continue
        verdicts.append(
            _trajectory_comparison(
                case,
                result,
                candidate_trajectory,
                reference["trajectory"],
            )
        )
    return build_snapshot(corpus, candidate_bundle, verdicts)
