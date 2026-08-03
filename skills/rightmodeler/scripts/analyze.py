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


def _trajectory_key(step: dict) -> tuple[str, object] | None:
    if step.get("trajectory_id") is not None:
        return ("trajectory", step["trajectory_id"])
    if step.get("case_id") is not None:
        return ("case", step["case_id"])
    return None


def _contains_text(value: object, text: str) -> bool:
    if isinstance(value, str):
        return text in value
    if isinstance(value, list):
        return any(_contains_text(item, text) for item in value)
    if isinstance(value, dict):
        return any(_contains_text(item, text) for item in value.values())
    return False


def _consumes_output(producer: dict, consumer: dict) -> bool:
    if producer.get("kind") not in ("llm", "agent"):
        return False
    output = producer.get("output_text")
    if not isinstance(output, str) or not output.strip():
        return False
    return any(
        _contains_text(message.get("content"), output.strip())
        for message in consumer.get("input_messages") or []
        if isinstance(message, dict)
    )


def classify_step(step: dict, steps: list[dict], source_format: str | None = None) -> dict:
    has_tools = bool(step.get("tool_calls"))
    # loop: same node name appears more than once within the same case. Steps from
    # different cases (benchmark corpora set case_id per example) are independent
    # samples of the same step, not loop iterations.
    name = step.get("name")
    case = step.get("case_id")
    repeats = (
        case is not None
        and sum(1 for s in steps if s.get("name") == name and name and s.get("case_id") == case) > 1
    )
    index = next(i for i, candidate in enumerate(steps) if candidate is step)
    trajectory = _trajectory_key(step)
    earlier = [
        s for s in steps[:index] if trajectory is not None and _trajectory_key(s) == trajectory
    ]
    later = [
        s for s in steps[index + 1 :] if trajectory is not None and _trajectory_key(s) == trajectory
    ]
    consumes = any(_consumes_output(producer, step) for producer in earlier)
    feeds = any(_consumes_output(step, consumer) for consumer in later)
    if consumes:
        prefix_provenance = "model_authored"
    elif trajectory is None:
        prefix_provenance = "unknown"
    elif not earlier:
        prefix_provenance = "external"
    elif source_format in ("claude_code", "codex_cli") or not step.get("input_messages"):
        prefix_provenance = "unknown"
    else:
        prefix_provenance = "external"
    multi = has_tools or repeats or feeds or consumes or step.get("kind") in ("agent", "chain")
    return {
        "replay_mode": "e2e" if multi else "single_shot",
        "has_tools": has_tools,
        "in_loop": repeats,
        "feeds_downstream": feeds,
        "prefix_provenance": prefix_provenance,
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
    source_format = normalized.get("source_format")
    families = defaultdict(lambda: {"steps": [], "models": set(), "cost_usd": 0.0, "n": 0})
    mapped = []
    for step in steps:
        cls = classify_step(step, steps, source_format)
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
            "prefix_provenance": cls["prefix_provenance"],
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
