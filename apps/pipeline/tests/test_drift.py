import json

import pytest

from pipeline.__main__ import build_corpus, validate_schema
from pipeline.drift import approve_drift, detect_drift, publish_corpus


def _case(case_id, source_run_id, split="working"):
    return {
        "case_id": case_id,
        "source_run_id": source_run_id,
        "pipeline_family": "structured-check",
        "workload_label": "drift-fixture",
        "split": split,
        "risk": "normal",
        "required_evidence": "deterministic",
        "checks": {"required_fields": ["status"]},
    }


def _bundle(runs, bundle_id):
    return {"version": "1", "bundle_id": bundle_id, "runs": runs}


def _run(run_id, prompt, model="gpt-4o", cost=0.1, duration_ms=100):
    return {
        "id": run_id,
        "prompt": prompt,
        "model": model,
        "success": True,
        "final_output": '{"status":"open"}',
        "cost_usd": cost,
        "duration_ms": duration_ms,
    }


def _fixtures(tmp_path):
    parent_bundle = _bundle(
        [_run("run-1", "Original prompt"), _run("run-2", "Stable prompt")],
        "parent-bundle",
    )
    parent_definition = {
        "version": "1",
        "corpus_id": "drift-fixture",
        "parent_version": None,
        "cases": [_case("case-1", "run-1"), _case("case-2", "run-2", "holdout")],
    }
    parent_bundle_path = tmp_path / "parent-bundle.json"
    parent_definition_path = tmp_path / "parent-definition.json"
    parent_manifest_path = tmp_path / "parent-manifest.json"
    parent_cases_path = tmp_path / "parent-cases.json"
    parent_bundle_path.write_text(json.dumps(parent_bundle))
    parent_definition_path.write_text(json.dumps(parent_definition))
    build_corpus(
        parent_bundle_path,
        parent_definition_path,
        parent_manifest_path,
        parent_cases_path,
    )
    parent_manifest = json.loads(parent_manifest_path.read_text())

    candidate_bundle = _bundle(
        [
            _run("run-1", "Changed prompt", "gpt-4o-mini", 0.3, 150),
            _run("run-2", "Stable prompt"),
            _run("run-3", "New holdout prompt"),
        ],
        "candidate-bundle",
    )
    candidate_definition = {
        "version": "2",
        "corpus_id": "drift-fixture",
        "parent_version": parent_manifest["content_digest"],
        "cases": [
            _case("case-1", "run-1"),
            _case("case-2", "run-2", "working"),
            _case("case-3", "run-3", "holdout"),
        ],
    }
    return parent_manifest, parent_bundle, candidate_bundle, candidate_definition


def test_detect_drift_emits_reviewable_signals_and_holdout_replacement(tmp_path):
    parent_manifest, parent_bundle, candidate_bundle, candidate_definition = _fixtures(tmp_path)

    proposal = detect_drift(
        parent_manifest,
        parent_bundle,
        candidate_bundle,
        candidate_definition,
    )

    assert proposal["status"] == "proposed"
    assert {"input", "model", "cost", "latency"}.issubset(set(proposal["signals"]))
    assert proposal["exposed_holdout_case_ids"] == ["case-2"]
    assert proposal["replacement_holdout_case_ids"] == ["case-3"]
    assert any(change["action"] == "add" for change in proposal["proposed_changes"])
    validate_schema(proposal, "corpus-drift-proposal")


def test_approved_drift_publishes_new_immutable_parented_version(tmp_path):
    parent_manifest, parent_bundle, candidate_bundle, candidate_definition = _fixtures(tmp_path)
    proposal = detect_drift(
        parent_manifest,
        parent_bundle,
        candidate_bundle,
        candidate_definition,
    )
    approved = approve_drift(
        proposal,
        "tester",
        "replace exposed holdout",
        timestamp="2026-07-13T12:00:00+00:00",
    )

    manifest, cases = publish_corpus(
        parent_manifest,
        candidate_bundle,
        candidate_definition,
        approved,
    )

    assert approved["status"] == "approved"
    assert manifest["parent_version"] == parent_manifest["content_digest"]
    assert manifest["content_digest"] != parent_manifest["content_digest"]
    assert cases["corpus_version_id"] == manifest["content_digest"]
    assert {case["case_id"] for case in cases["cases"]} == {"case-1", "case-2", "case-3"}
    validate_schema(approved, "corpus-drift-proposal")
    validate_schema(manifest, "corpus-manifest")
    validate_schema(cases, "benchmark-cases")


def test_publish_refuses_exposed_holdout_without_replacement(tmp_path):
    parent_manifest, parent_bundle, candidate_bundle, candidate_definition = _fixtures(tmp_path)
    candidate_definition["cases"] = candidate_definition["cases"][:-1]
    proposal = detect_drift(
        parent_manifest,
        parent_bundle,
        candidate_bundle,
        candidate_definition,
    )
    approved = approve_drift(proposal, "tester", timestamp="2026-07-13T12:00:00+00:00")

    with pytest.raises(ValueError, match="replacement holdout"):
        publish_corpus(parent_manifest, candidate_bundle, candidate_definition, approved)


def test_publish_requires_approved_proposal(tmp_path):
    parent_manifest, parent_bundle, candidate_bundle, candidate_definition = _fixtures(tmp_path)
    proposal = detect_drift(
        parent_manifest,
        parent_bundle,
        candidate_bundle,
        candidate_definition,
    )

    with pytest.raises(ValueError, match="approved drift"):
        publish_corpus(parent_manifest, candidate_bundle, candidate_definition, proposal)
