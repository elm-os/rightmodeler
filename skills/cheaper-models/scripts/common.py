"""Shared helpers for the cheaper-models skill scripts."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

WORKDIR = Path(".cheaper-models")


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


def load_json(path: str | Path) -> Any:
    with open(path) as f:
        return json.load(f)


def dump_json(obj: Any, path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w") as f:
        json.dump(obj, f, indent=2, default=str)


def read_jsonl(path: str | Path) -> list[dict]:
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return out


def require_api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        eprint("ERROR: OPENROUTER_API_KEY is not set. `export OPENROUTER_API_KEY=...`")
        sys.exit(2)
    return key


def parse_price(v: Any) -> float:
    """OpenRouter prices are strings in USD per single token."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# Rough provider->family map for the self-preference-bias check in the judge.
FAMILY_BY_PREFIX = {
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google",
    "x-ai": "xai",
    "meta-llama": "meta",
    "mistralai": "mistral",
    "deepseek": "deepseek",
    "qwen": "qwen",
    "cohere": "cohere",
}


def model_family(model_id: str | None) -> str:
    if not model_id:
        return "unknown"
    prefix = model_id.split("/", 1)[0].lower()
    return FAMILY_BY_PREFIX.get(prefix, prefix)
