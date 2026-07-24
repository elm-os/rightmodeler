"""Reference-guided LLM-as-judge with bias mitigations.

Compares a candidate (cheap-model) output against the accepted original output.
- Deterministic pre-check for tool calls / structured outputs (no LLM needed when it settles).
- Position-swap: judge both orderings, keep only order-consistent verdicts.
- Cross-family guard: judge must differ in family from both candidates.
- Structured ordinal verdict: equivalent | minor_drift | divergent.

Use as a module:
    from judge import judge_outputs
    verdict = judge_outputs(orr, task, reference, candidate, judge_model=...,
                            candidate_model=..., reference_model=...)
"""

from __future__ import annotations

import argparse
import json

from common import model_family, parse_price

VERDICT_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "verdict",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["equivalent", "minor_drift", "divergent"]},
                "score": {"type": "number"},  # 0..1
                "justification": {"type": "string"},
            },
            "required": ["verdict", "score", "justification"],
            "additionalProperties": False,
        },
    },
}

VERDICT_SCORE = {"equivalent": 1.0, "minor_drift": 0.6, "divergent": 0.0}

SYS = (
    "You are a strict evaluation judge. You are given a TASK, a REFERENCE answer that was "
    "accepted as correct, and a CANDIDATE answer from a cheaper model. Decide whether the "
    "CANDIDATE is a good-enough replacement for the REFERENCE for this task.\n"
    "Judge SEMANTIC equivalence, not wording. Paraphrases and non-conflicting extra detail are fine. "
    "Contradictions, omissions of required content, wrong facts, or broken structure are not.\n"
    "Return: verdict (equivalent | minor_drift | divergent), score 0..1, and a one-line justification. "
    "Do not reward verbosity. Do not favor either answer for its style."
)


def _provider_family(provider, model_id: str | None) -> str:
    resolver = getattr(provider, "model_family", None)
    return resolver(model_id) if resolver else model_family(model_id)


def _signal_percentile(value: float, values: list[float]) -> float:
    ranked = sorted(set(candidate for candidate in values if candidate > 0))
    if value <= 0 or not ranked:
        return 0.0
    return (ranked.index(value) + 1) / len(ranked)


def _strongest(models: list[dict]) -> str:
    signals = []
    for model in models:
        recency = float(model.get("released") or model.get("created") or 0)
        context = float(model.get("context_length") or model.get("context_window") or 0)
        pricing = model.get("pricing") or {}
        price = parse_price(pricing.get("prompt")) + parse_price(pricing.get("completion"))
        signals.append((model["id"], recency, context, price))
    recencies = [item[1] for item in signals]
    contexts = [item[2] for item in signals]
    prices = [item[3] for item in signals]
    return max(
        signals,
        key=lambda item: (
            _signal_percentile(item[1], recencies)
            + _signal_percentile(item[2], contexts)
            + _signal_percentile(item[3], prices),
            item[1],
            item[2],
            item[3],
            item[0],
        ),
    )[0]


def pick_judge(
    provider,
    candidate_model: str | None,
    reference_model: str | None,
    override: str | None = None,
) -> str:
    candidate_family = _provider_family(provider, candidate_model)
    reference_family = _provider_family(provider, reference_model)
    if override:
        if override in (candidate_model, reference_model):
            raise ValueError("--judge-model must differ from the candidate and reference models")
        judge_family = _provider_family(provider, override)
        known_families = {candidate_family, reference_family} - {"unknown"}
        if judge_family != "unknown" and judge_family in known_families:
            raise ValueError("--judge-model must use a neutral third model family")
        return override
    if "unknown" in (candidate_family, reference_family):
        raise ValueError(
            "could not resolve the candidate or reference model family; "
            "provide an explicit --judge-model"
        )

    catalog = provider.list_models()
    has_structured_markers = any(
        "structured_outputs" in (model.get("supported_parameters") or []) for model in catalog
    )
    eligible = []
    for model in catalog:
        model_type = model.get("type")
        if model_type and model_type != "language":
            continue
        output_modalities = (model.get("architecture") or {}).get("output_modalities") or []
        if output_modalities and "text" not in output_modalities:
            continue
        if has_structured_markers and "structured_outputs" not in (
            model.get("supported_parameters") or []
        ):
            continue
        family = _provider_family(provider, model.get("id"))
        if family == "unknown" or family in (candidate_family, reference_family):
            continue
        eligible.append(model)
    if not eligible:
        raise ValueError(
            "no catalog model satisfies the neutral third-family judge rule; "
            "provide an explicit --judge-model"
        )
    return _strongest(eligible)


