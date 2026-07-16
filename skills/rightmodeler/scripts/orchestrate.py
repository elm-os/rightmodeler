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


def _candidate_errors(results: list[dict]) -> dict:
    """Per-candidate API-error tally. A candidate that errors on every call was
    never actually tested — without this, hard failures (bad routing, 404s) look
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


def summarize(results: list[dict], floor: float) -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "quality_floor": floor,
        "total_steps": len(results),
        "swappable": sum(1 for r in results if r.get("best")),
        "needs_e2e": sum(1 for r in results if r.get("needs_e2e")),
        "abstained": sum(1 for r in results if r.get("abstain")),
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
) -> dict:
    orr = OpenRouter()
    steps_by_id = {s["step_id"]: s for s in normalized["steps"]}
    results = []
    total = len(pipeline["steps"])

    def _progress(entry: dict) -> None:
        results.append(entry)
        if checkpoint:  # long runs are observable/resumable, not all-or-nothing
            dump_json(summarize(results, floor), checkpoint)

    for i, pstep in enumerate(pipeline["steps"], 1):
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
            _progress(entry)
            eprint(f"[abstain] {i}/{total} {sid} ({pstep.get('name')}) high-risk")
            continue

        needs_tools = bool(step.get("tool_calls") or step.get("available_tools"))
        cands = shortlist(
            orr, pstep.get("model") or "", need_tools=needs_tools, top=top, allow=allow, deny=deny
        )
        if not cands:
            entry["abstain_reason"] = "no cheaper candidate with required capabilities"
            _progress(entry)
            continue

        # e2e steps: don't single-shot replay (misleading). Shortlist only; flag for E2E.
        if entry["needs_e2e"]:
            entry["candidates"] = cands
            entry["note"] = (
                "multi-step/tool/loop — confirm via run_pipeline.py E2E replay before swapping"
            )
            _progress(entry)
            eprint(
                f"[e2e]     {i}/{total} {sid} ({pstep.get('name')}) "
                f"shortlisted {len(cands)} for E2E confirm"
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
                f"[warn] {m} errored on ALL {t['attempts']} calls — never actually "
                f"tested, do NOT read its 0.00 scores as a quality verdict. "
                f"example: {t['example']}"
            )
        else:
            eprint(f"[warn] {m} errored on {t['errors']}/{t['attempts']} calls")
    if args.out:
        dump_json(result, args.out)
        eprint(f"wrote {args.out}")
    else:
        import json

        print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
