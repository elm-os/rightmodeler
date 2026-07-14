"""Shared matching and immutable snapshot assembly for benchmark families."""

from pipeline.corpus import content_digest


def match_candidate_results(corpus, candidate_bundle, pipeline_family):
    if candidate_bundle["corpus_version_id"] != corpus["corpus_version_id"]:
        raise ValueError("candidate corpus version does not match benchmark cases")

    cases = sorted(corpus["cases"], key=lambda case: case["case_id"])
    if any(case["pipeline_family"] != pipeline_family for case in cases):
        raise ValueError(f"benchmark evaluation requires {pipeline_family} cases")

    case_by_id = {case["case_id"]: case for case in cases}
    if len(case_by_id) != len(cases):
        raise ValueError("duplicate benchmark case")

    results_by_case = {}
    for result in candidate_bundle["results"]:
        case_id = result["case_id"]
        if case_id not in case_by_id:
            raise ValueError(f"candidate case not found in benchmark cases: {case_id}")
        if case_id in results_by_case:
            raise ValueError(f"duplicate candidate result: {case_id}")
        results_by_case[case_id] = result
    return cases, results_by_case


def build_snapshot(corpus, candidate_bundle, verdicts):
    verdicts = sorted(verdicts, key=lambda verdict: verdict["case_id"])
    verdict_counts = {
        verdict: sum(1 for item in verdicts if item["terminal_verdict"] == verdict)
        for verdict in ("pass", "fail", "abstain")
    }
    total_cases = len(verdicts)
    available_timing = sum(
        1 for verdict in verdicts if verdict["timing"]["availability"] == "available"
    )
    available_evidence = sum(1 for verdict in verdicts if verdict["evidence_refs"])
    timing_availability = (
        "available"
        if available_timing == total_cases
        else "partial"
        if available_timing
        else "unavailable"
    )
    candidate_cost = sum(verdict["cost_usd"] for verdict in verdicts)
    snapshot_without_id = {
        "version": "1",
        "corpus_version_id": corpus["corpus_version_id"],
        "candidate_bundle_id": candidate_bundle["bundle_id"],
        "candidate": candidate_bundle["candidate"],
        "case_verdicts": verdicts,
        "summary": {
            "total_cases": total_cases,
            "pass_count": verdict_counts["pass"],
            "fail_count": verdict_counts["fail"],
            "abstain_count": verdict_counts["abstain"],
            "coverage": (total_cases - verdict_counts["abstain"]) / total_cases
            if total_cases
            else 0,
        },
        "cost": {
            "candidate_cost_usd": candidate_cost,
            "evaluation_cost_usd": 0,
            "total_cost_usd": candidate_cost,
        },
        "timing": {
            "availability": timing_availability,
            "available_case_count": available_timing,
            "missing_case_count": total_cases - available_timing,
        },
        "evidence": {
            "available_case_count": available_evidence,
            "missing_case_count": total_cases - available_evidence,
            "references": sorted(
                {reference for verdict in verdicts for reference in verdict["evidence_refs"]}
            ),
        },
    }
    return {
        **snapshot_without_id,
        "snapshot_id": content_digest(snapshot_without_id),
    }
