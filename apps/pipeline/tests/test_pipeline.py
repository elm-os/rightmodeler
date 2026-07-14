import json
import subprocess
import sys

import pytest
from jsonschema import ValidationError

from pipeline.__main__ import (
    analyze,
    build_corpus,
    evaluate_freeform,
    evaluate_repo_fix,
    evaluate_structured,
    evaluate_tool_trajectory,
    infer_task_family,
    normalize_run,
    validate_schema,
)


# --- infer_task_family: unambiguous inputs only ---------------------------


def test_infer_task_family_pr_summary():
    assert infer_task_family({"prompt": "Summarize this pull request"}) == "pr-summary"


def test_infer_task_family_support_draft():
    assert (
        infer_task_family({"prompt": "Draft a support reply for a refund"})
        == "support-draft"
    )


def test_infer_task_family_explicit_label_passthrough():
    assert (
        infer_task_family({"prompt": "anything", "task_family_label": "custom"})
        == "custom"
    )


def test_infer_task_family_default_general():
    assert infer_task_family({"prompt": "hello world"}) == "general"


# --- normalize_run --------------------------------------------------------


def test_normalize_run_full():
    long_prompt = "a" * 200
    run = {
        "id": "run-1",
        "prompt": long_prompt,
        "model": "gpt-4.1",
        "success": True,
        "final_output": "some output",
        "notes": "reviewed by a human",
        "cost_usd": 1.5,
        "task_family_label": "custom",
    }
    result = normalize_run(run)
    assert result["id"] == "run-1"
    assert result["model"] == "gpt-4.1"
    assert result["success"] is True
    assert result["cost_usd"] == 1.5
    assert result["task_family"] == "custom"
    assert result["evidence_signals"] == [
        "success_signal",
        "accepted_output",
        "human_notes",
    ]
    assert result["prompt_excerpt"] == long_prompt[:160]
    assert len(result["prompt_excerpt"]) == 160


def test_normalize_run_minimal():
    run = {"id": "run-2", "prompt": "short prompt", "model": "gpt-4o"}
    result = normalize_run(run)
    assert result["id"] == "run-2"
    assert result["model"] == "gpt-4o"
    assert result["success"] is None
    assert result["cost_usd"] is None
    assert result["prompt_excerpt"] == "short prompt"
    assert result["evidence_signals"] == ["none"]


def _corpus_definition(cases=None):
    return {
        "version": "1",
        "corpus_id": "test-corpus",
        "parent_version": None,
        "cases": cases
        if cases is not None
        else [
            {
                "case_id": "case-1",
                "source_run_id": "run-1",
                "pipeline_family": "structured-check",
                "workload_label": "json-extraction",
                "split": "working",
                "risk": "normal",
                "required_evidence": "deterministic",
                "checks": {"schema": "ticket"},
            }
        ],
    }


def _write_corpus_inputs(tmp_path, definition=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    bundle_path = tmp_path / "bundle.json"
    definition_path = tmp_path / "definition.json"
    bundle_path.write_text(
        json.dumps(
            {
                "version": "1",
                "bundle_id": "bundle-1",
                "runs": [
                    {
                        "id": "run-1",
                        "prompt": "Extract ticket fields.",
                        "model": "gpt-4o",
                        "final_output": '{"ticket": 42}',
                        "success": True,
                    }
                ],
            }
        )
    )
    definition_path.write_text(json.dumps(definition or _corpus_definition()))
    return bundle_path, definition_path


def test_build_corpus_emits_digest_and_case_references(tmp_path):
    bundle_path, definition_path = _write_corpus_inputs(tmp_path)
    manifest_path = tmp_path / "manifest.json"
    cases_path = tmp_path / "cases.json"

    result = build_corpus(bundle_path, definition_path, manifest_path, cases_path)

    manifest = json.loads(manifest_path.read_text())
    cases = json.loads(cases_path.read_text())
    assert result == cases_path
    assert manifest["content_digest"].startswith("sha256:")
    assert manifest["content_digest"] == cases["corpus_version_id"]
    assert cases["cases"][0]["source_run_id"] == "run-1"
    assert "final_output" not in cases["cases"][0]


def test_corpus_build_command_writes_benchmark_cases(tmp_path, monkeypatch, capsys):
    bundle_path, definition_path = _write_corpus_inputs(tmp_path)
    manifest_path = tmp_path / "manifest.json"
    cases_path = tmp_path / "cases.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pipeline",
            "corpus",
            "build",
            "--input",
            str(bundle_path),
            "--definition",
            str(definition_path),
            "--manifest-output",
            str(manifest_path),
            "--cases-output",
            str(cases_path),
        ],
    )

    from pipeline.__main__ import main

    assert main() == 0
    assert manifest_path.exists()
    assert json.loads(cases_path.read_text())["cases"][0]["case_id"] == "case-1"
    assert str(cases_path) in capsys.readouterr().out


