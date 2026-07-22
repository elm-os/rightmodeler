from __future__ import annotations

import json
import os
import tempfile
from contextlib import redirect_stderr
from dataclasses import replace
from io import StringIO
from pathlib import Path

from analyze import analyze
from common import resolve_env_var
from ingest import detect_format
from judge import pick_judge
from provider import (
    LITELLM_CONFIG,
    OPENROUTER_CONFIG,
    VERCEL_AI_GATEWAY_CONFIG,
    LiteLLMProvider,
    OpenRouterProvider,
    VercelAIGatewayProvider,
    get_provider,
)
from report import render, render_snapshot
from replay import ReplayError, replay_cases
from run_pipeline import _provider_env
from workflow import run_workflow


PROVIDER_ENV = (
    "RIGHTMODELER_PROVIDER",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "LITELLM_PROXY_API_KEY",
    "LITELLM_PROXY_API_BASE",
)


def provider_selection_smoke():
    previous = {name: os.environ.get(name) for name in PROVIDER_ENV}
    original_cwd = Path.cwd()

    def select(values, provider_name=None):
        for env_name in PROVIDER_ENV:
            os.environ.pop(env_name, None)
        os.environ.update(values)
        provider = get_provider(provider_name)
        provider._client.close()
        return provider

    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.chdir(tmp)
            assert isinstance(select({"OPENROUTER_API_KEY": "test"}), OpenRouterProvider)
            assert isinstance(select({"AI_GATEWAY_API_KEY": "test"}), VercelAIGatewayProvider)
            assert isinstance(
                select(
                    {
                        "LITELLM_PROXY_API_KEY": "test",
                        "LITELLM_PROXY_API_BASE": "http://localhost:4000",
                    }
                ),
                LiteLLMProvider,
            )
            assert isinstance(
                select(
                    {
                        "RIGHTMODELER_PROVIDER": "vercel-ai-gateway",
                        "OPENROUTER_API_KEY": "test",
                        "AI_GATEWAY_API_KEY": "test",
                    }
                ),
                VercelAIGatewayProvider,
            )
            assert isinstance(
                select(
                    {
                        "RIGHTMODELER_PROVIDER": "vercel-ai-gateway",
                        "OPENROUTER_API_KEY": "test",
                        "AI_GATEWAY_API_KEY": "test",
                    },
                    "openrouter",
                ),
                OpenRouterProvider,
            )

            for name in PROVIDER_ENV:
                os.environ.pop(name, None)
            os.environ.update({"OPENROUTER_API_KEY": "test", "AI_GATEWAY_API_KEY": "test"})
            stderr = StringIO()
            with redirect_stderr(stderr):
                provider = get_provider()
            provider._client.close()
            assert isinstance(provider, OpenRouterProvider)
            info_lines = [
                line for line in stderr.getvalue().splitlines() if line.startswith("[info]")
            ]
            assert len(info_lines) == 1
            assert "RIGHTMODELER_PROVIDER" in info_lines[0]

            for name in PROVIDER_ENV:
                os.environ.pop(name, None)
            stderr = StringIO()
            try:
                with redirect_stderr(stderr):
                    get_provider()
            except SystemExit as error:
                assert error.code == 2
            else:
                raise AssertionError("provider selection should exit 2 when unconfigured")
            output = stderr.getvalue()
            for name in (
                "OPENROUTER_API_KEY",
                "AI_GATEWAY_API_KEY",
                "LITELLM_PROXY_API_KEY",
                "LITELLM_PROXY_API_BASE",
            ):
                assert name in output
    finally:
        os.chdir(original_cwd)
        for name in PROVIDER_ENV:
            os.environ.pop(name, None)
            if previous[name] is not None:
                os.environ[name] = previous[name]


