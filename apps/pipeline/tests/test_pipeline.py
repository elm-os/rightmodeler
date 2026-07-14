import json
import sys

import pytest

from pipeline.__main__ import (
    analyze,
    build_corpus,
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
        or [
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