def test_build_corpus_digest_is_stable_across_case_order(tmp_path):
    cases = [
        {
            "case_id": "case-2",
            "source_run_id": "run-1",
            "pipeline_family": "structured-check",
            "workload_label": "json-extraction",
            "split": "holdout",
            "risk": "normal",
            "required_evidence": "deterministic",
            "checks": {"schema": "ticket"},
        },
        {
            "case_id": "case-1",
            "source_run_id": "run-1",
            "pipeline_family": "structured-check",
            "workload_label": "json-extraction",
            "split": "working",
            "risk": "normal",
            "required_evidence": "deterministic",
            "checks": {"schema": "ticket"},
        },
    ]
    first_bundle, first_definition = _write_corpus_inputs(
        tmp_path / "first", _corpus_definition(cases)
    )
    second_bundle, second_definition = _write_corpus_inputs(
        tmp_path / "second", _corpus_definition(list(reversed(cases)))
    )
    first_manifest = tmp_path / "first-manifest.json"
    first_cases = tmp_path / "first-cases.json"
    second_manifest = tmp_path / "second-manifest.json"
    second_cases = tmp_path / "second-cases.json"

    build_corpus(first_bundle, first_definition, first_manifest, first_cases)
    build_corpus(second_bundle, second_definition, second_manifest, second_cases)

    assert json.loads(first_manifest.read_text())["content_digest"] == json.loads(
        second_manifest.read_text()
    )["content_digest"]


def test_build_corpus_rejects_unaccepted_source(tmp_path):
    bundle_path, definition_path = _write_corpus_inputs(tmp_path)
    bundle = json.loads(bundle_path.read_text())
    bundle["runs"][0]["success"] = False
    bundle_path.write_text(json.dumps(bundle))

    with pytest.raises(ValueError, match="source run is not accepted"):
        build_corpus(
            bundle_path,
            definition_path,
            tmp_path / "manifest.json",
            tmp_path / "cases.json",
        )


def test_build_corpus_rejects_duplicate_case_id(tmp_path):
    duplicate = _corpus_definition()
    duplicate["cases"].append(dict(duplicate["cases"][0]))
    bundle_path, definition_path = _write_corpus_inputs(tmp_path, duplicate)

    with pytest.raises(ValueError, match="duplicate corpus case"):
        build_corpus(
            bundle_path,
            definition_path,
            tmp_path / "manifest.json",
            tmp_path / "cases.json",
        )


