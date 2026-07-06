"""Map the pipeline from normalized traces: classify each step, group task families,
pick the strongest evaluator, and estimate current cost.

CLI:
    python analyze.py normalized.json --codebase ./repo --out pipeline.json
"""

from __future__ import annotations

import argparse
import re
from collections import defaultdict

from common import dump_json, eprint, load_json

# high-risk families we always abstain on unless the user overrides
HIGH_RISK = re.compile(
    r"auth|login|password|payment|billing|migrat|delete|drop|prod|deploy|secret", re.I
)

FAMILY_HINTS = [
    ("pr_summary", r"pull request|pr summary|summari[sz]e.*(diff|change)"),
    ("test_generation", r"unit test|write.*test|pytest|jest"),
    ("bug_fix", r"fix.*bug|bug ?fix|stack ?trace|traceback"),
    ("sql_generation", r"\bsql\b|select .* from|query the"),
    ("code_review", r"review.*(code|pr|diff)|code review"),
    ("doc_rewrite", r"rewrite|documentation|readme|docstring"),
    ("support_draft", r"customer|support|ticket|reply to"),
    ("tool_agent", r"tool|function call|agent"),
]


def classify_step(step: dict, steps: list[dict]) -> dict:
    has_tools = bool(step.get("tool_calls"))
    # loop: same node name appears more than once
    name = step.get("name")
    repeats = sum(1 for s in steps if s.get("name") == name and name) > 1
    # feeds downstream: any later step references this as parent
    sid = step.get("step_id")
    feeds = any(s.get("parent_id") == sid for s in steps)
    multi = has_tools or repeats or feeds or step.get("kind") in ("agent", "chain")
    return {
        "replay_mode": "e2e" if multi else "single_shot",
        "has_tools": has_tools,
        "in_loop": repeats,
        "feeds_downstream": feeds,
    }


def pick_evaluator(step: dict, cls: dict) -> str:
    """Strongest available signal for this step."""
    if cls["has_tools"]:
        return "trajectory"  # correct tool selection/args, deterministic pre-check first
    if step.get("success", {}).get("scores"):
        return "reference"  # we have an accepted output + scores
    if step.get("output_text"):
        return "reference"  # accepted output exists → reference-guided
    return "llm_judge"


def infer_family(step: dict) -> str:
    hay = " ".join(
        [
            step.get("system_prompt") or "",
            " ".join(str(m.get("content", "")) for m in step.get("input_messages") or []),
            step.get("name") or "",
        ]
    ).lower()
    for label, pat in FAMILY_HINTS:
        if re.search(pat, hay):
            return label
    return "general"


def analyze(normalized: dict, codebase: str | None) -> dict:
    steps = normalized.get("steps", [])
    families = defaultdict(lambda: {"steps": [], "models": set(), "cost_usd": 0.0, "n": 0})
    mapped = []
    for step in steps:
        cls = classify_step(step, steps)
        fam = infer_family(step)
        evaluator = pick_evaluator(step, cls)
        risk = (
            "high"
            if HIGH_RISK.search(
                (step.get("system_prompt") or "")
                + (step.get("name") or "")
                + " ".join(str(m.get("content", "")) for m in step.get("input_messages") or [])
            )
            else "normal"
        )
        entry = {
            "step_id": step.get("step_id"),
            "order": step.get("order"),
            "name": step.get("name"),
            "kind": step.get("kind"),
            "model": step.get("model"),
            "family": fam,
            "replay_mode": cls["replay_mode"],
            "evaluator": evaluator,
            "risk": risk,
            "accepted": step.get("success", {}).get("accepted", True),
            "cost_usd": step.get("cost_usd", 0.0),
            "classification": cls,
        }
        mapped.append(entry)
        f = families[fam]
        f["steps"].append(step.get("step_id"))
        if step.get("model"):
            f["models"].add(step.get("model"))
        f["cost_usd"] += step.get("cost_usd", 0.0)
        f["n"] += 1

    fam_out = {
        k: {
            "n": v["n"],
            "models": sorted(v["models"]),
            "cost_usd": round(v["cost_usd"], 6),
            "steps": v["steps"],
        }
        for k, v in families.items()
    }

    return {
        "source_format": normalized.get("source_format"),
        "codebase": codebase,
        "total_steps": len(steps),
        "total_cost_usd": round(sum(s.get("cost_usd", 0.0) for s in steps), 6),
        "e2e_steps": sum(1 for m in mapped if m["replay_mode"] == "e2e"),
        "single_shot_steps": sum(1 for m in mapped if m["replay_mode"] == "single_shot"),
        "task_families": fam_out,
        "steps": mapped,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("normalized")
    ap.add_argument("--codebase")
    ap.add_argument("--out")
    args = ap.parse_args()

    result = analyze(load_json(args.normalized), args.codebase)
    eprint(
        f"steps: {result['total_steps']}  single-shot: {result['single_shot_steps']}  "
        f"e2e: {result['e2e_steps']}  families: {len(result['task_families'])}"
    )
    for fam, info in result["task_families"].items():
        eprint(f"  - {fam}: {info['n']} steps, models={info['models']}")
    if args.out:
        dump_json(result, args.out)
        eprint(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
