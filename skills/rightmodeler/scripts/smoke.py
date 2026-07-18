from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import agent_ledger
from agent import Catalog, run_agent
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

    agent_smoke()


def _model(model_id, prompt_price, completion_price):
    return {
        "id": model_id,
        "name": model_id,
        "pricing": {"prompt": str(prompt_price), "completion": str(completion_price)},
        "context_length": 128000,
        "supported_parameters": ["tools", "structured_outputs"],
    }


CURRENT = _model("openai/gpt-4o", 2.5e-6, 1e-5)  # blended 4.375e-6
CHEAP = _model("cheap/one", 1e-7, 4e-7)  # blended 1.75e-7, ~96% saving
NEAR = _model("near/three", 3.6e-6, 3.6e-6)  # blended 3.6e-6, ~18% saving
AGENT_POLICY = {
    "version": "1",
    "quality_floor": 0.90,
    "min_saving_pct": 20,
    "max_cost_per_run_usd": 5,
    "never_touch": [],
    "schedule": "weekly",
}
AGENT_PIPELINE = {
    "steps": [
        {
            "step_id": "s1",
            "name": "summarize change",
            "family": "pr_summary",
            "model": "openai/gpt-4o",
            "replay_mode": "single_shot",
            "evaluator": "reference",
            "risk": "normal",
        }
    ]
}
AGENT_NORMALIZED = {"steps": [{"step_id": "s1", "tool_calls": [], "available_tools": []}]}


