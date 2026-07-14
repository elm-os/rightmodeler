"""Classify benchmark failures and assemble immutable remediation evidence."""

from pipeline.corpus import content_digest


ISSUE_ACTIONS = {
    "ingestion": "fix-ingestion",
    "evaluator": "fix-evaluator",
    "replay": "fix-replay",
    "candidate-selection": "adjust-selection",
    "repo-validation": "fix-repo-validation",
    "insufficient-evidence": "collect-evidence",
}

EVALUATOR_FAILURES = {
    "invalid_json",
    "schema_mismatch",
    "missing_required_fields",
    "frozen_human_verdict_fail",
    "reference_disagreement",
    "trajectory_mismatch",
}

SELECTION_GATES = {
    "zero-unsafe-substitutions",
    "recommendation-precision",
    "safe-opportunity-recall",
}


def _gate_map(snapshot):
    return {gate["id"]: gate for gate in snapshot["gates"]}


def _failed_or_weak_gates(snapshot):
    return [
        gate for gate in snapshot["gates"] if gate["status"] in {"fail", "review", "unavailable"}
    ]


def _case_failure_codes(snapshot):
    return {
        verdict["case_id"]: verdict.get("failure_code")
        for verdict in snapshot["case_verdicts"]
        if verdict.get("failure_code")
    }


def _classify(snapshot):
    gates = _gate_map(snapshot)
    failure_codes = _case_failure_codes(snapshot)
    codes = set(failure_codes.values())

    if any(code.startswith("ingestion_") for code in codes):
        return "ingestion"
    replay = snapshot.get("replay")
    if "replay-budget" in gates or replay:
        return "replay"
    if any(code.startswith("replay_") for code in codes):
        return "replay"
    if any(
        verdict["pipeline_family"] == "repo-fix"
        for verdict in snapshot["case_verdicts"]
        if verdict["terminal_verdict"] == "fail"
    ) or any(gate_id.startswith("repo-") for gate_id in gates):
        return "repo-validation"
    if codes & EVALUATOR_FAILURES:
        return "evaluator"
    if codes & {"missing_candidate_result", "missing_evidence"}:
        return "insufficient-evidence"
    if any(gates.get(gate_id, {}).get("status") == "fail" for gate_id in SELECTION_GATES):
        return "candidate-selection"
    if any(verdict["terminal_verdict"] == "fail" for verdict in snapshot["case_verdicts"]):
        return "evaluator"
    return "insufficient-evidence"


def _trigger_case_ids(snapshot, issue_class):
    case_ids = []
    for verdict in snapshot["case_verdicts"]:
        failure_code = verdict.get("failure_code") or ""
        family = verdict["pipeline_family"]
        if issue_class == "ingestion" and failure_code.startswith("ingestion_"):
            case_ids.append(verdict["case_id"])
        elif issue_class == "replay" and (
            failure_code.startswith("replay_") or verdict["terminal_verdict"] == "fail"
        ):
            case_ids.append(verdict["case_id"])
        elif issue_class == "repo-validation" and family == "repo-fix":
            case_ids.append(verdict["case_id"])
        elif issue_class == "evaluator" and failure_code in EVALUATOR_FAILURES:
            case_ids.append(verdict["case_id"])
        elif issue_class == "insufficient-evidence" and (
            verdict["terminal_verdict"] == "abstain" or not verdict["evidence_refs"]
        ):
            case_ids.append(verdict["case_id"])
        elif issue_class == "candidate-selection" and verdict["terminal_verdict"] == "fail":
            case_ids.append(verdict["case_id"])
    return sorted(set(case_ids))


def _empty_change():
    return {
        "type": "none",
        "content": None,
        "affected_files": [],
        "validation_commands": [],
    }


def _change(proposal):
    if proposal is None:
        return _empty_change()
    return {
        "type": proposal.get("type", "none"),
        "content": proposal.get("content"),
        "affected_files": sorted(set(proposal.get("affected_files", []))),
        "validation_commands": proposal.get("validation_commands", []),
    }


