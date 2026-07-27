"""Brute-force cheaper-model search over the pipeline.

Strategy (per user's design):
  1. Per-step shortlist: for single_shot steps, replay through each candidate and
     judge vs the accepted output; keep the cheapest model above the quality floor.
  2. E2E resolution: score e2e steps through a faithful Mode B runner, or record a
     terminal abstention that names the missing execution evidence.

Writes results.json consumed by tui.py and report.py.

CLI:
    python orchestrate.py pipeline.json --normalized normalized.json \
        --quality-floor 0.9 --candidates auto --top 4 --out results.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import math
import statistics
import tempfile
from datetime import datetime, timezone

from common import dump_json, eprint, flatten, load_json
from judge import judge_outputs
from provider import get_provider
from replay_step import replay_step
from run_pipeline import run as run_e2e
from shortlist import shortlist


# Trace-supplied roles are outsider text; anything unrecognized is flattened so a
# trace cannot forge pseudo-role framing inside the judge's task summary.
_ROLES = {"system", "user", "assistant", "tool", "developer"}
MODE_A_OPTIMISM_SAMPLE_SIZE = 10


def _reference_text(step: dict) -> str:
    return step.get("output_text") or "\n".join(
        str(m.get("content", "")) for m in step.get("output_messages") or []
    )


def _task_text(step: dict) -> str:
    parts = []
    if step.get("system_prompt"):
        parts.append(f"[system] {str(step['system_prompt'])[:1000]}")
    for m in (step.get("input_messages") or [])[-4:]:
        role = str(m.get("role") or "user").lower()
        parts.append(f"[{role if role in _ROLES else 'other'}] {str(m.get('content', ''))[:1000]}")
    return "\n".join(parts) or str(step.get("name") or "task")


def _resource_consistency(samples: list[dict]) -> dict:
    metric = {
        "value": None,
        "status": "unavailable",
        "diagnostic_only": True,
        "runs": len(samples),
        "population": "all_runs",
        "conditioned_on": None,
        "resource_types": ["cost_usd", "duration_ms"],
        "coefficients_of_variation": None,
        "formula": "exp(-mean(population coefficient of variation))",
        "source": "Rabanser et al. (2026), Towards a Science of AI Agent Reliability",
    }
    resources = {
        "cost_usd": [sample.get("cost_usd") for sample in samples],
        "duration_ms": [sample.get("duration_ms") for sample in samples],
    }
    if not samples or any(
        not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
        for values in resources.values()
        for value in values
    ):
        metric["reason"] = "every run must record finite non-negative cost and latency"
        return metric

    coefficients = {}
    for name, values in resources.items():
        mean = statistics.fmean(values)
        coefficients[name] = 0.0 if mean == 0 else statistics.pstdev(values) / mean
    metric.update(
        {
            "value": math.exp(-statistics.fmean(coefficients.values())),
            "status": "available",
            "coefficients_of_variation": coefficients,
        }
    )
    return metric


def _outcome_consistency(samples: list[dict]) -> dict:
    metric = {
        "value": None,
        "status": "unavailable",
        "diagnostic_only": True,
        "runs": len(samples),
        "success_rate": None,
        "formula": "1 - 4*p_hat*(1 - p_hat)",
        "source": "Rabanser et al. (2026), Towards a Science of AI Agent Reliability",
        "bias_note": (
            "Our derivation, not a source-paper correction: the biased MLE Bernoulli "
            "variance has expectation p(1-p)(K-1)/K, so finite K biases C_out upward."
        ),
    }
    if not samples:
        metric["reason"] = "no replay samples"
        return metric
    if len(samples) == 1:
        metric.update(
            {
                "status": "degenerate",
                "success_rate": float(bool(samples[0].get("passes"))),
                "reason": "C_out is identically 1.0 when K=1",
            }
        )
        return metric

    success_rate = sum(bool(sample.get("passes")) for sample in samples) / len(samples)
    metric.update(
        {
            "value": 1 - 4 * success_rate * (1 - success_rate),
            "status": "available",
            "success_rate": success_rate,
        }
    )
    return metric


def evaluate_candidate(orr, step, cand, floor, runs, judge_model=None) -> dict:
    rep = replay_step(orr, step, cand["id"], runs=runs)
    if rep.get("error"):
        return {"model": cand["id"], "error": rep["error"], "passes": False}
    task = _task_text(step)
    reference = _reference_text(step)
    reference_tool_calls = [
        {"name": c["name"], "arguments": c["arguments"]} for c in step.get("tool_calls") or []
    ]
    samples = []
    for sample in rep["samples"]:
        replay_error = sample.get("error")
        verdict = (
            None
            if replay_error
            else judge_outputs(
                orr,
                task=task,
                reference=reference,
                candidate=sample.get("text") or "",
                candidate_model=cand["id"],
                reference_model=step.get("model"),
                judge_model=judge_model,
                reference_tool_calls=reference_tool_calls,
                candidate_tool_calls=sample.get("tool_calls") or [],
            )
        )
        samples.append(
            {
                "output_text": sample.get("text") or "",
                "tool_calls": sample.get("tool_calls"),
                "cost_usd": sample.get("cost"),
                "cost_is_estimate": bool(sample.get("cost_is_estimate")),
                "duration_ms": sample.get("duration_ms"),
                "served_by": sample.get("served_by"),
                "seed": sample.get("seed"),
                "temperature": sample.get("temperature"),
                "replay_error": replay_error,
                "verdict": verdict.get("verdict") if verdict else None,
                "score": verdict.get("score") if verdict else None,
                "order_consistent": verdict.get("order_consistent") if verdict else None,
                "judge": verdict.get("judge") if verdict else None,
                "justification": str(verdict.get("justification") or "")[:500] if verdict else None,
                "passes": bool(
                    verdict and verdict["score"] >= floor and verdict.get("order_consistent", True)
                ),
            }
        )
    representative = samples[0]
    return {
        "model": cand["id"],
        "blended_price": cand["blended_price"],
        "est_savings": cand.get("est_savings_vs_current"),
        "replay_cost": rep.get("cost"),
        "cost_is_estimate": bool(rep.get("cost_is_estimate")),
        "candidate_output": (rep.get("text") or "")[:2000],
        "verdict": representative["verdict"],
        "score": representative["score"],
        "order_consistent": representative["order_consistent"],
        "judge": representative["judge"],
        "justification": representative["justification"],
        "passes": representative["passes"],
        "samples": samples,
        "reliability": {
            "c_res": _resource_consistency(samples),
            "c_out": _outcome_consistency(samples),
        },
        "error": None,
    }


def evaluate_e2e_candidate(orr, step, cand, floor, mode_b_runner, judge_model=None) -> dict:
    try:
        rep = mode_b_runner(step, cand)
    except Exception as error:  # noqa: BLE001
        rep = {"error": str(error)}
    if not isinstance(rep, dict):
        rep = {"error": "Mode B runner returned an invalid response"}
    if not rep.get("error") and not (rep.get("text") or rep.get("tool_calls")):
        rep = {"error": "Mode B runner returned no comparable output or tool-call evidence"}
    if rep.get("error"):
        return {
            "model": cand["id"],
            "blended_price": cand["blended_price"],
            "est_savings": cand.get("est_savings_vs_current"),
            "error": rep["error"],
            "passes": False,
        }
    try:
        verdict = judge_outputs(
            orr,
            task=_task_text(step),
            reference=_reference_text(step),
            candidate=rep.get("text") or "",
            candidate_model=cand["id"],
            reference_model=step.get("model"),
            judge_model=judge_model,
            reference_tool_calls=[
                {"name": c["name"], "arguments": c["arguments"]}
                for c in step.get("tool_calls") or []
            ],
            candidate_tool_calls=rep.get("tool_calls") or [],
        )
    except Exception as error:  # noqa: BLE001
        return {
            "model": cand["id"],
            "blended_price": cand["blended_price"],
            "est_savings": cand.get("est_savings_vs_current"),
            "error": f"Mode B judge failed: {error}",
            "passes": False,
        }
    return {
        "model": cand["id"],
        "blended_price": cand["blended_price"],
        "est_savings": cand.get("est_savings_vs_current"),
        "replay_cost": rep.get("cost"),
        "cost_is_estimate": bool(rep.get("cost_is_estimate")),
        "candidate_output": (rep.get("text") or "")[:2000],
        "verdict": verdict["verdict"],
        "score": verdict["score"],
        "order_consistent": verdict.get("order_consistent"),
        "judge": verdict.get("judge"),
        "justification": str(verdict.get("justification") or "")[:500],
        "passes": verdict["score"] >= floor and verdict.get("order_consistent", True),
        "error": None,
    }


def _trajectory_key(step: dict) -> tuple[str, object] | None:
    if step.get("trajectory_id") is not None:
        return ("trajectory", step["trajectory_id"])
    if step.get("case_id") is not None:
        return ("case", step["case_id"])
    return None


def _mode_b_root_input(
    step: dict, normalized_steps: list[dict], prefix_provenance: str | None
) -> dict | None:
    trajectory = _trajectory_key(step)
    if trajectory is None:
        root = None if prefix_provenance == "model_authored" else step
    else:
        root = next(
            (
                candidate
                for candidate in normalized_steps
                if _trajectory_key(candidate) == trajectory
            ),
            None,
        )
    if root is None or (
        prefix_provenance == "model_authored" and root.get("step_id") == step.get("step_id")
    ):
        return None
    input_messages = root.get("input_messages")
    system_prompt = root.get("system_prompt")
    if not isinstance(input_messages, list) or not (
        input_messages or isinstance(system_prompt, str) and system_prompt.strip()
    ):
        return None
    return {
        "system_prompt": system_prompt,
        "input_messages": input_messages,
    }


def _command_mode_b_runner(codebase: str, run_command: str, timeout: int):
    def runner(root_input: dict, target_step: dict, cand: dict) -> dict:
        task = {
            **root_input,
            "target_step_id": target_step["step_id"],
        }
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as task_file:
            json.dump(task, task_file)
            task_file.flush()
            response = run_e2e(
                codebase,
                run_command,
                task_file.name,
                cand["id"],
                timeout=timeout,
            )
        payload = None
        for line in reversed((response.get("stdout") or "").splitlines()):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                payload = parsed
                break
        if not response.get("ok"):
            return {"error": response.get("stderr") or "Mode B execution failed"}
        if not payload or str(payload.get("target_step_id")) != str(target_step["step_id"]):
            return {"error": "Mode B output did not identify the requested target step"}
        cost = payload.get("cost_usd")
        if (
            not isinstance(cost, (int, float))
            or isinstance(cost, bool)
            or not math.isfinite(cost)
            or cost < 0
        ):
            return {"error": "Mode B output cost_usd must be a finite non-negative number"}
        output_text = payload.get("output_text")
        tool_calls = payload.get("tool_calls")
        if tool_calls is None:
            tool_calls = []
        if output_text is not None and not isinstance(output_text, str):
            return {"error": "Mode B output_text must be a string"}
        if not isinstance(tool_calls, list) or any(
            not isinstance(call, dict) for call in tool_calls
        ):
            return {"error": "Mode B tool_calls must be a list of objects"}
        return {
            "text": output_text or "",
            "tool_calls": tool_calls,
            "cost": cost,
            "cost_is_estimate": bool(payload.get("cost_is_estimate")),
            "error": None,
        }

    return runner


def _optimism_sample_ids(steps: list[dict], sample_size: int) -> set[str]:
    by_family: dict[str, list[dict]] = {}
    for step in steps:
        if step.get("prefix_provenance") == "model_authored":
            by_family.setdefault(step.get("family") or "general", []).append(step)
    sampled = set()
    for family, eligible in by_family.items():
        ranked = sorted(
            eligible,
            key=lambda step: hashlib.sha256(
                f"{family}\0{step.get('step_id')}".encode()
            ).hexdigest(),
        )
        sampled.update(str(step["step_id"]) for step in ranked[:sample_size])
    return sampled


def _mode_a_optimism(results: list[dict]) -> dict:
    paired_cases = set()
    families: dict[tuple[str, str], list[dict]] = {}
    for result in results:
        for candidate in result.get("candidates", []):
            pair = candidate.get("optimism_pair")
            if not pair:
                continue
            paired_cases.add(result["step_id"])
            key = (result.get("family") or "general", candidate["model"])
            families.setdefault(key, []).append(pair)
    estimates = []
    for (family, candidate_model), pairs in sorted(families.items()):
        sample_size = len(pairs)
        mode_a_pass_rate = sum(pair["mode_a_passes"] for pair in pairs) / sample_size
        mode_b_pass_rate = sum(pair["mode_b_passes"] for pair in pairs) / sample_size
        estimates.append(
            {
                "family": family,
                "candidate_model": candidate_model,
                "sample_size": sample_size,
                "mode_a_pass_rate": mode_a_pass_rate,
                "mode_b_pass_rate": mode_b_pass_rate,
                "pass_rate_delta": mode_a_pass_rate - mode_b_pass_rate,
            }
        )
    metric = {
        "name": "mode_a_optimism_pass_rate_delta",
        "definition": "Mode A pass rate minus Mode B pass rate",
        "diagnostic_only": True,
        "sample_size": len(paired_cases),
        "families": estimates,
        "status": "available" if estimates else "unavailable",
    }
    if not estimates:
        metric["reason"] = "no exposed cases had comparable outcomes from both replay arms"
    return metric


def _candidate_errors(results: list[dict]) -> dict:
    """Per-candidate API-error tally. A candidate that errors on every call was
    never actually tested; without this, hard failures (bad routing, 404s) look
    identical to judged quality failures (score 0.00)."""
    tally: dict[str, dict] = {}
    for r in results:
        for c in r.get("candidates", []):
            if "model" not in c:  # shortlist-only entries (e2e steps) were never called
                continue
            t = tally.setdefault(c["model"], {"attempts": 0, "errors": 0, "example": None})
            t["attempts"] += 1
            if c.get("error"):
                t["errors"] += 1
                t["example"] = t["example"] or str(c["error"])[:200]
    return {m: t for m, t in tally.items() if t["errors"]}


def swappable_count(results: list[dict]) -> int:
    return sum(1 for result in results if result.get("best"))


def summarize(results: list[dict], floor: float) -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "quality_floor": floor,
        "total_steps": len(results),
        "swappable": swappable_count(results),
        "needs_e2e": sum(1 for r in results if r.get("needs_e2e")),
        "abstained": sum(1 for r in results if r.get("abstain")),
        "mode_a_optimism": _mode_a_optimism(results),
        "candidate_errors": _candidate_errors(results),
        "steps": results,
    }


def run(
    pipeline: dict,
    normalized: dict,
    floor: float,
    top: int,
    allow,
    deny,
    runs,
    max_workers: int,
    checkpoint: str | None = None,
    judge_model: str | None = None,
    mode_b_runner=None,
    optimism_sample_size: int = MODE_A_OPTIMISM_SAMPLE_SIZE,
) -> dict:
    if optimism_sample_size < 1:
        raise ValueError("optimism_sample_size must be positive")
    orr = get_provider()
    steps_by_id = {s["step_id"]: s for s in normalized["steps"]}
    results = []
    total = len(pipeline["steps"])
    optimism_sample_ids = _optimism_sample_ids(pipeline["steps"], optimism_sample_size)

    def _progress(entry: dict) -> None:
        results.append(entry)
        if checkpoint:  # long runs are observable/resumable, not all-or-nothing
            dump_json(summarize(results, floor), checkpoint)

    for i, pstep in enumerate(pipeline["steps"], 1):
        sid = pstep["step_id"]
        step = steps_by_id.get(sid, {})
        mode_b_root_input = _mode_b_root_input(
            step, normalized["steps"], pstep.get("prefix_provenance")
        )
        entry = {
            "step_id": sid,
            "name": pstep.get("name"),
            "family": pstep.get("family"),
            "current_model": pstep.get("model"),
            "replay_mode": pstep.get("replay_mode"),
            "prefix_provenance": pstep.get("prefix_provenance"),
            "evaluator": pstep.get("evaluator"),
            "risk": pstep.get("risk"),
            "candidates": [],
            "best": None,
            "needs_e2e": False,
            "abstain": pstep.get("risk") == "high",
            "verdict": None,
        }

        if entry["abstain"]:
            entry["verdict"] = "abstain"
            entry["abstain_reason"] = (
                "high-risk task family; recommend no swap without human review"
            )
            _progress(entry)
            eprint(f"[abstain] {i}/{total} {sid} ({pstep.get('name')}) high-risk")
            continue

        needs_tools = bool(step.get("tool_calls") or step.get("available_tools"))
        try:
            cands = shortlist(
                orr,
                pstep.get("model") or "",
                need_tools=needs_tools,
                top=top,
                allow=allow,
                deny=deny,
            )
        except ValueError as exc:
            # the step's model string comes from the trace, so it can be missing or
            # name something the catalog has never heard of. Abstain on this step
            # rather than aborting every step after it.
            entry["abstain"] = True
            entry["verdict"] = "abstain"
            entry["abstain_reason"] = (
                "current model did not resolve in the provider catalog, so no candidate "
                "could be priced against it and this step was never tested"
            )
            _progress(entry)
            eprint(f"[warn]    {i}/{total} {sid} not tested: {flatten(str(exc), 200)}")
            continue
        if not cands:
            entry["abstain_reason"] = "no cheaper candidate with required capabilities"
            if entry["replay_mode"] == "e2e":
                entry["abstain"] = True
                entry["verdict"] = "abstain"
            _progress(entry)
            continue

        if entry["replay_mode"] == "e2e" and mode_b_runner is None:
            entry["candidates"] = cands
            entry["abstain"] = True
            entry["verdict"] = "abstain"
            entry["abstain_reason"] = (
                "E2E execution was unavailable; evidence gap: no un-healed trajectory "
                "outcome was available to score the shortlisted candidates"
            )
            _progress(entry)
            eprint(f"[abstain] {i}/{total} {sid} ({pstep.get('name')}) E2E execution unavailable")
            continue

        def mode_b_for_step(target, candidate):
            if mode_b_root_input is None:
                return {
                    "error": (
                        "Mode B root input was unavailable, so the healed prefix "
                        "could not be replaced"
                    )
                }
            return mode_b_runner(mode_b_root_input, target, candidate)

        evals = []
        with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:

            def evaluate(cand):
                sampled_for_optimism = str(sid) in optimism_sample_ids
                if entry["replay_mode"] == "e2e":
                    # The injected runner must start from the trajectory's original
                    # task input and return evidence comparable to this target step.
                    mode_b = evaluate_e2e_candidate(
                        orr,
                        step,
                        cand,
                        floor,
                        mode_b_for_step,
                        judge_model,
                    )
                    if mode_b.get("error") or not sampled_for_optimism:
                        return mode_b
                    try:
                        mode_a = evaluate_candidate(orr, step, cand, floor, runs, judge_model)
                    except Exception as error:  # noqa: BLE001
                        mode_a = {"error": str(error)}
                    primary, secondary, secondary_name = mode_b, mode_a, "Mode A"
                else:
                    mode_a = evaluate_candidate(orr, step, cand, floor, runs, judge_model)
                    if mode_a.get("error") or not sampled_for_optimism or mode_b_runner is None:
                        return mode_a
                    mode_b = evaluate_e2e_candidate(
                        orr,
                        step,
                        cand,
                        floor,
                        mode_b_for_step,
                        judge_model,
                    )
                    primary, secondary, secondary_name = mode_a, mode_b, "Mode B"
                if secondary.get("error"):
                    primary["optimism_evidence_gap"] = (
                        f"{secondary_name} replay failed: {secondary['error']}"
                    )
                else:
                    primary["optimism_pair"] = {
                        "mode_a_passes": mode_a["passes"],
                        "mode_b_passes": mode_b["passes"],
                    }
                return primary

            futs = {ex.submit(evaluate, c): c for c in cands}
            for fut in cf.as_completed(futs):
                evals.append(fut.result())
        evals.sort(key=lambda e: (not e["passes"], e.get("blended_price", 9e9)))
        entry["candidates"] = evals
        scored = [e for e in evals if not e.get("error")]
        if entry["replay_mode"] == "e2e" and not scored:
            entry["abstain"] = True
            entry["verdict"] = "abstain"
            examples = "; ".join(flatten(str(e.get("error")), 120) for e in evals[:2])
            entry["abstain_reason"] = (
                "E2E replay could not score any candidate; evidence gap: "
                f"every un-healed trajectory run failed ({examples})"
            )
            _progress(entry)
            eprint(f"[abstain] {i}/{total} {sid} ({pstep.get('name')}) E2E replay failed")
            continue
        passing = [e for e in scored if e["passes"]]
        entry["best"] = min(passing, key=lambda e: e["blended_price"]) if passing else None
        entry["verdict"] = "swap" if entry["best"] else "no_swap"
        _progress(entry)
        best = entry["best"]
        if best:
            save = best.get("est_savings") or 0
            eprint(
                f"[done]    {i}/{total} {sid} ({pstep.get('name')}) -> "
                f"{best['model']} (save {save:.0%})"
            )
        else:
            eprint(f"[done]    {i}/{total} {sid} ({pstep.get('name')}) -> no viable swap")

    return summarize(results, floor)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pipeline")
    ap.add_argument("--normalized", required=True)
    ap.add_argument("--quality-floor", type=float, default=0.9)
    ap.add_argument("--candidates", default="auto")
    ap.add_argument("--top", type=int, default=4)
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--allow", nargs="*")
    ap.add_argument("--deny", nargs="*")
    ap.add_argument("--max-workers", type=int, default=6)
    ap.add_argument("--judge-model")
    ap.add_argument("--codebase")
    ap.add_argument("--run-command")
    ap.add_argument("--e2e-timeout", type=int, default=900)
    ap.add_argument(
        "--mode-a-optimism-sample-size",
        type=int,
        default=MODE_A_OPTIMISM_SAMPLE_SIZE,
    )
    ap.add_argument(
        "--only", nargs="*", help="restrict to steps whose family, name, or step_id matches"
    )
    ap.add_argument(
        "--merge-into",
        help="overlay this run's steps onto a previous results.json (by step_id) before writing",
    )
    ap.add_argument("--out")
    args = ap.parse_args()

    pipeline = load_json(args.pipeline)
    codebase = args.codebase or pipeline.get("codebase")
    mode_b_runner = None
    if args.run_command:
        if not codebase:
            ap.error("--run-command requires --codebase or codebase in the pipeline map")
        if "{task}" not in args.run_command:
            ap.error("--run-command must include {task} for the trajectory-root input")
        mode_b_runner = _command_mode_b_runner(codebase, args.run_command, args.e2e_timeout)
    if args.only:
        keep = set(args.only)
        pipeline["steps"] = [
            s
            for s in pipeline["steps"]
            if keep & {s.get("family"), s.get("name"), s.get("step_id")}
        ]
        if not pipeline["steps"]:
            ap.error(f"--only {args.only} matched no steps")
        eprint(f"--only: {len(pipeline['steps'])} steps selected")

    result = run(
        pipeline,
        load_json(args.normalized),
        args.quality_floor,
        args.top,
        args.allow,
        args.deny,
        args.runs,
        args.max_workers,
        checkpoint=args.out,
        judge_model=args.judge_model,
        mode_b_runner=mode_b_runner,
        optimism_sample_size=args.mode_a_optimism_sample_size,
    )

    if args.merge_into:
        prior = load_json(args.merge_into)
        new_by_id = {s["step_id"]: s for s in result["steps"]}
        merged = [new_by_id.pop(s["step_id"], s) for s in prior["steps"]]
        merged.extend(new_by_id.values())
        result = summarize(merged, args.quality_floor)
        eprint(f"merged over {args.merge_into}: {len(merged)} steps")

    eprint(
        f"\nswappable: {result['swappable']}/{result['total_steps']}  "
        f"needs-e2e: {result['needs_e2e']}  abstained: {result['abstained']}"
    )
    for m, t in result["candidate_errors"].items():
        if t["errors"] == t["attempts"]:
            eprint(
                f"[warn] {m} errored on ALL {t['attempts']} calls; never actually "
                f"tested, do NOT read its 0.00 scores as a quality verdict. "
                f"example: {t['example']}"
            )
        else:
            eprint(f"[warn] {m} errored on {t['errors']}/{t['attempts']} calls")
    if args.out:
        dump_json(result, args.out)
        eprint(f"wrote {args.out}")
    else:
        print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
