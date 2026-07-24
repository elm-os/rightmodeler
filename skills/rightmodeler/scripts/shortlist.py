"""Shortlist candidate cheaper models from the replay provider catalog for a given step.

A candidate qualifies if it:
  - supports the capabilities the step needs (tools / structured_outputs),
  - has enough context length,
  - costs strictly less than the current model (by a blended per-token estimate).

CLI:
    python shortlist.py --current openai/gpt-4o --need-tools --min-context 32000 --top 5
"""

from __future__ import annotations

import argparse
import json
import sys

from common import eprint, parse_price
from provider import Provider, get_provider


def blended_price(pricing: dict, in_out_ratio: float = 3.0) -> float:
    """Weighted $/token assuming ~in_out_ratio prompt tokens per completion token."""
    p = parse_price(pricing.get("prompt"))
    c = parse_price(pricing.get("completion"))
    return (in_out_ratio * p + c) / (in_out_ratio + 1)


def shortlist(
    orr: Provider,
    current_model: str,
    need_tools: bool = False,
    need_structured: bool = False,
    min_context: int = 0,
    top: int = 5,
    allow: list[str] | None = None,
    deny: list[str] | None = None,
    exclude_free: bool = True,
) -> list[dict]:
    catalog = orr.list_models()
    cur = orr.model_info(current_model)
    if cur is None:
        raise ValueError(
            f"current model {current_model!r} was not found in the provider catalog; "
            "pass --current with an exact catalog model ID or canonical slug"
        )

    candidates = []
    for model in catalog:
        model_type = model.get("type")
        if model_type and model_type != "language":
            continue
        output_modalities = (model.get("architecture") or {}).get("output_modalities") or []
        if output_modalities and "text" not in output_modalities:
            continue
        candidates.append(model)

    has_structured_markers = any(
        "structured_outputs" in (model.get("supported_parameters") or []) for model in catalog
    )
    if need_structured and not has_structured_markers:
        eprint(
            "[warn] structured-output support could not be verified from this catalog; "
            "keeping candidates"
        )

    cur_price = blended_price(cur["pricing"])

    out = []
    for m in candidates:
        mid = m["id"]
        if mid == current_model:
            continue
        if allow and mid not in allow:
            continue
        if deny and mid in deny:
            continue
        if exclude_free and mid.endswith(":free"):
            continue
        supported = set(m.get("supported_parameters") or [])
        if need_tools and "tools" not in supported:
            continue
        if need_structured and has_structured_markers and "structured_outputs" not in supported:
            continue
        if min_context and (m.get("context_length") or 0) < min_context:
            continue
        price = blended_price(m.get("pricing", {}))
        if price <= 0:  # unknown/free pricing — skip for fair cost comparison
            continue
        if price >= cur_price:
            continue
        savings = 1 - (price / cur_price) if cur_price not in (0, float("inf")) else None
        out.append(
            {
                "id": mid,
                "name": m.get("name"),
                "blended_price": price,
                "context_length": m.get("context_length"),
                "supports_tools": "tools" in supported,
                "supports_structured": "structured_outputs" in supported,
                "est_savings_vs_current": savings,
            }
        )

    out.sort(key=lambda x: x["blended_price"])
    if len(out) <= top or top <= 1:
        return out[:top]
    # spread picks across the price range below the current model: the absolute
    # cheapest models usually fail the quality floor, and viable swaps often sit
    # mid-range — cheapest-N would never test them
    idxs = sorted({round(i * (len(out) - 1) / (top - 1)) for i in range(top)})
    return [out[i] for i in idxs]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--current", required=True)
    ap.add_argument("--need-tools", action="store_true")
    ap.add_argument("--need-structured", action="store_true")
    ap.add_argument("--min-context", type=int, default=0)
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--allow", nargs="*")
    ap.add_argument("--deny", nargs="*")
    args = ap.parse_args()

    orr = get_provider()
    res = shortlist(
        orr,
        args.current,
        need_tools=args.need_tools,
        need_structured=args.need_structured,
        min_context=args.min_context,
        top=args.top,
        allow=args.allow,
        deny=args.deny,
    )
    json.dump(res, sys.stdout, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
