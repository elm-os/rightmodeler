"""Detect corpus drift and publish explicitly reviewed immutable versions."""

from datetime import UTC, datetime

from pipeline.corpus import compile_corpus, content_digest


SIGNALS = (
    "input",
    "tool",
    "evaluator",
    "acceptance",
    "model",
    "cost",
    "latency",
    "retry",
    "trajectory",
)


def _run_map(bundle):
    return {run["id"]: run for run in bundle["runs"]}


def _case_map(cases):
    return {case["case_id"]: case for case in cases}


def _different(left, right, key):
    return (
        left.get(key) is not None and right.get(key) is not None and left.get(key) != right.get(key)
    )


def _run_signals(parent_run, candidate_run):
    signals = []
    if _different(parent_run, candidate_run, "prompt"):
        signals.append("input")
    if _different(parent_run, candidate_run, "tool_calls"):
        signals.append("tool")
    if _different(parent_run, candidate_run, "evaluator") or _different(
        parent_run, candidate_run, "evaluator_version"
    ):
        signals.append("evaluator")
    if _different(parent_run, candidate_run, "success"):
        signals.append("acceptance")
    if _different(parent_run, candidate_run, "model"):
        signals.append("model")
    if _relative_change(parent_run.get("cost_usd"), candidate_run.get("cost_usd")) > 0.2:
        signals.append("cost")
    if (
        _relative_change(
            parent_run.get("duration_ms", parent_run.get("latency_ms")),
            candidate_run.get("duration_ms", candidate_run.get("latency_ms")),
        )
        > 0.2
    ):
        signals.append("latency")
    if _different(parent_run, candidate_run, "retry_count"):
        signals.append("retry")
    if _different(parent_run, candidate_run, "trajectory"):
        signals.append("trajectory")
    return signals


def _relative_change(left, right):
    if not isinstance(left, (int, float)) or not isinstance(right, (int, float)) or left == 0:
        return 0
    return abs(right - left) / abs(left)


def _case_signal(parent_case, candidate_case):
    comparable = [
        "pipeline_family",
        "workload_label",
        "risk",
        "required_evidence",
        "checks",
        "labels",
    ]
    return (
        "evaluator"
        if any(parent_case.get(key) != candidate_case.get(key) for key in comparable)
        else None
    )


def _change(action, case_id, signal, detail):
    return {
        "action": action,
        "case_id": case_id,
        "signal": signal,
        "detail": detail,
    }


def _proposal_body(parent_manifest, candidate_definition, changes, signals, exposed, replacements):
    return {
        "version": "1",
        "parent_corpus_version_id": parent_manifest["content_digest"],
        "candidate_definition_digest": content_digest(candidate_definition),
        "status": "proposed",
        "proposed_changes": changes,
        "signals": sorted(set(signals)) or ["none"],
        "exposed_holdout_case_ids": sorted(exposed),
        "replacement_holdout_case_ids": sorted(replacements),
        "approval": None,
    }


def detect_drift(parent_manifest, parent_bundle, candidate_bundle, candidate_definition):
    parent_cases = _case_map(parent_manifest["cases"])
    candidate_cases = _case_map(candidate_definition["cases"])
    parent_runs = _run_map(parent_bundle)
    candidate_runs = _run_map(candidate_bundle)
    changes = []
    signals = []

    for case_id in sorted(set(candidate_cases) - set(parent_cases)):
        changes.append(_change("add", case_id, "none", "case is new in the candidate corpus"))
    for case_id in sorted(set(parent_cases) - set(candidate_cases)):
        changes.append(
            _change("retire", case_id, "none", "case is absent from the candidate corpus")
        )

    for case_id in sorted(set(parent_cases) & set(candidate_cases)):
        parent_case = parent_cases[case_id]
        candidate_case = candidate_cases[case_id]
        case_signal = _case_signal(parent_case, candidate_case)
        if case_signal:
            action = "red-team" if candidate_case["risk"] == "high" else "relabel"
            changes.append(
                _change(action, case_id, case_signal, "reviewed case definition changed")
            )
            signals.append(case_signal)
        parent_run = parent_runs.get(parent_case["source_run_id"])
        candidate_run = candidate_runs.get(candidate_case["source_run_id"])
        if parent_run and candidate_run:
            for signal in _run_signals(parent_run, candidate_run):
                action = "red-team" if candidate_case["risk"] == "high" else "relabel"
                changes.append(_change(action, case_id, signal, f"source run shows {signal} drift"))
                signals.append(signal)

    exposed = sorted(
        case_id
        for case_id, parent_case in parent_cases.items()
        if parent_case["split"] == "holdout"
        and case_id in candidate_cases
        and candidate_cases[case_id]["split"] == "working"
    )
    replacements = sorted(
        case_id
        for case_id, candidate_case in candidate_cases.items()
        if candidate_case["split"] == "holdout" and case_id not in parent_cases
    )
    if exposed:
        signals.append("acceptance")
        changes.append(
            _change(
                "red-team",
                exposed[0],
                "acceptance",
                "holdout case was exposed and needs replacement coverage",
            )
        )
    if not changes:
        changes = [_change("no-change", "corpus", "none", "no material drift detected")]
    body = _proposal_body(
        parent_manifest,
        candidate_definition,
        changes,
        signals,
        exposed,
        replacements,
    )
    return {**body, "proposal_id": content_digest(body)}


def approve_drift(proposal, actor, reason=None, timestamp=None):
    if proposal["status"] != "proposed":
        raise ValueError("only proposed drift may be approved")
    body = dict(proposal)
    proposal_id = body.pop("proposal_id")
    body.pop("status")
    body.pop("approval")
    if content_digest({**body, "status": "proposed", "approval": None}) != proposal_id:
        raise ValueError("drift proposal digest does not match its contents")
    approved = {
        **proposal,
        "status": "approved",
        "approval": {
            "actor": actor,
            "timestamp": timestamp or datetime.now(UTC).isoformat(),
            "reason": reason,
        },
    }
    return approved


def publish_corpus(parent_manifest, candidate_bundle, candidate_definition, proposal):
    if proposal["status"] != "approved" or proposal.get("approval") is None:
        raise ValueError("corpus publication requires an approved drift proposal")
    proposal_body = dict(proposal)
    proposal_id = proposal_body.pop("proposal_id")
    proposal_body.pop("status")
    proposal_body.pop("approval")
    if content_digest({**proposal_body, "status": "proposed", "approval": None}) != proposal_id:
        raise ValueError("drift proposal digest does not match its contents")
    if proposal["parent_corpus_version_id"] != parent_manifest["content_digest"]:
        raise ValueError("drift proposal parent does not match the current corpus")
    if proposal["candidate_definition_digest"] != content_digest(candidate_definition):
        raise ValueError("candidate definition does not match drift proposal")
    if candidate_definition["parent_version"] != parent_manifest["content_digest"]:
        raise ValueError("candidate definition must name the current corpus as its parent")
    exposed = set(proposal["exposed_holdout_case_ids"])
    replacements = set(proposal["replacement_holdout_case_ids"])
    candidate_case_ids = {case["case_id"] for case in candidate_definition["cases"]}
    if not exposed.issubset(candidate_case_ids):
        raise ValueError("drift proposal references missing exposed holdout cases")
    if len(replacements) < len(exposed):
        raise ValueError("every exposed holdout requires a replacement holdout case")
    manifest, benchmark_cases = compile_corpus(candidate_bundle, candidate_definition)
    if manifest["content_digest"] == parent_manifest["content_digest"]:
        raise ValueError("published corpus must create a new immutable version")
    return manifest, benchmark_cases