def _structured_corpus_and_candidate(tmp_path, results=None, cases=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    corpus_path = tmp_path / "cases.json"
    candidate_path = tmp_path / "candidate.json"
    output_path = tmp_path / "snapshot.json"
    corpus = {
        "version": "1",
        "corpus_version_id": "sha256:" + "a" * 64,
        "source_bundle_id": "bundle-1",
        "cases": cases
        if cases is not None
        else [
            {
                "case_id": "case-1",
                "source_run_id": "run-1",
                "pipeline_family": "structured-check",
                "workload_label": "ticket-json",
                "split": "working",
                "risk": "normal",
                "required_evidence": "deterministic",
                "checks": {
                    "schema": {
                        "type": "object",
                        "required": ["ticket", "status"],
                        "properties": {
                            "ticket": {"type": "integer"},
                            "status": {"type": "string"},
                        },
                        "additionalProperties": False,
                    },
                    "required_fields": ["ticket", "status"],
                },
            }
        ],
    }
    candidate = {
        "version": "1",
        "bundle_id": "candidate-1",
        "corpus_version_id": corpus["corpus_version_id"],
        "candidate": {
            "id": "candidate-1",
            "model": "cheap-model",
            "source": "imported",
        },
        "results": results
        if results is not None
        else [
            {
                "case_id": "case-1",
                "output_text": '{"ticket": 42, "status": "open"}',
                "cost_usd": 0.04,
                "duration_ms": 125,
                "evidence_refs": ["candidate-1/case-1"],
            }
        ],
    }
    corpus_path.write_text(json.dumps(corpus))
    candidate_path.write_text(json.dumps(candidate))
    return corpus_path, candidate_path, output_path


def test_structured_evaluation_emits_passing_snapshot(tmp_path):
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(tmp_path)

    result = evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    assert result == output_path
    assert snapshot["case_verdicts"][0]["terminal_verdict"] == "pass"
    assert snapshot["summary"] == {
        "total_cases": 1,
        "pass_count": 1,
        "fail_count": 0,
        "abstain_count": 0,
        "coverage": 1.0,
    }
    assert snapshot["cost"] == {
        "candidate_cost_usd": 0.04,
        "evaluation_cost_usd": 0,
        "total_cost_usd": 0.04,
    }
    assert snapshot["timing"]["availability"] == "available"
    assert snapshot["snapshot_id"].startswith("sha256:")
    validate_schema(snapshot, "benchmark-snapshot")


def test_structured_evaluation_rejects_invalid_json(tmp_path):
    results = [
        {
            "case_id": "case-1",
            "output_text": "not json",
            "cost_usd": 0.04,
            "evidence_refs": ["candidate-1/case-1"],
        }
    ]
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path, results
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "invalid_json"


def test_structured_evaluation_rejects_schema_mismatch(tmp_path):
    results = [
        {
            "case_id": "case-1",
            "output_text": '{"ticket": "not-an-integer", "status": "open"}',
            "cost_usd": 0.04,
            "evidence_refs": ["candidate-1/case-1"],
        }
    ]
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path, results
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "schema_mismatch"


def test_structured_evaluation_rejects_missing_required_field(tmp_path):
    results = [
        {
            "case_id": "case-1",
            "output_text": '{"ticket": 42}',
            "cost_usd": 0.04,
            "evidence_refs": ["candidate-1/case-1"],
        }
    ]
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path, results
    )
    corpus = json.loads(corpus_path.read_text())
    corpus["cases"][0]["checks"] = {"required_fields": ["ticket", "status"]}
    corpus_path.write_text(json.dumps(corpus))

    evaluate_structured(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "missing_required_fields"


def test_structured_evaluation_abstains_for_missing_timing_and_evidence(tmp_path):
    results = [
        {
            "case_id": "case-1",
            "output_text": '{"ticket": 42, "status": "open"}',
            "cost_usd": 0.04,
            "evidence_refs": [],
        }
    ]
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path, results
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    verdict = snapshot["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["abstention_reason"] == "missing_evidence"
    assert verdict["timing"] == {"availability": "unavailable", "duration_ms": None}
    assert snapshot["timing"]["availability"] == "unavailable"
    assert snapshot["evidence"]["missing_case_count"] == 1


def test_structured_evaluation_abstains_for_missing_candidate_result(tmp_path):
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path, results=[]
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["abstention_reason"] == "missing_candidate_result"


def test_structured_evaluation_rejects_mismatched_candidate_case(tmp_path):
    results = [
        {
            "case_id": "case-does-not-exist",
            "output_text": "{}",
            "cost_usd": 0.04,
            "evidence_refs": ["candidate-1/case-does-not-exist"],
        }
    ]
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path, results
    )

    with pytest.raises(ValueError, match="candidate case not found"):
        evaluate_structured(corpus_path, candidate_path, output_path)


def test_structured_evaluation_is_repeatable(tmp_path):
    first_corpus, first_candidate, first_output = _structured_corpus_and_candidate(
        tmp_path / "first"
    )
    second_corpus, second_candidate, second_output = _structured_corpus_and_candidate(
        tmp_path / "second"
    )

    evaluate_structured(first_corpus, first_candidate, first_output)
    evaluate_structured(second_corpus, second_candidate, second_output)

    assert json.loads(first_output.read_text()) == json.loads(second_output.read_text())


def _scorecard_corpus_and_candidate(
    tmp_path,
    case_count=10,
    unsafe_indexes=(),
    failing_indexes=(),
    high_risk_indexes=(),
    missing_baseline=False,
    candidate_times=None,
):
    cases = []
    results = []
    candidate_times = candidate_times or [90] * case_count
    for index in range(case_count):
        case_id = f"case-{index + 1}"
        high_risk = index in high_risk_indexes
        cases.append(
            {
                "case_id": case_id,
                "source_run_id": f"run-{index + 1}",
                "pipeline_family": "structured-check",
                "workload_label": "scorecard-fixture",
                "split": "working",
                "risk": "high" if high_risk else "normal",
                "required_evidence": "deterministic",
                "checks": {},
                "labels": {
                    "recommendation": "unsafe" if index in unsafe_indexes else "safe",
                    "required_abstention": high_risk,
                },
            }
        )
        result = {
            "case_id": case_id,
            "output_text": "not json" if index in failing_indexes else "{}",
            "cost_usd": 0.01,
            "duration_ms": candidate_times[index],
            "evidence_refs": [f"candidate-1/{case_id}"],
        }
        if not missing_baseline:
            result["baseline_duration_ms"] = 100
        results.append(result)
    return _structured_corpus_and_candidate(tmp_path, results=results, cases=cases)


def test_scorecard_thresholds_keep_abstentions_out_of_quality(tmp_path):
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(
        tmp_path, failing_indexes={9}
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    assert snapshot["scorecards"]["quality"]["overall"]["value"] == 0.9
    assert snapshot["scorecards"]["quality"]["overall"]["status"] == "pass"
    assert snapshot["scorecards"]["recommendation_precision"]["value"] == 1.0
    assert snapshot["scorecards"]["safe_opportunity_recall"]["value"] == 0.9
    assert snapshot["scorecards"]["confidence"]["level"] == "medium"
    assert snapshot["scorecards"]["speed"]["status"] == "pass"
    validate_schema(snapshot, "benchmark-snapshot")


def test_scorecard_required_abstention_is_separate_from_quality(tmp_path):
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(
        tmp_path, case_count=2, high_risk_indexes={1}
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    assert snapshot["summary"]["abstain_count"] == 1
    assert snapshot["scorecards"]["quality"]["overall"]["value"] == 1.0
    assert snapshot["scorecards"]["quality"]["overall"]["denominator"] == 1
    assert snapshot["scorecards"]["required_abstention"]["value"] == 1.0
    assert snapshot["scorecards"]["coverage"]["value"] == 1.0


def test_scorecard_precision_and_safety_gate_reject_unsafe_recommendation(tmp_path):
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(
        tmp_path, unsafe_indexes={9}
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    assert snapshot["scorecards"]["recommendation_precision"]["value"] == 0.9
    assert snapshot["scorecards"]["recommendation_precision"]["status"] == "fail"
    safety_gate = next(gate for gate in snapshot["gates"] if gate["id"] == "zero-unsafe-substitutions")
    assert safety_gate["status"] == "fail"
    assert safety_gate["observed"] == 1


def test_scorecard_speed_is_unavailable_without_paired_baseline(tmp_path):
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(
        tmp_path, missing_baseline=True
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    speed = json.loads(output_path.read_text())["scorecards"]["speed"]
    assert speed["status"] == "unavailable"
    assert speed["details"]["paired_case_count"] == 0
    assert speed["details"]["missing_case_count"] == 10


def test_scorecard_speed_fails_material_p95_regression(tmp_path):
    candidate_times = [90] * 9 + [1000]
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(
        tmp_path, candidate_times=candidate_times
    )

    evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    assert snapshot["scorecards"]["speed"]["status"] == "fail"
    assert snapshot["scorecards"]["speed"]["details"]["p95_regression_pct"] > 0.2


def test_replayed_candidate_contract_records_budget_gate(tmp_path):
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(tmp_path)
    candidate = json.loads(candidate_path.read_text())
    candidate["candidate"]["source"] = "replayed"
    candidate["replay"] = {
        "mode": "single-shot",
        "max_cost_usd": 0.05,
        "projected_cost_usd": 0.03,
        "actual_cost_usd": 0.02,
        "remaining_cost_usd": 0.03,
        "cache_hits": 1,
        "cache_misses": 9,
        "status": "budget_exhausted",
        "partial": True,
    }
    candidate_path.write_text(json.dumps(candidate))

    evaluate_structured(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    replay_gate = next(gate for gate in snapshot["gates"] if gate["id"] == "replay-budget")
    assert replay_gate["status"] == "fail"
    assert replay_gate["observed"] == 0.02
    validate_schema(snapshot, "benchmark-snapshot")


def test_scorecard_contract_rejects_invalid_frozen_label(tmp_path):
    corpus_path, candidate_path, output_path = _scorecard_corpus_and_candidate(tmp_path)
    corpus = json.loads(corpus_path.read_text())
    corpus["cases"][0]["labels"]["recommendation"] = "maybe"
    corpus_path.write_text(json.dumps(corpus))

    with pytest.raises(ValidationError):
        evaluate_structured(corpus_path, candidate_path, output_path)


def test_benchmark_evaluate_command_writes_snapshot(tmp_path, monkeypatch, capsys):
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pipeline",
            "benchmark",
            "evaluate",
            "--cases",
            str(corpus_path),
            "--candidate",
            str(candidate_path),
            "--output",
            str(output_path),
        ],
    )

    from pipeline.__main__ import main

    assert main() == 0
    assert output_path.exists()
    assert str(output_path) in capsys.readouterr().out


_DEFAULT_FREEFORM_REFERENCE = {
    "type": "frozen-human-verdict",
    "refs": ["review-1/case-1"],
    "verdict": "pass",
    "agreement": "unanimous",
}


def _freeform_corpus_and_candidate(
    tmp_path, reference=_DEFAULT_FREEFORM_REFERENCE, results=None
):
    case = {
        "case_id": "case-1",
        "source_run_id": "run-1",
        "pipeline_family": "reference-freeform",
        "workload_label": "support-draft",
        "split": "working",
        "risk": "normal",
        "required_evidence": "reference",
        "checks": {},
    }
    if results is None:
        result = {
            "case_id": "case-1",
            "output_text": "A clear and helpful reply.",
            "cost_usd": 0.04,
            "duration_ms": 125,
            "evidence_refs": ["candidate-1/case-1"],
        }
        if reference is not None:
            result["reference"] = reference
        results = [result]
    return _structured_corpus_and_candidate(tmp_path, results=results, cases=[case])


def test_freeform_evaluation_uses_frozen_human_verdict(tmp_path):
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(tmp_path)

    result = evaluate_freeform(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    verdict = snapshot["case_verdicts"][0]
    assert result == output_path
    assert verdict["terminal_verdict"] == "pass"
    assert verdict["evidence_type"] == "frozen-human-verdict"
    assert verdict["evaluator"] == "frozen-human-verdict"
    assert verdict["reference"]["refs"] == ["review-1/case-1"]
    assert snapshot["summary"]["coverage"] == 1.0
    validate_schema(snapshot, "benchmark-snapshot")


def test_freeform_evaluation_preserves_rejected_human_verdict(tmp_path):
    reference = {
        "type": "frozen-human-verdict",
        "refs": ["review-1/case-1"],
        "verdict": "fail",
        "agreement": "unanimous",
    }
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(
        tmp_path, reference
    )

    evaluate_freeform(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "frozen_human_verdict_fail"
    assert verdict["evaluator"] == "frozen-human-verdict"


def test_freeform_evaluation_abstains_for_uncalibrated_reference_evidence(tmp_path):
    reference = {
        "type": "reference-evidence",
        "refs": ["reference-docs/case-1"],
    }
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(
        tmp_path, reference
    )

    evaluate_freeform(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["evidence_type"] == "reference-evidence"
    assert verdict["evaluator"] == "abstain"
    assert verdict["abstention_reason"] == "uncalibrated_reference_evidence"


def test_freeform_evaluation_abstains_for_disputed_human_verdict(tmp_path):
    reference = {
        "type": "frozen-human-verdict",
        "refs": ["review-1/case-1", "review-2/case-1"],
        "verdict": None,
        "agreement": "disputed",
    }
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(
        tmp_path, reference
    )

    evaluate_freeform(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["evidence_type"] == "frozen-human-verdict"
    assert verdict["evaluator"] == "abstain"
    assert verdict["abstention_reason"] == "reference_disagreement"


def test_freeform_evaluation_abstains_without_reference(tmp_path):
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(
        tmp_path, reference=None
    )

    evaluate_freeform(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    verdict = snapshot["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["abstention_reason"] == "missing_reference_evidence"
    assert snapshot["summary"] == {
        "total_cases": 1,
        "pass_count": 0,
        "fail_count": 0,
        "abstain_count": 1,
        "coverage": 0.0,
    }


def test_freeform_evaluation_preserves_missing_case_coverage(tmp_path):
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(
        tmp_path, results=[]
    )

    evaluate_freeform(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    assert snapshot["case_verdicts"][0]["abstention_reason"] == "missing_candidate_result"
    assert snapshot["summary"]["coverage"] == 0.0


def test_benchmark_evaluate_command_selects_freeform_family(tmp_path, monkeypatch, capsys):
    corpus_path, candidate_path, output_path = _freeform_corpus_and_candidate(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pipeline",
            "benchmark",
            "evaluate",
            "--cases",
            str(corpus_path),
            "--candidate",
            str(candidate_path),
            "--family",
            "reference-freeform",
            "--output",
            str(output_path),
        ],
    )

    from pipeline.__main__ import main

    assert main() == 0
    assert json.loads(output_path.read_text())["case_verdicts"][0]["evaluator"] == (
        "frozen-human-verdict"
    )
    assert str(output_path) in capsys.readouterr().out


def _tool_trajectory():
    return {
        "tool_calls": [
            {
                "call_id": "search-1",
                "tool_name": "search",
                "arguments": {"query": "rightmodeler"},
                "attempt": 1,
                "status": "error",
                "loop_id": "lookup",
                "iteration": 1,
            },
            {
                "call_id": "search-2",
                "tool_name": "search",
                "arguments": {"query": "rightmodeler"},
                "attempt": 2,
                "status": "success",
                "loop_id": "lookup",
                "iteration": 2,
            },
            {
                "call_id": "write-1",
                "tool_name": "write_note",
                "arguments": {"value": "result"},
                "attempt": 1,
                "status": "success",
            },
        ],
        "terminal_state": "success",
        "final_output": "done",
    }


_TRAJECTORY_SENTINEL = object()


def _tool_corpus_and_candidate(
    tmp_path,
    candidate_trajectory=_TRAJECTORY_SENTINEL,
    reference_trajectory=_TRAJECTORY_SENTINEL,
    results=None,
):
    case = {
        "case_id": "case-1",
        "source_run_id": "run-1",
        "pipeline_family": "tool-trajectory",
        "workload_label": "research-agent",
        "split": "working",
        "risk": "normal",
        "required_evidence": "trajectory",
        "checks": {},
    }
    if results is None:
        candidate = (
            _tool_trajectory()
            if candidate_trajectory is _TRAJECTORY_SENTINEL
            else candidate_trajectory
        )
        reference = (
            _tool_trajectory()
            if reference_trajectory is _TRAJECTORY_SENTINEL
            else reference_trajectory
        )
        result = {
            "case_id": "case-1",
            "output_text": "done",
            "cost_usd": 0.12,
            "duration_ms": 225,
            "evidence_refs": ["candidate-1/case-1"],
        }
        if candidate is not None:
            result["trajectory"] = candidate
        if reference is not None:
            result["reference"] = {
                "type": "reference-trajectory",
                "refs": ["reference-1/case-1"],
                "trajectory": reference,
            }
        results = [result]
    return _structured_corpus_and_candidate(tmp_path, results=results, cases=[case])


def test_tool_trajectory_evaluation_compares_full_trajectory(tmp_path):
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(tmp_path)

    result = evaluate_tool_trajectory(corpus_path, candidate_path, output_path)

    snapshot = json.loads(output_path.read_text())
    verdict = snapshot["case_verdicts"][0]
    assert result == output_path
    assert verdict["terminal_verdict"] == "pass"
    assert verdict["evidence_type"] == "trajectory"
    assert verdict["evaluator"] == "tool-trajectory"
    assert verdict["trajectory"] == {
        "tool_name": "pass",
        "arguments": "pass",
        "ordering": "pass",
        "retries": "pass",
        "loops": "pass",
        "recovery": "pass",
        "terminal_state": "pass",
        "final_output": "pass",
        "risk_flags": ["downstream", "loop", "recovery"],
    }
    validate_schema(snapshot, "benchmark-snapshot")


def test_tool_trajectory_evaluation_rejects_argument_mismatch(tmp_path):
    candidate = _tool_trajectory()
    candidate["tool_calls"][0]["arguments"] = {"query": "wrong"}
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(
        tmp_path, candidate_trajectory=candidate
    )

    evaluate_tool_trajectory(corpus_path, candidate_path, output_path)

    trajectory = json.loads(output_path.read_text())["case_verdicts"][0]["trajectory"]
    assert trajectory["arguments"] == "fail"
    assert trajectory["tool_name"] == "pass"
    assert trajectory["ordering"] == "pass"
    assert json.loads(output_path.read_text())["case_verdicts"][0]["terminal_verdict"] == (
        "fail"
    )


def test_tool_trajectory_evaluation_rejects_order_and_retry_mismatch(tmp_path):
    candidate = _tool_trajectory()
    candidate["tool_calls"][0], candidate["tool_calls"][1] = (
        candidate["tool_calls"][1],
        candidate["tool_calls"][0],
    )
    candidate["tool_calls"][1]["attempt"] = 1
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(
        tmp_path, candidate_trajectory=candidate
    )

    evaluate_tool_trajectory(corpus_path, candidate_path, output_path)

    trajectory = json.loads(output_path.read_text())["case_verdicts"][0]["trajectory"]
    assert trajectory["ordering"] == "fail"
    assert trajectory["retries"] == "fail"


def test_tool_trajectory_evaluation_rejects_terminal_and_final_output(tmp_path):
    candidate = _tool_trajectory()
    candidate["terminal_state"] = "failure"
    candidate["final_output"] = "different"
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(
        tmp_path, candidate_trajectory=candidate
    )
    candidate_bundle = json.loads(candidate_path.read_text())
    candidate_bundle["results"][0]["output_text"] = "different"
    candidate_path.write_text(json.dumps(candidate_bundle))

    evaluate_tool_trajectory(corpus_path, candidate_path, output_path)

    trajectory = json.loads(output_path.read_text())["case_verdicts"][0]["trajectory"]
    assert trajectory["terminal_state"] == "fail"
    assert trajectory["final_output"] == "fail"


def test_tool_trajectory_evaluation_abstains_without_candidate_trajectory(tmp_path):
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(
        tmp_path, candidate_trajectory=None
    )

    evaluate_tool_trajectory(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["abstention_reason"] == "missing_candidate_trajectory"
    assert verdict["evaluator"] == "abstain"


def test_tool_trajectory_evaluation_abstains_without_reference_trajectory(tmp_path):
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(
        tmp_path, reference_trajectory=None
    )

    evaluate_tool_trajectory(corpus_path, candidate_path, output_path)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["abstention_reason"] == "missing_reference_trajectory"


def test_tool_trajectory_evaluation_is_repeatable(tmp_path):
    first = _tool_corpus_and_candidate(tmp_path / "first")
    second = _tool_corpus_and_candidate(tmp_path / "second")

    evaluate_tool_trajectory(first[0], first[1], first[2])
    evaluate_tool_trajectory(second[0], second[1], second[2])

    assert json.loads(first[2].read_text()) == json.loads(second[2].read_text())


def test_benchmark_evaluate_command_selects_tool_trajectory_family(
    tmp_path, monkeypatch, capsys
):
    corpus_path, candidate_path, output_path = _tool_corpus_and_candidate(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pipeline",
            "benchmark",
            "evaluate",
            "--cases",
            str(corpus_path),
            "--candidate",
            str(candidate_path),
            "--family",
            "tool-trajectory",
            "--output",
            str(output_path),
        ],
    )

    from pipeline.__main__ import main

    assert main() == 0
    assert json.loads(output_path.read_text())["case_verdicts"][0]["evaluator"] == (
        "tool-trajectory"
    )
    assert str(output_path) in capsys.readouterr().out


def _init_clean_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email", "test@example.com"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.name", "Test User"],
        check=True,
    )
    (repo / "value.txt").write_text("before\n")
    subprocess.run(["git", "-C", str(repo), "add", "value.txt"], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-m", "initial"],
        check=True,
        capture_output=True,
    )
    revision = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
    ).strip()
    return repo, revision


def _repo_fix_corpus_and_candidate(
    tmp_path,
    patch=None,
    validation_commands=None,
    include_repo_fix=True,
):
    repo, revision = _init_clean_repo(tmp_path)
    case = {
        "case_id": "case-1",
        "source_run_id": "run-1",
        "pipeline_family": "repo-fix",
        "workload_label": "test-fix",
        "split": "working",
        "risk": "normal",
        "required_evidence": "deterministic",
        "checks": {},
    }
    patch = patch or """diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-before
+after
"""
    validation_commands = (
        validation_commands
        if validation_commands is not None
        else [
            {
                "name": "value-check",
                "command": [
                    sys.executable,
                    "-c",
                    "from pathlib import Path; assert Path('value.txt').read_text() == 'after\\n'",
                ],
                "timeout_seconds": 5,
            }
        ]
    )
    results = [
        {
            "case_id": "case-1",
            "output_text": "patch applied",
            "cost_usd": 0.02,
            "evidence_refs": ["candidate-1/case-1"],
        }
    ]
    if include_repo_fix:
        results[0]["repo_fix"] = {
            "repository": {"revision": revision},
            "patch": patch,
            "affected_files": ["value.txt"],
            "validation_commands": validation_commands,
        }
    corpus_path, candidate_path, output_path = _structured_corpus_and_candidate(
        tmp_path / "artifacts", results=results, cases=[case]
    )
    return repo, revision, corpus_path, candidate_path, output_path


def test_repo_fix_evaluation_validates_in_isolated_worktree(tmp_path):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(
        tmp_path
    )

    evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)

    snapshot = json.loads(output_path.read_text())
    verdict = snapshot["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "pass"
    assert verdict["evaluator"] == "repo-fix"
    assert verdict["repo_fix"]["patch_applied"] is True
    assert verdict["repo_fix"]["scope_matches"] is True
    assert verdict["repo_fix"]["validation"]["all_passed"] is True
    assert verdict["repo_fix"]["validation"]["commands"][0]["exit_code"] == 0
    assert (repo / "value.txt").read_text() == "before\n"
    assert subprocess.check_output(
        ["git", "-C", str(repo), "status", "--porcelain"], text=True
    ) == ""
    validate_schema(snapshot, "benchmark-snapshot")


def test_repo_fix_evaluation_captures_failed_validation(tmp_path):
    commands = [
        {
            "name": "failing-check",
            "command": [sys.executable, "-c", "print('failed'); raise SystemExit(2)"],
            "timeout_seconds": 5,
        }
    ]
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(
        tmp_path, validation_commands=commands
    )

    evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    command = verdict["repo_fix"]["validation"]["commands"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "validation_failed"
    assert command["exit_code"] == 2
    assert "failed" in command["stdout_summary"]
    assert (repo / "value.txt").read_text() == "before\n"


def test_repo_fix_evaluation_captures_patch_conflict(tmp_path):
    conflict = """diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-not-present
+after
"""
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(
        tmp_path, patch=conflict
    )

    evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "patch_conflict"
    assert verdict["repo_fix"]["patch_applied"] is False
    assert verdict["repo_fix"]["validation"]["commands"] == []
    assert (repo / "value.txt").read_text() == "before\n"


def test_repo_fix_evaluation_rejects_declared_scope_mismatch(tmp_path):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(tmp_path)
    candidate = json.loads(candidate_path.read_text())
    candidate["results"][0]["repo_fix"]["affected_files"] = ["other.txt"]
    candidate_path.write_text(json.dumps(candidate))

    evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "fail"
    assert verdict["failure_code"] == "patch_scope_mismatch"
    assert verdict["repo_fix"]["scope_matches"] is False
    assert (repo / "value.txt").read_text() == "before\n"


def test_repo_fix_evaluation_refuses_dirty_repository(tmp_path):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(tmp_path)
    (repo / "value.txt").write_text("dirty\n")

    with pytest.raises(ValueError, match="working tree is not clean"):
        evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)

    assert (repo / "value.txt").read_text() == "dirty\n"


def test_repo_fix_evaluation_refuses_stale_repository_provenance(tmp_path):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(tmp_path)
    candidate = json.loads(candidate_path.read_text())
    candidate["results"][0]["repo_fix"]["repository"]["revision"] = "0" * 40
    candidate_path.write_text(json.dumps(candidate))

    with pytest.raises(ValueError, match="revision does not match"):
        evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)


def test_repo_fix_evaluation_rejects_missing_validation_commands(tmp_path):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(
        tmp_path, validation_commands=[]
    )

    with pytest.raises(ValidationError):
        evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)


def test_repo_fix_evaluation_abstains_for_incomplete_candidate(tmp_path):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(
        tmp_path, include_repo_fix=False
    )

    evaluate_repo_fix(corpus_path, candidate_path, output_path, repo)

    verdict = json.loads(output_path.read_text())["case_verdicts"][0]
    assert verdict["terminal_verdict"] == "abstain"
    assert verdict["abstention_reason"] == "missing_repo_fix"


def test_benchmark_evaluate_command_selects_repo_fix_family(tmp_path, monkeypatch, capsys):
    repo, _, corpus_path, candidate_path, output_path = _repo_fix_corpus_and_candidate(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pipeline",
            "benchmark",
            "evaluate",
            "--cases",
            str(corpus_path),
            "--candidate",
            str(candidate_path),
            "--family",
            "repo-fix",
            "--repo",
            str(repo),
            "--output",
            str(output_path),
        ],
    )

    from pipeline.__main__ import main

    assert main() == 0
    assert json.loads(output_path.read_text())["case_verdicts"][0]["evaluator"] == "repo-fix"
    assert str(output_path) in capsys.readouterr().out


# --- analyze: success_rate math (explicit success + cost_usd only) ---------
# Every run sets BOTH success and cost_usd explicitly. If either is omitted,
# normalize_run emits null for it and analyze() crashes at the normalized-run
# schema validation (null is neither a boolean nor a number) -- that is Plan
# 002's bug B1, deliberately NOT exercised here.


def _run(idx, success):
    return {
        "id": f"run-{idx}",
        "prompt": "prompt text",
        "model": "gpt-4o",
        "task_family_label": "custom",
        "success": success,
        "cost_usd": 1.0,
    }


def _analyze_families(tmp_path, runs):
    bundle = {"version": "1", "bundle_id": "test-bundle", "runs": runs}
    input_path = tmp_path / "bundle.json"
    input_path.write_text(json.dumps(bundle))
    normalized_output = tmp_path / "normalized.json"
    analysis_output = tmp_path / "analysis.json"
    analyze(str(input_path), str(normalized_output), str(analysis_output))
    data = json.loads(analysis_output.read_text())
    return {fam["label"]: fam for fam in data["task_families"]}


def test_analyze_success_rate_mixed(tmp_path):
    families = _analyze_families(tmp_path, [_run(1, True), _run(2, False)])
    assert families["custom"]["run_count"] == 2
    assert families["custom"]["success_rate"] == 0.5


def test_analyze_success_rate_all_true(tmp_path):
    families = _analyze_families(tmp_path, [_run(1, True), _run(2, True)])
    assert families["custom"]["success_rate"] == 1.0


def test_analyze_handles_null_success_and_cost(tmp_path):
    """A run missing optional success/cost_usd must not crash analyze.

    Regression for the jsonschema "None is not of type 'boolean'" abort:
    normalize_run emits success/cost_usd as null when the source run omits
    them, and the normalized-run schema must accept null for both.
    """
    bundle = {
        "version": "1",
        "bundle_id": "null-fields-bundle",
        "runs": [
            {"id": "r1", "prompt": "do a thing", "model": "gpt-4o"},
            {
                "id": "r2",
                "prompt": "Summarize this PR for the team.",
                "model": "gpt-4o",
                "success": True,
                "cost_usd": 0.5,
            },
        ],
    }
    input_path = tmp_path / "bundle.json"
    normalized_path = tmp_path / "normalized.json"
    analysis_path = tmp_path / "analysis.json"
    input_path.write_text(json.dumps(bundle))

    # Must not raise jsonschema.ValidationError.
    analyze(str(input_path), str(normalized_path), str(analysis_path))

    normalized = json.loads(normalized_path.read_text())
    run_r1 = next(run for run in normalized["runs"] if run["id"] == "r1")
    assert run_r1["success"] is None
    assert run_r1["cost_usd"] is None

    # Both produced artifacts re-validate against their schemas.
    validate_schema(normalized, "normalized-run")
    analysis = json.loads(analysis_path.read_text())
    validate_schema(analysis, "task-family-summary")


# --- infer_task_family: whole-word matching (plan 003) ---


def test_task_family_substring_prefix_is_general():
    # "fix" must not match inside "prefix"
    assert infer_task_family({"prompt": "Update the prefix config"}) == "general"


def test_task_family_substring_docstring_is_general():
    # "docs" must not match inside "docstring"
    assert infer_task_family({"prompt": "Improve the docstring"}) == "general"


def test_task_family_substring_debugger_is_general():
    # "bug" must not match inside "debugger"
    assert infer_task_family({"prompt": "The debugger crashed"}) == "general"


def test_task_family_true_positive_bug_fix():
    assert infer_task_family({"prompt": "Fix the login bug"}) == "bug-fix"


def test_task_family_true_positive_pr_summary():
    # multi-word keyword "pull request" is a phrase match
    assert infer_task_family({"prompt": "Summarize this pull request"}) == "pr-summary"


def test_task_family_true_positive_support_draft():
    assert infer_task_family({"prompt": "Draft a support reply"}) == "support-draft"


def test_task_family_precedence_earlier_family_wins():
    # "fix" (bug-fix) and "customer"/"support" (support-draft) both match as
    # whole words; the earlier heuristic entry (bug-fix) must win.
    assert infer_task_family({"prompt": "Fix the customer support ticket"}) == "bug-fix"


def test_task_family_explicit_label_passthrough():
    # an explicit task_family_label short-circuits keyword inference
    run = {"task_family_label": "custom", "prompt": "Fix the login bug"}
    assert infer_task_family(run) == "custom"


def test_task_family_inflection_recall_tradeoff():
    # DOCUMENTED precision/recall trade of whole-word matching (plan 003):
    # inflected forms the old substring check happened to catch now fall to
    # "general". This pins the deliberate decision so it is not a silent
    # regression; a curated inflection list / semantic classifier is deferred
    # to the DIR-05 classifier redesign.
    assert infer_task_family({"prompt": "Squash these bugs"}) == "general"
    assert infer_task_family({"prompt": "Fixing the flaky tests"}) == "general"
