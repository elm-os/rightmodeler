"""Brute-force cheaper-model search over the pipeline.

Strategy (per user's design):
  1. Per-step shortlist  — for single_shot steps, replay through each candidate and
     judge vs the accepted output; keep the cheapest model above the quality floor.
  2. E2E confirm         — for e2e steps (or to confirm a shortlisted swap), the skill
     drives run_pipeline.py separately (needs a run command). Here we mark those steps
     as 'needs_e2e' with the shortlist so the orchestrator/TUI can request confirmation.

Writes results.json consumed by tui.py and report.py.

CLI:
    python orchestrate.py pipeline.json --normalized normalized.json \
        --quality-floor 0.9 --candidates auto --top 4 --out results.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
from datetime import datetime, timezone

from common import dump_json, eprint, load_json, model_family
from judge import judge_outputs
from openrouter import OpenRouter
from replay_step import replay_step
from shortlist import shortlist


def _reference_text(step: dict) -> str:
    return step.get("output_text") or "\n".join(
        str(m.get("content", "")) for m in step.get("output_messages") or []
    )


def _task_text(step: dict) -> str:
    parts = []
    if step.get("system_prompt"):
        parts.append(f"[system] {step['system_prompt'][:1000]}")
    for m in (step.get("input_messages") or [])[-4:]:
        parts.append(f"[{m.get('role', 'user')}] {str(m.get('content', ''))[:1000]}")
    return "\n".join(parts) or step.get("name", "task")


def evaluate_candidate(orr, step, cand, floor, runs) -> dict:
    rep = replay_step(orr, step, cand["id"], runs=runs)
    if rep.get("error"):
        return {"model": cand["id"], "error": rep["error"], "passes": False}
    verdict = judge_outputs(
        orr,
        task=_task_text(step),
        reference=_reference_text(step),
        candidate=rep.get("text") or "",
        candidate_family=model_family(cand["id"]),
        reference_family=model_family(step.get("model")),
        reference_tool_calls=[
            {"name": c["name"], "arguments": c["arguments"]} for c in step.get("tool_calls") or []
        ],
        candidate_tool_calls=rep.get("tool_calls") or [],
    )
    return {
        "model": cand["id"],
        "blended_price": cand["blended_price"],
        "est_savings": cand.get("est_savings_vs_current"),
        "replay_cost": rep.get("cost"),
        "candidate_output": (rep.get("text") or "")[:2000],
        "verdict": verdict["verdict"],
        "score": verdict["score"],
        "order_consistent": verdict.get("order_consistent"),
        "judge": verdict.get("judge"),
        "justification": verdict.get("justification"),
        "passes": verdict["score"] >= floor and verdict.get("order_consistent", True),
        "error": None,
    }


def run(
    pipeline: dict, normalized: dict, floor: float, top: int, allow, deny, runs, max_workers: int
) -> dict:
    orr = OpenRouter()
    steps_by_id = {s["step_id"]: s for s in normalized["steps"]}
    results = []

    for pstep in pipeline["steps"]:
        sid = pstep["step_id"]
        step = steps_by_id.get(sid, {})
        entry = {
            "step_id": sid,
            "name": pstep.get("name"),
            "family": pstep.get("family"),
            "current_model": pstep.get("model"),
            "replay_mode": pstep.get("replay_mode"),
            "evaluator": pstep.get("evaluator"),
            "risk": pstep.get("risk"),
            "candidates": [],
            "best": None,
            "needs_e2e": pstep["replay_mode"] == "e2e",
            "abstain": pstep.get("risk") == "high",
        }

        if entry["abstain"]:
            entry["abstain_reason"] = (
                "high-risk task family — recommend no swap without human review"
            )
            results.append(entry)
            eprint(f"[abstain] {sid} ({pstep.get('name')}) high-risk")
            continue

        needs_tools = bool(step.get("tool_calls") or step.get("available_tools"))
        cands = shortlist(
            orr, pstep.get("model") or "", need_tools=needs_tools, top=top, allow=allow, deny=deny
        )
        if not cands:
            entry["abstain_reason"] = "no cheaper candidate with required capabilities"
            results.append(entry)
            continue

        # e2e steps: don't single-shot replay (misleading). Shortlist only; flag for E2E.
        if entry["needs_e2e"]:
            entry["candidates"] = cands
            entry["note"] = (
                "multi-step/tool/loop — confirm via run_pipeline.py E2E replay before swapping"
            )
            results.append(entry)
            eprint(
                f"[e2e]     {sid} ({pstep.get('name')}) shortlisted {len(cands)} for E2E confirm"
            )
            continue

        # single-shot: replay + judge each candidate in parallel
        evals = []
        with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
            futs = {ex.submit(evaluate_candidate, orr, step, c, floor, runs): c for c in cands}
            for fut in cf.as_completed(futs):
                evals.append(fut.result())
        evals.sort(key=lambda e: (not e["passes"], e.get("blended_price", 9e9)))
        entry["candidates"] = evals
        passing = [e for e in evals if e["passes"]]
        entry["best"] = min(passing, key=lambda e: e["blended_price"]) if passing else None
        results.append(entry)
        best = entry["best"]
        if best:
            save = best.get("est_savings") or 0
            eprint(f"[done]    {sid} ({pstep.get('name')}) -> {best['model']} (save {save:.0%})")
        else:
            eprint(f"[done]    {sid} ({pstep.get('name')}) -> no viable swap")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "quality_floor": floor,
        "total_steps": len(results),
        "swappable": sum(1 for r in results if r.get("best")),
        "needs_e2e": sum(1 for r in results if r.get("needs_e2e")),
        "abstained": sum(1 for r in results if r.get("abstain")),
        "steps": results,
    }


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
    ap.add_argument("--out")
    args = ap.parse_args()

    result = run(
        load_json(args.pipeline),
        load_json(args.normalized),
        args.quality_floor,
        args.top,
        args.allow,
        args.deny,
        args.runs,
        args.max_workers,
    )
    eprint(
        f"\nswappable: {result['swappable']}/{result['total_steps']}  "
        f"needs-e2e: {result['needs_e2e']}  abstained: {result['abstained']}"
    )
    if args.out:
        dump_json(result, args.out)
        eprint(f"wrote {args.out}")
    else:
        import json

        print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
