"""Per-step isolated replay: re-send a single-shot step's exact request to a
candidate model via the replay provider and return its output for judging.

Use as a module:
    from replay_step import replay_step
    out = replay_step(orr, step, candidate_model)

Only valid for steps classified 'single_shot' by analyze.py. Multi-step/tool/loop
steps must go through run_pipeline.py.
"""

from __future__ import annotations

import argparse
import json

from common import load_json


def build_messages(step: dict) -> list[dict]:
    msgs: list[dict] = []
    if step.get("system_prompt"):
        msgs.append({"role": "system", "content": step["system_prompt"]})
    for m in step.get("input_messages") or []:
        role = m.get("role", "user")
        if role == "system" and step.get("system_prompt"):
            continue
        content = m.get("content")
        if isinstance(content, list):  # flatten block content to text
            content = "\n".join(
                b.get("text", "") if isinstance(b, dict) else str(b) for b in content
            )
        msgs.append({"role": role, "content": content})
    if not msgs:
        msgs = [{"role": "user", "content": step.get("output_text") or ""}]
    return msgs


def to_openai_tools(step: dict) -> list[dict] | None:
    tools = []
    for t in step.get("available_tools") or []:
        if not t.get("name"):
            continue
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description") or "",
                    "parameters": t.get("parameters_schema")
                    or {"type": "object", "properties": {}},
                },
            }
        )
    return tools or None


def replay_step(
    orr,
    step: dict,
    candidate_model: str,
    runs: int = 1,
    max_tokens: int | None = None,
    base_seed: int = 7,
) -> dict:
    messages = build_messages(step)
    tools = to_openai_tools(step)
    samples = []
    total_cost = 0.0
    cost_is_estimate = False
    for index in range(max(1, runs)):
        seed = base_seed + index
        # Production likely did not sample at zero. Arm 1 stays authoritative for
        # comparability; provider-default extras are the least-wrong dispersion
        # estimate until ingest carries traced sampling parameters.
        temperature = 0.0 if index == 0 else None
        resp = orr.chat(
            candidate_model,
            messages,
            tools=tools,
            temperature=temperature,
            seed=seed,
            max_tokens=max_tokens,
        )
        if resp.get("error"):
            if index == 0:
                return {"model": candidate_model, "error": resp["error"], "samples": samples}
            samples.append(
                {
                    "text": None,
                    "tool_calls": None,
                    "cost": resp.get("cost"),
                    "cost_is_estimate": bool(resp.get("cost_is_estimate")),
                    "served_by": resp.get("model"),
                    "seed": seed,
                    "temperature": temperature,
                    "error": resp["error"],
                }
            )
            continue
        total_cost += resp.get("cost") or 0.0
        cost_is_estimate = cost_is_estimate or bool(resp.get("cost_is_estimate"))
        samples.append(
            {
                "text": resp.get("text"),
                "tool_calls": resp.get("tool_calls"),
                "cost": resp.get("cost"),
                "cost_is_estimate": bool(resp.get("cost_is_estimate")),
                "served_by": resp.get("model"),
                "seed": seed,
                "temperature": temperature,
                "error": None,
            }
        )
    # pick the first sample as representative; caller may inspect all
    rep = samples[0]
    return {
        "model": candidate_model,
        "text": rep["text"],
        "tool_calls": rep["tool_calls"],
        "cost": total_cost / len(samples),
        "cost_is_estimate": cost_is_estimate,
        "runs": len(samples),
        "samples": samples,
        "error": None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("normalized")
    ap.add_argument("--step-id", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--max-tokens", type=int)
    args = ap.parse_args()
    from provider import get_provider

    data = load_json(args.normalized)
    step = next(s for s in data["steps"] if s["step_id"] == args.step_id)
    out = replay_step(
        get_provider(),
        step,
        args.model,
        runs=args.runs,
        max_tokens=args.max_tokens,
        base_seed=args.seed,
    )
    print(json.dumps(out, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
