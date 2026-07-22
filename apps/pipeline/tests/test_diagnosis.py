import json
import sys

from pipeline.__main__ import evaluate_structured, main, validate_schema
from pipeline.diagnosis import diagnose_snapshot


def _snapshot(tmp_path, result, candidate_overrides=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    corpus_path = tmp_path / "cases.json"
    candidate_path = tmp_path / "candidate.json"
    snapshot_path = tmp_path / "snapshot.json"
    corpus_path.write_text(
        json.dumps(
            {
                "version": "1",
                "corpus_version_id": "sha256:" + "a" * 64,
                "source_bundle_id": "bundle-1",
                "cases": [
                    {
                        "case_id": "case-1",
                        "source_run_id": "run-1",
                        "pipeline_family": "structured-check",
                        "workload_label": "diagnosis",
                        "split": "working",
                        "risk": "normal",
                        "required_evidence": "deterministic",
                        "checks": {"required_fields": ["status"]},
                    }
                ],
            }
        )
    )
    candidate = {
        "version": "1",
        "bundle_id": "candidate-1",
        "corpus_version_id": "sha256:" + "a" * 64,
        "candidate": {
            "id": "candidate-1",
            "model": "cheap-model",
            "source": "imported",
        },
        "results": [result],
    }
    candidate.update(candidate_overrides or {})
    candidate_path.write_text(json.dumps(candidate))
    evaluate_structured(corpus_path, candidate_path, snapshot_path)
    return json.loads(snapshot_path.read_text())


def _failure_result(output_text="not json", evidence_refs=None):
    return {
        "case_id": "case-1",
        "output_text": output_text,
        "cost_usd": 0.01,
        "duration_ms": 100,
        "evidence_refs": evidence_refs if evidence_refs is not None else ["candidate/case-1"],
    }


def test_diagnosis_classifies_replay_budget_failure(tmp_path):
    snapshot = _snapshot(
        tmp_path,
        _failure_result(),
        {
            "candidate": {
                "id": "candidate-1",
                "model": "cheap-model",
                "source": "replayed",
            },
            "replay": {
                "mode": "single-shot",
                "max_cost_usd": 0.05,
                "projected_cost_usd": 0.04,
                "actual_cost_usd": 0.05,
                "remaining_cost_usd": 0,
                "cache_hits": 0,
                "cache_misses": 1,
                "status": "failed",
                "partial": True,
            },
        },
    )

    evidence = diagnose_snapshot(snapshot)

    assert evidence["issue_class"] == "replay"
    assert evidence["next_action"] == "fix-replay"
    assert evidence["trigger_case_ids"] == ["case-1"]
    assert evidence["proposed_change"]["type"] == "none"
    assert evidence["status"] == "review"
    validate_schema(evidence, "remediation-evidence")


def test_diagnosis_proves_actionable_evaluator_fix(tmp_path):
    baseline = _snapshot(tmp_path / "baseline", _failure_result())
    post_fix = _snapshot(
        tmp_path / "post-fix",
        {
            "case_id": "case-1",
            "output_text": '{"status":"open"}',
            "cost_usd": 0.01,
            "duration_ms": 100,
            "evidence_refs": ["candidate/case-1"],
        },
    )
    for snapshot in (baseline, post_fix):
        snapshot["snapshot_id"] = "sha256:" + ("b" if snapshot is baseline else "c") * 64
    baseline["gates"] = [
        {
            **gate,
            "status": "fail" if gate["id"] in {"quality", "standard-benchmark"} else gate["status"],
        }
        for gate in baseline["gates"]
    ]
    post_fix["gates"] = [
        {
            **gate,
            "status": "pass" if gate["id"] in {"quality", "standard-benchmark"} else gate["status"],
        }
        for gate in post_fix["gates"]
    ]

    evidence = diagnose_snapshot(
        baseline,
        proposal={
            "type": "configuration",
            "content": "require status field in structured evaluator",
            "affected_files": ["apps/pipeline/src/pipeline/structured.py"],
            "validation_commands": [
                {
                    "name": "pipeline tests",
                    "command": ["uv", "run", "pytest"],
                    "timeout_seconds": 60,
                }
            ],
        },
        post_fix=post_fix,
        validation={"status": "passed", "commands": ["pipeline tests"], "evidence_refs": ["ci/1"]},
    )

    assert evidence["issue_class"] == "evaluator"
    assert evidence["status"] == "proven"
    assert evidence["proof"]["target_improved"] is True
    assert evidence["proof"]["regressed_gate_ids"] == []
    validate_schema(evidence, "remediation-evidence")


def test_diagnosis_keeps_missing_evidence_as_review(tmp_path):
    snapshot = _snapshot(tmp_path, _failure_result("", evidence_refs=[]))

    evidence = diagnose_snapshot(snapshot)

    assert evidence["issue_class"] == "insufficient-evidence"
    assert evidence["next_action"] == "collect-evidence"
    assert evidence["status"] == "review"
    assert evidence["residual_risks"]
    validate_schema(evidence, "remediation-evidence")


def test_diagnose_command_writes_evidence_artifact(tmp_path, monkeypatch, capsys):
    snapshot = _snapshot(tmp_path, _failure_result())
    snapshot_path = tmp_path / "snapshot.json"
    output_path = tmp_path / "evidence.json"
    snapshot_path.write_text(json.dumps(snapshot))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "pipeline",
            "remediation",
            "diagnose",
            "--snapshot",
            str(snapshot_path),
            "--output",
            str(output_path),
        ],
    )

    assert main() == 0
    assert output_path.exists()
    assert json.loads(output_path.read_text())["issue_class"] == "evaluator"
    assert str(output_path) in capsys.readouterr().out