def agent_smoke() -> None:
    original_cwd = Path.cwd()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            root = Path(tmp)
            os.chdir(root)
            codebase = root / "repo"
            codebase.mkdir()
            (codebase / "config.py").write_text('MODEL = "openai/gpt-4o"\n')

            passing_calls = []

            def passing_evaluator(step, cand, policy):
                passing_calls.append(cand["id"])
                return {
                    "model": cand["id"],
                    "score": 0.95,
                    "verdict": "equivalent",
                    "passes": True,
                    "replay_cost": 0.005,
                    "error": None,
                }

            def failing_evaluator(step, cand, policy):
                return {
                    "model": cand["id"],
                    "score": 0.5,
                    "verdict": "divergent",
                    "passes": False,
                    "replay_cost": 0.005,
                    "error": None,
                }

            def run(policy=AGENT_POLICY, catalog=None, evaluator=None, ledger_dir="a"):
                return run_agent(
                    policy,
                    AGENT_PIPELINE,
                    AGENT_NORMALIZED,
                    Catalog(catalog if catalog is not None else [CURRENT, CHEAP]),
                    codebase,
                    dry_run=True,
                    evaluator=evaluator or passing_evaluator,
                    ledger_path=root / ledger_dir / "ledger.jsonl",
                )

            # first run: new candidate clears every gate -> one PR intent
            first = run()
            assert first["entry"]["outcome"] == "proposal", first["entry"]
            (intent,) = first["intents"]
            assert intent["candidate_model"] == "cheap/one"
            assert intent["reason"] == "new_model"
            assert intent["branch"] == "rightmodeler/swap-s1-cheap-one"
            assert intent["replacements"] == [{"file": "config.py", "count": 1}]
            assert "Receipts" in intent["body"] and "lasting no" in intent["body"]
            assert (root / ".rightmodeler/agent/intents/swap-s1-cheap-one.json").exists()
            assert (root / "a" / "heartbeat").exists()

            # second run, unchanged catalog: nothing new, no evaluation, no PR
            passing_calls.clear()
            second = run()
            assert second["entry"]["outcome"] == "abstention"
            assert passing_calls == [] and second["intents"] == []

            # quality floor abstention is recorded with the failing gate named
            floored = run(evaluator=failing_evaluator, ledger_dir="b")
            (ev,) = floored["entry"]["evaluations"]
            assert floored["entry"]["outcome"] == "abstention"
            assert ev["abstain_reason"] == "below quality_floor"

            # saving below min_saving_pct abstains even at full quality
            near = run(catalog=[CURRENT, NEAR], ledger_dir="c")
            (ev,) = near["entry"]["evaluations"]
            assert ev["abstain_reason"] == "below min_saving_pct", ev

            # never_touch steps are never evaluated
            guarded_policy = {**AGENT_POLICY, "never_touch": ["s1"]}
            untouched = run(policy=guarded_policy, ledger_dir="d")
            assert untouched["entry"]["evaluations"] == []
            assert untouched["intents"] == []

            # price drop re-ranks a scored candidate into a PR with zero spend
            rerank_ledger = root / "e" / "ledger.jsonl"
            agent_ledger.append_entry(
                {
                    "version": "1",
                    "run_id": "run-0001",
                    "started_at": agent_ledger.utc_now(),
                    "catalog_digest": "sha256:" + "d" * 64,
                    "outcome": "abstention",
                    "spend_usd": 0.005,
                    "evaluations": [
                        {
                            "step_id": "s1",
                            "candidate_model": "near/three",
                            "price_at_eval": 3.6e-6,
                            "score": 0.95,
                            "est_savings_pct": 17.7,
                            "passes": False,
                            "complete": True,
                            "source": "replay",
                            "verdict": "equivalent",
                            "cost_usd": 0.005,
                            "abstain_reason": "below min_saving_pct",
                        }
                    ],
                    "incumbents": [],
                    "deferred": [],
                    "decisions": [],
                },
                rerank_ledger,
            )
            dropped = _model("near/three", 5e-7, 5e-7)  # blended 5e-7, big drop
            passing_calls.clear()
            reranked = run(catalog=[CURRENT, dropped], ledger_dir="e")
            assert passing_calls == []  # no tokens spent
            (intent,) = reranked["intents"]
            assert intent["reason"] == "price_drop"
            rerank_evals = [
                ev for ev in reranked["entry"]["evaluations"] if ev["source"] == "price_rerank"
            ]
            assert rerank_evals and rerank_evals[0]["passes"], rerank_evals

            # delisted incumbent trips the guard and waives the savings gate
            delisted = run(catalog=[CHEAP], ledger_dir="f")
            (incumbent,) = delisted["entry"]["incumbents"]
            assert incumbent["guard"] == "delisted"
            (intent,) = delisted["intents"]
            assert intent["reason"] == "incumbent_guard"

            # incumbent price rise vs first recorded price trips the guard
            rise_ledger = root / "g" / "ledger.jsonl"
            agent_ledger.append_entry(
                {
                    "version": "1",
                    "run_id": "run-0001",
                    "started_at": agent_ledger.utc_now(),
                    "catalog_digest": "sha256:" + "d" * 64,
                    "outcome": "abstention",
                    "spend_usd": 0.0,
                    "evaluations": [],
                    "incumbents": [{"step_id": "s1", "model": "openai/gpt-4o", "price": 2.0e-6}],
                    "deferred": [],
                    "decisions": [],
                },
                rise_ledger,
            )
            risen = run(ledger_dir="g")
            (incumbent,) = risen["entry"]["incumbents"]
            assert incumbent["guard"] == "price_rise"

            # budget: unaffordable second candidate defers, then drains next run
            other = _model("other/two", 2e-7, 8e-7)
            tight_policy = {**AGENT_POLICY, "max_cost_per_run_usd": 0.02}
            deferred = run(
                policy=tight_policy,
                catalog=[CURRENT, CHEAP, other],
                evaluator=failing_evaluator,
                ledger_dir="h",
            )
            assert deferred["entry"]["outcome"] == "deferral"
            assert deferred["entry"]["deferred"] == [
                {"step_id": "s1", "candidate_model": "other/two"}
            ]
            drained = run(
                catalog=[CURRENT, CHEAP, other],
                evaluator=failing_evaluator,
                ledger_dir="h",
            )
            assert drained["entry"]["deferred"] == []
            assert [ev["candidate_model"] for ev in drained["entry"]["evaluations"]] == [
                "other/two"
            ]

            # a cap below the cheapest estimate aborts with a clear message
            broke_policy = {**AGENT_POLICY, "max_cost_per_run_usd": 0.005}
            aborted = run(policy=broke_policy, ledger_dir="i")
            assert aborted["entry"]["outcome"] == "abort"
            assert "budget too low" in aborted["entry"]["outcome_detail"]

            # a closed PR is a lasting no: the pair is never re-proposed
            closed_ledger = root / "j" / "ledger.jsonl"
            agent_ledger.append_entry(
                {
                    "version": "1",
                    "run_id": "run-0001",
                    "started_at": agent_ledger.utc_now(),
                    "catalog_digest": "sha256:" + "d" * 64,
                    "outcome": "proposal",
                    "spend_usd": 0.0,
                    "evaluations": [],
                    "incumbents": [],
                    "deferred": [],
                    "decisions": [
                        {
                            "step_id": "s1",
                            "candidate_model": "cheap/one",
                            "decision": "closed",
                            "pr_ref": None,
                        }
                    ],
                },
                closed_ledger,
            )
            passing_calls.clear()
            suppressed = run(ledger_dir="j")
            assert passing_calls == [] and suppressed["intents"] == []
            assert suppressed["entry"]["outcome"] == "abstention"
        finally:
            os.chdir(original_cwd)


if __name__ == "__main__":
    main()