def _deterministic_toolcheck(
    reference_calls: list[dict], candidate_calls: list[dict]
) -> dict | None:
    """Return a verdict dict if tool calls settle it deterministically, else None."""
    if not reference_calls and not candidate_calls:
        return None
    ref = [(c.get("name"), _canon(c.get("arguments"))) for c in reference_calls]
    cand = [(c.get("name"), _canon(c.get("arguments"))) for c in candidate_calls]
    if ref == cand:
        return {
            "verdict": "equivalent",
            "score": 1.0,
            "justification": "tool calls match exactly (name + normalized args)",
        }
    ref_names = [n for n, _ in ref]
    cand_names = [n for n, _ in cand]
    if ref_names != cand_names:
        return {
            "verdict": "divergent",
            "score": 0.0,
            "justification": f"tool selection differs: {ref_names} vs {cand_names}",
        }
    return None  # same tools, different args → escalate to LLM for semantic arg check


def _canon(args) -> str:
    try:
        return json.dumps(args, sort_keys=True)
    except TypeError:
        return str(args)


def _one_judgement(orr, judge_model, task, first, second, labels) -> dict:
    user = (
        f"TASK:\n{task}\n\n"
        f"{labels[0]}:\n{first}\n\n"
        f"{labels[1]}:\n{second}\n\n"
        f"Which is the REFERENCE and which is the CANDIDATE is indicated by the labels. "
        f"Assess whether CANDIDATE can replace REFERENCE."
    )
    resp = orr.chat(
        judge_model,
        [{"role": "system", "content": SYS}, {"role": "user", "content": user}],
        response_format=VERDICT_SCHEMA,
        temperature=0.0,
    )
    if resp.get("error"):
        return {
            "verdict": "divergent",
            "score": 0.0,
            "justification": f"judge error: {resp['error']}",
        }
    try:
        return json.loads(resp["text"])
    except (json.JSONDecodeError, TypeError):
        return {"verdict": "divergent", "score": 0.0, "justification": "unparseable judge output"}


def judge_outputs(
    orr,
    task: str,
    reference: str,
    candidate: str,
    candidate_model: str | None = None,
    reference_model: str | None = None,
    judge_model: str | None = None,
    reference_tool_calls: list[dict] | None = None,
    candidate_tool_calls: list[dict] | None = None,
) -> dict:
    # 1. deterministic tool pre-check
    det = _deterministic_toolcheck(reference_tool_calls or [], candidate_tool_calls or [])
    if det is not None:
        det["judge"] = "deterministic"
        det["order_consistent"] = True
        return det

    judge_model = pick_judge(
        provider=orr,
        candidate_model=candidate_model,
        reference_model=reference_model,
        override=judge_model,
    )

    # 2. position-swap: judge both orderings
    v1 = _one_judgement(orr, judge_model, task, reference, candidate, ("REFERENCE", "CANDIDATE"))
    v2 = _one_judgement(orr, judge_model, task, candidate, reference, ("CANDIDATE", "REFERENCE"))
    consistent = v1["verdict"] == v2["verdict"]
    score = (
        VERDICT_SCORE.get(v1["verdict"], v1.get("score", 0.0))
        + VERDICT_SCORE.get(v2["verdict"], v2.get("score", 0.0))
    ) / 2
    verdict = v1["verdict"] if consistent else "minor_drift"  # disagreement → hedge
    return {
        "verdict": verdict,
        "score": round(score, 3),
        "justification": v1.get("justification", ""),
        "judge": judge_model,
        "order_consistent": consistent,
        "raw": [v1, v2],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--candidate-model")
    ap.add_argument("--reference-model")
    ap.add_argument("--judge-model")
    args = ap.parse_args()
    from provider import get_provider

    v = judge_outputs(
        get_provider(),
        args.task,
        args.reference,
        args.candidate,
        candidate_model=args.candidate_model,
        reference_model=args.reference_model,
        judge_model=args.judge_model,
    )
    print(json.dumps(v, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
