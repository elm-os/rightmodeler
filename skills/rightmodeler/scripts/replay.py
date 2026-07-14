"""Run bounded replay and emit the shared candidate-results bundle shape."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
import time
from pathlib import Path

from common import dump_json, load_json
from replay_step import build_messages, replay_step
from run_pipeline import run as run_e2e


class ReplayError(ValueError):
    pass


class ReplayBudget:
    def __init__(self, max_cost_usd, projected_cost_usd):
        if not math.isfinite(max_cost_usd) or max_cost_usd <= 0:
            raise ReplayError("max_cost_usd must be a finite positive number")
        if projected_cost_usd > max_cost_usd:
            raise ReplayError(
                f"projected replay cost ${projected_cost_usd:.6f} exceeds cap ${max_cost_usd:.6f}"
            )
        self.max_cost_usd = max_cost_usd
        self.projected_cost_usd = projected_cost_usd
        self.actual_cost_usd = 0.0

    @property
    def remaining_cost_usd(self):
        return max(0.0, self.max_cost_usd - self.actual_cost_usd)

    def can_start(self, estimate):
        return self.actual_cost_usd + estimate <= self.max_cost_usd + 1e-12

    def record(self, actual):
        if actual < 0 or not math.isfinite(actual):
            raise ReplayError("replay response returned an invalid cost")
        self.actual_cost_usd += actual


def _digest(payload):
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _load_cache(path):
    if not path:
        return {}
    cache_path = Path(path)
    if not cache_path.exists():
        return {}
    payload = load_json(cache_path)
    if not isinstance(payload, dict):
        raise ReplayError("replay cache must be a JSON object")
    return payload


def _save_cache(path, cache):
    if path:
        dump_json(cache, path)


def _step_map(normalized):
    steps = normalized.get("steps", [])
    return {str(step.get("step_id")): step for step in steps if step.get("step_id") is not None}


def _pipeline_map(pipeline):
    return {
        str(step.get("step_id")): step
        for step in (pipeline or {}).get("steps", [])
        if step.get("step_id") is not None
    }


def _step_for_case(case, steps):
    return steps.get(str(case.get("source_run_id"))) or steps.get(str(case.get("case_id")))


def _mode_for_step(step, pipeline_step):
    return (pipeline_step or {}).get("replay_mode") or step.get("replay_mode") or "single_shot"


def _modes_for_cases(cases, normalized, pipeline):
    steps = _step_map(normalized)
    pipeline_steps = _pipeline_map(pipeline)
    modes = []
    for case in cases:
        step = _step_for_case(case, steps)
        if step is None:
            raise ReplayError(f"no normalized replay step for case: {case['case_id']}")
        modes.append(_mode_for_step(step, pipeline_steps.get(str(step.get("step_id")))))
    return modes


def _single_shot_estimate(orr, step, model, runs, max_tokens):
    prompt_price, completion_price = orr.price_per_token(model)
    if prompt_price <= 0 or completion_price <= 0:
        raise ReplayError(f"cannot bound replay cost for model: {model}")
    prompt_tokens_upper_bound = len(json.dumps(build_messages(step), sort_keys=True))
    return runs * (prompt_tokens_upper_bound * prompt_price + max_tokens * completion_price)


def _normalize_result(case_id, bundle_ref, response, duration_ms):
    error = response.get("error")
    return {
        "case_id": case_id,
        "output_text": response.get("text") or "",
        "cost_usd": response.get("cost") or 0.0,
        "duration_ms": duration_ms,
        "evidence_refs": [bundle_ref],
        "replay_error": error,
    }


def _parse_e2e_response(response):
    payload = None
    for line in reversed((response.get("stdout") or "").splitlines()):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            payload = parsed
            break
    payload = payload or {}
    cost = payload.get("cost_usd", payload.get("cost"))
    if cost is None:
        raise ReplayError("E2E replay must emit authoritative cost_usd in JSON output")
    return {
        "text": payload.get("output_text", response.get("stdout") or ""),
        "cost": cost,
        "tool_calls": payload.get("tool_calls") or [],
        "error": None if response.get("ok") else response.get("stderr") or "E2E replay failed",
    }


def _run_e2e_case(codebase, run_command, step, model, timeout, e2e_runner):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as task_file:
        json.dump({"messages": step.get("input_messages") or []}, task_file)
        task_file.flush()
        response = e2e_runner(
            codebase,
            run_command,
            task_file.name,
            model,
            timeout=timeout,
        )
    return _parse_e2e_response(response)


def replay_cases(
    cases,
    normalized,
    candidate_model,
    max_cost_usd,
    corpus_version_id,
    cache_path=None,
    orr=None,
    pipeline=None,
    runs=1,
    max_tokens=1024,
    codebase=None,
    run_command=None,
    e2e_cost_per_case=None,
    timeout=900,
    single_shot_runner=replay_step,
    e2e_runner=run_e2e,
):
    if runs < 1 or max_tokens < 1:
        raise ReplayError("runs and max_tokens must be positive")
    steps = _step_map(normalized)
    pipeline_steps = _pipeline_map(pipeline)
    cache = _load_cache(cache_path)
    prepared = []
    for case in cases:
        step = _step_for_case(case, steps)
        if step is None:
            raise ReplayError(f"no normalized replay step for case: {case['case_id']}")
        pipeline_step = pipeline_steps.get(str(step.get("step_id")))
        mode = _mode_for_step(step, pipeline_step)
        cache_key = _digest(
            {
                "case": case,
                "step": step,
                "pipeline_step": pipeline_step,
                "candidate_model": candidate_model,
                "mode": mode,
                "runs": runs,
                "max_tokens": max_tokens,
                "run_command": run_command,
            }
        )
        if cache_key in cache:
            estimate = 0.0
        elif mode == "single_shot":
            if orr is None:
                raise ReplayError("single-shot replay requires an OpenRouter client")
            estimate = _single_shot_estimate(orr, step, candidate_model, runs, max_tokens)
        elif mode == "e2e":
            if not codebase or not run_command or e2e_cost_per_case is None:
                raise ReplayError(
                    "E2E replay requires codebase, run command, and bounded e2e_cost_per_case"
                )
            estimate = e2e_cost_per_case
        else:
            raise ReplayError(f"unsupported replay mode: {mode}")
        prepared.append((case, step, pipeline_step, mode, cache_key, estimate))

    projected_cost = sum(item[-1] for item in prepared)
    budget = ReplayBudget(max_cost_usd, projected_cost)
    results = []
    cache_hits = 0
    cache_misses = 0
    status = "completed"
    for case, step, pipeline_step, mode, cache_key, estimate in prepared:
        bundle_ref = f"replay/{candidate_model}/{case['case_id']}"
        if cache_key in cache:
            cache_hits += 1
            results.append(dict(cache[cache_key]))
            continue
        if not budget.can_start(estimate):
            status = "budget_exhausted"
            break
        cache_misses += 1
        started = time.perf_counter()
        try:
            if mode == "single_shot":
                response = single_shot_runner(
                    orr, step, candidate_model, runs=runs, max_tokens=max_tokens
                )
            else:
                response = _run_e2e_case(
                    codebase,
                    run_command,
                    step,
                    candidate_model,
                    timeout,
                    e2e_runner,
                )
            duration_ms = round((time.perf_counter() - started) * 1000, 3)
            result = _normalize_result(case["case_id"], bundle_ref, response, duration_ms)
            budget.record(result["cost_usd"])
        except ReplayError:
            raise
        except Exception as error:  # noqa: BLE001
            duration_ms = round((time.perf_counter() - started) * 1000, 3)
            result = _normalize_result(
                case["case_id"],
                bundle_ref,
                {"error": str(error), "cost": 0.0, "text": ""},
                duration_ms,
            )
            status = "failed"
        cache[cache_key] = result
        results.append(result)
        if result["replay_error"]:
            status = "failed"
        elif budget.actual_cost_usd > max_cost_usd + 1e-12:
            status = "budget_exhausted"
        if status != "completed":
            break

    partial = len(results) < len(cases)
    if partial and status == "completed":
        status = "budget_exhausted"
    _save_cache(cache_path, cache)
    modes = {mode for _, _, _, mode, _, _ in prepared}
    mode_label = {
        "single_shot": "single-shot",
        "e2e": "e2e",
    }
    return {
        "version": "1",
        "bundle_id": f"replay-{_digest({'cases': cases, 'model': candidate_model})[:16]}",
        "corpus_version_id": corpus_version_id,
        "candidate": {
            "id": candidate_model,
            "model": candidate_model,
            "source": "replayed",
        },
        "replay": {
            "mode": mode_label[next(iter(modes))] if len(modes) == 1 else "mixed",
            "max_cost_usd": max_cost_usd,
            "projected_cost_usd": round(projected_cost, 6),
            "actual_cost_usd": round(budget.actual_cost_usd, 6),
            "remaining_cost_usd": round(budget.remaining_cost_usd, 6),
            "cache_hits": cache_hits,
            "cache_misses": cache_misses,
            "status": status,
            "partial": partial,
        },
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--normalized", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--candidate-model", required=True)
    parser.add_argument("--max-cost-usd", type=float, required=True)
    parser.add_argument("--pipeline")
    parser.add_argument("--cache", default=".rightmodeler/replay-cache.json")
    parser.add_argument("--out", default=".rightmodeler/input/candidate-results.json")
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--codebase")
    parser.add_argument("--run-command")
    parser.add_argument("--e2e-cost-per-case", type=float)
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()

    cases = load_json(args.cases)
    normalized = load_json(args.normalized)
    pipeline = load_json(args.pipeline) if args.pipeline else None
    has_single_shot = "single_shot" in _modes_for_cases(cases["cases"], normalized, pipeline)
    orr = None
    if has_single_shot:
        from openrouter import OpenRouter

        orr = OpenRouter()

    bundle = replay_cases(
        cases["cases"],
        normalized,
        args.candidate_model,
        args.max_cost_usd,
        cases["corpus_version_id"],
        cache_path=args.cache,
        orr=orr,
        pipeline=pipeline,
        runs=args.runs,
        max_tokens=args.max_tokens,
        codebase=args.codebase,
        run_command=args.run_command,
        e2e_cost_per_case=args.e2e_cost_per_case,
        timeout=args.timeout,
    )
    dump_json(bundle, args.out)
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
