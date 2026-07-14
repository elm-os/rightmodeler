from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from analyze import analyze
from common import resolve_openrouter_key
from ingest import detect_format
from report import render, render_snapshot
from replay import ReplayError, replay_cases
from workflow import run_workflow


def main():
    previous_key = os.environ.pop("OPENROUTER_API_KEY", None)
    original_cwd = Path.cwd()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            skill_root = root / ".agents" / "skills" / "rightmodeler"
            skill_root.mkdir(parents=True)
            (root / ".env").write_text('OPENROUTER_API_KEY="smoke-key"\n')
            os.chdir(skill_root)
            key, source = resolve_openrouter_key()
            assert key == "smoke-key", key
            assert Path(source).resolve() == (root / ".env").resolve(), source
    finally:
        os.chdir(original_cwd)
        os.environ.pop("OPENROUTER_API_KEY", None)
        if previous_key is not None:
            os.environ["OPENROUTER_API_KEY"] = previous_key

    detected = detect_format(
        [{"timestamp": "2026-01-01T00:00:00Z", "type": "event", "payload": {"type": "message"}}]
    )
    assert detected == "codex_cli", detected

    normalized = {
        "source_format": "codex_cli",
        "steps": [
            {
                "step_id": "s1",
                "order": 0,
                "kind": "llm",
                "name": "summarize change",
                "model": "openai/gpt-4o",
                "system_prompt": "Summarize the diff.",
                "input_messages": [
                    {"role": "user", "content": "Summarize this pull request diff."}
                ],
                "tool_calls": [],
                "output_text": "Summary",
                "success": {"accepted": True, "scores": {"human": 1}},
                "cost_usd": 0.42,
            }
        ],
    }
    pipeline = analyze(normalized, None)
    assert pipeline["total_steps"] == 1
    assert pipeline["single_shot_steps"] == 1

    report = render(
        {
            "generated_at": "2026-01-01T00:00:00Z",
            "quality_floor": 0.9,
            "total_steps": 1,
            "swappable": 1,
            "needs_e2e": 0,
            "abstained": 0,
            "steps": [
                {
                    "step_id": "s1",
                    "name": "summarize change",
                    "family": "pr_summary",
                    "current_model": "openai/gpt-4o",
                    "evaluator": "reference",
                    "best": {
                        "model": "openai/gpt-4o-mini",
                        "est_savings": 0.5,
                        "score": 1.0,
                        "verdict": "equivalent",
                        "order_consistent": True,
                    },
                }
            ],
        },
        None,
    )
    assert "Recommendation Report" in report

    replay_normalized = {
        "steps": [
            {
                "step_id": "s1",
                "input_messages": [{"role": "user", "content": "Say hello."}],
            },
            {
                "step_id": "s2",
                "input_messages": [{"role": "user", "content": "Say goodbye."}],
            },
            {
                "step_id": "s3",
                "input_messages": [{"role": "user", "content": "Say later."}],
            },
        ]
    }
    replay_cases_input = [
        {"case_id": f"case-{index}", "source_run_id": f"s{index}"} for index in range(1, 4)
    ]

    class FakeOpenRouter:
        def price_per_token(self, _model):
            return 0.000001, 0.000001

    calls = []

    def single_shot_runner(*_args, **_kwargs):
        calls.append("single-shot")
        return {"text": "hello", "cost": 0.01, "error": None}

    with tempfile.TemporaryDirectory() as replay_tmp:
        cache = Path(replay_tmp) / "cache.json"
        first = replay_cases(
            replay_cases_input[:1],
            replay_normalized,
            "cheap-model",
            0.05,
            "sha256:" + "b" * 64,
            cache_path=cache,
            orr=FakeOpenRouter(),
            single_shot_runner=single_shot_runner,
        )
        second = replay_cases(
            replay_cases_input[:1],
            replay_normalized,
            "cheap-model",
            0.05,
            "sha256:" + "b" * 64,
            cache_path=cache,
            orr=FakeOpenRouter(),
            single_shot_runner=single_shot_runner,
        )
        assert first["candidate"]["source"] == "replayed"
        assert first["corpus_version_id"] == "sha256:" + "b" * 64
        assert first["replay"]["mode"] == "single-shot"
        assert second["replay"]["cache_hits"] == 1
        assert len(calls) == 1

        try:
            replay_cases(
                replay_cases_input[:1],
                replay_normalized,
                "cheap-model",
                0.0001,
                "sha256:" + "b" * 64,
                orr=FakeOpenRouter(),
                single_shot_runner=single_shot_runner,
            )
        except ReplayError as error:
            assert "exceeds cap" in str(error)
        else:
            raise AssertionError("replay should refuse a projected cost over the cap")

        exhausted = replay_cases(
            replay_cases_input,
            replay_normalized,
            "cheap-model",
            0.015,
            "sha256:" + "b" * 64,
            orr=FakeOpenRouter(),
            single_shot_runner=single_shot_runner,
        )
        assert exhausted["replay"]["status"] == "budget_exhausted"
        assert exhausted["replay"]["partial"] is True
        assert len(exhausted["results"]) == 2

        e2e_calls = []

        def e2e_runner(*_args, **_kwargs):
            e2e_calls.append("e2e")
            return {
                "ok": True,
                "stdout": '{"output_text":"e2e output","cost_usd":0.02}\n',
                "stderr": "",
            }

        e2e = replay_cases(
            replay_cases_input[:1],
            replay_normalized,
            "cheap-model",
            0.05,
            "sha256:" + "b" * 64,
            pipeline={"steps": [{"step_id": "s1", "replay_mode": "e2e"}]},
            codebase=replay_tmp,
            run_command="ignored",
            e2e_cost_per_case=0.02,
            e2e_runner=e2e_runner,
        )
        assert e2e["replay"]["mode"] == "e2e"
        assert e2e_calls == ["e2e"]

    with tempfile.TemporaryDirectory() as workflow_tmp:
        workflow_root = Path(workflow_tmp)
        cases_path = workflow_root / "cases.json"
        candidate_path = workflow_root / "candidate.json"
        snapshot_path = workflow_root / "snapshot.json"
        report_path = workflow_root / "report.md"
        summary_path = workflow_root / "workflow.json"
        cases_path.write_text(
            json.dumps(
                {
                    "version": "1",
                    "corpus_version_id": "sha256:" + "c" * 64,
                    "source_bundle_id": "smoke-bundle",
                    "cases": [
                        {
                            "case_id": "case-1",
                            "source_run_id": "run-1",
                            "pipeline_family": "structured-check",
                            "workload_label": "smoke",
                            "split": "working",
                            "risk": "normal",
                            "required_evidence": "deterministic",
                            "checks": {"required_fields": ["status"]},
                        }
                    ],
                }
            )
        )
        candidate_path.write_text(
            json.dumps(
                {
                    "version": "1",
                    "bundle_id": "candidate-smoke",
                    "corpus_version_id": "sha256:" + "c" * 64,
                    "candidate": {
                        "id": "candidate-smoke",
                        "model": "local-fixture",
                        "source": "imported",
                    },
                    "results": [
                        {
                            "case_id": "case-1",
                            "output_text": '{"status":"open"}',
                            "cost_usd": 0.01,
                            "duration_ms": 10,
                            "evidence_refs": ["smoke/case-1"],
                        }
                    ],
                }
            )
        )
        summary = run_workflow(
            Path(__file__).resolve().parents[3],
            cases_path,
            candidate_path,
            "structured-check",
            snapshot_path,
            report_path,
            summary_path,
        )
        snapshot = json.loads(snapshot_path.read_text())
        assert summary["mode"] == "offline-imported"
        assert "Release gates" in render_snapshot(snapshot)
        assert report_path.exists()
        assert summary_path.exists()


if __name__ == "__main__":
    main()