def judge_selection_smoke():
    class FakeProvider:
        def __init__(self, catalog):
            self.catalog = catalog

        def list_models(self):
            return self.catalog

    catalog = [
        {"id": "alpha/candidate", "created": 300, "context_length": 4000},
        {"id": "beta/reference", "created": 300, "context_length": 4000},
        {
            "id": "gamma/judge-small",
            "created": 100,
            "context_length": 1000,
            "pricing": {"prompt": "0.001", "completion": "0.001"},
        },
        {
            "id": "delta/judge-strong",
            "created": 200,
            "context_length": 2000,
            "pricing": {"prompt": "0.002", "completion": "0.003"},
        },
    ]
    provider = FakeProvider(catalog)
    assert pick_judge(provider, "alpha/candidate", "beta/reference") == "delta/judge-strong"

    try:
        pick_judge(FakeProvider(catalog[:2]), "alpha/candidate", "beta/reference")
    except ValueError as error:
        assert "--judge-model" in str(error)
    else:
        raise AssertionError("judge selection should refuse without a neutral family")

    try:
        pick_judge(provider, "unmapped-alias", "beta/reference")
    except ValueError as error:
        assert "--judge-model" in str(error)
    else:
        raise AssertionError("unknown model family should require an explicit judge")
    assert (
        pick_judge(
            provider,
            "unmapped-alias",
            "beta/reference",
            override="gamma/judge-small",
        )
        == "gamma/judge-small"
    )

    litellm = object.__new__(LiteLLMProvider)
    mapped = litellm._enrich_catalog(
        [{"id": "judge-alias"}],
        [
            {
                "model_name": "judge-alias",
                "litellm_params": {"model": "gamma/upstream"},
            }
        ],
    )
    assert mapped[0]["resolved_family"] == "gamma"
    unmapped = litellm._enrich_catalog([{"id": "judge-alias"}], [])
    assert unmapped[0]["resolved_family"] == "unknown"
    mixed = litellm._enrich_catalog(
        [{"id": "judge-alias"}],
        [
            {
                "model_name": "judge-alias",
                "litellm_params": {"model": "gamma/upstream"},
            },
            {
                "model_name": "judge-alias",
                "litellm_params": {"model": "delta/upstream"},
            },
        ],
    )
    assert mixed[0]["resolved_family"] == "unknown"


def provider_env_smoke():
    for config in (OPENROUTER_CONFIG, VERCEL_AI_GATEWAY_CONFIG):
        env = _provider_env(config, "test-key")
        assert env["RIGHTMODELER_REPLAY_BASE_URL"] == config.base_url
        assert env["RIGHTMODELER_REPLAY_API_KEY"] == "test-key"
        assert env["OPENAI_BASE_URL"] == config.base_url
        assert env["OPENAI_API_KEY"] == "test-key"
        assert "ANTHROPIC_BASE_URL" not in env
        assert "ANTHROPIC_API_KEY" not in env

    config = replace(LITELLM_CONFIG, base_url="http://localhost:4000")
    env = _provider_env(config, "test-key")
    assert env["OPENAI_BASE_URL"] == "http://localhost:4000"
    assert env["ANTHROPIC_BASE_URL"] == "http://localhost:4000"
    assert env["ANTHROPIC_API_KEY"] == "test-key"


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
            key, source = resolve_env_var("OPENROUTER_API_KEY")
            assert key == "smoke-key", key
            assert Path(source).resolve() == (root / ".env").resolve(), source
    finally:
        os.chdir(original_cwd)
        os.environ.pop("OPENROUTER_API_KEY", None)
        if previous_key is not None:
            os.environ["OPENROUTER_API_KEY"] = previous_key

    provider_selection_smoke()
    judge_selection_smoke()
    provider_env_smoke()

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
                        "replay_cost": 0.0123,
                        "cost_is_estimate": True,
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
    assert "$0.012300 est." in report

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

    class FakeProvider:
        def price_per_token(self, _model):
            return 0.000001, 0.000001

    calls = []

    def single_shot_runner(*_args, **_kwargs):
        calls.append("single-shot")
        return {
            "text": "hello",
            "cost": 0.01,
            "cost_is_estimate": True,
            "error": None,
        }

    with tempfile.TemporaryDirectory() as replay_tmp:
        cache = Path(replay_tmp) / "cache.json"
        first = replay_cases(
            replay_cases_input[:1],
            replay_normalized,
            "cheap-model",
            0.05,
            "sha256:" + "b" * 64,
            cache_path=cache,
            orr=FakeProvider(),
            single_shot_runner=single_shot_runner,
        )
        second = replay_cases(
            replay_cases_input[:1],
            replay_normalized,
            "cheap-model",
            0.05,
            "sha256:" + "b" * 64,
            cache_path=cache,
            orr=FakeProvider(),
            single_shot_runner=single_shot_runner,
        )
        assert first["candidate"]["source"] == "replayed"
        assert first["corpus_version_id"] == "sha256:" + "b" * 64
        assert first["replay"]["mode"] == "single-shot"
        assert first["replay"]["cost_is_estimate"] is True
        assert first["results"][0]["cost_is_estimate"] is True
        assert second["results"][0]["cost_is_estimate"] is True
        assert second["replay"]["cache_hits"] == 1
        assert len(calls) == 1

        try:
            replay_cases(
                replay_cases_input[:1],
                replay_normalized,
                "cheap-model",
                0.0001,
                "sha256:" + "b" * 64,
                orr=FakeProvider(),
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
            orr=FakeProvider(),
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
                "stdout": (
                    '{"output_text":"e2e output","cost_usd":0.02,"cost_is_estimate":true}\n'
                ),
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
        assert e2e["replay"]["cost_is_estimate"] is True
        assert e2e["results"][0]["cost_is_estimate"] is True
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