def _validation(validation):
    if validation is None:
        return {"status": "not_run", "commands": [], "evidence_refs": []}
    return {
        "status": validation.get("status", "review"),
        "commands": validation.get("commands", []),
        "evidence_refs": validation.get("evidence_refs", []),
    }


def _holdout_passes(snapshot):
    if snapshot is None:
        return True
    standard = next(
        (gate for gate in snapshot["gates"] if gate["id"] == "standard-benchmark"),
        None,
    )
    return bool(standard and standard["status"] == "pass")


def _proof(baseline, post_fix, holdout, target_gate_ids, validation):
    baseline_gates = _gate_map(baseline)
    post_gates = _gate_map(post_fix) if post_fix else {}
    target_improved = (
        bool(post_fix)
        and bool(target_gate_ids)
        and all(
            baseline_gates.get(gate_id, {}).get("status") != "pass"
            and post_gates.get(gate_id, {}).get("status") == "pass"
            for gate_id in target_gate_ids
        )
    )
    regressed = sorted(
        gate_id
        for gate_id, gate in baseline_gates.items()
        if gate["status"] == "pass" and post_gates.get(gate_id, {}).get("status") != "pass"
    )
    return {
        "target_gate_ids": target_gate_ids,
        "baseline_gate_statuses": {
            gate_id: gate["status"] for gate_id, gate in sorted(baseline_gates.items())
        },
        "post_fix_snapshot_id": post_fix["snapshot_id"] if post_fix else None,
        "holdout_snapshot_id": holdout["snapshot_id"] if holdout else None,
        "target_improved": target_improved,
        "regressed_gate_ids": regressed,
        "validation": _validation(validation),
    }


def _status(issue_class, change, proof):
    if issue_class == "insufficient-evidence" or change["type"] == "none":
        return "review"
    if proof["target_improved"] and not proof["regressed_gate_ids"]:
        if proof["validation"]["status"] == "passed":
            return "proven"
    if proof["post_fix_snapshot_id"] is None:
        return "draft"
    return "review"


def _risks(issue_class, change, proof, baseline, holdout):
    risks = []
    if issue_class == "insufficient-evidence":
        risks.append("The available evidence does not isolate an actionable cause.")
    if change["type"] == "none":
        risks.append("No diff or configuration change was proposed.")
    if proof["post_fix_snapshot_id"] is None:
        risks.append("Post-fix benchmark proof has not been supplied.")
    if proof["regressed_gate_ids"]:
        risks.append(
            "The proposed fix regressed gates: " + ", ".join(proof["regressed_gate_ids"]) + "."
        )
    if proof["validation"]["status"] != "passed":
        risks.append("Post-fix validation is not recorded as passed.")
    if holdout is None:
        risks.append("No holdout snapshot was supplied for this remediation.")
    elif not _holdout_passes(holdout):
        risks.append("The supplied holdout snapshot does not pass its standard benchmark gate.")
    if baseline["scorecards"]["confidence"]["status"] != "pass":
        risks.append("The baseline confidence gate is not passing.")
    return sorted(set(risks))


def diagnose_snapshot(snapshot, proposal=None, post_fix=None, holdout=None, validation=None):
    issue_class = _classify(snapshot)
    gates = _failed_or_weak_gates(snapshot)
    target_gate_ids = sorted(
        gate["id"]
        for gate in gates
        if gate["status"] == "fail" or issue_class == "insufficient-evidence"
    )
    if not target_gate_ids:
        target_gate_ids = ["standard-benchmark"]
    change = _change(proposal) if issue_class != "insufficient-evidence" else _empty_change()
    proof = _proof(snapshot, post_fix, holdout, target_gate_ids, validation)
    body = {
        "version": "1",
        "baseline_snapshot_id": snapshot["snapshot_id"],
        "issue_class": issue_class,
        "next_action": ISSUE_ACTIONS[issue_class],
        "status": _status(issue_class, change, proof),
        "trigger_case_ids": _trigger_case_ids(snapshot, issue_class),
        "proposed_change": change,
        "proof": proof,
        "residual_risks": _risks(issue_class, change, proof, snapshot, holdout),
    }
    return {**body, "evidence_id": content_digest(body)}
