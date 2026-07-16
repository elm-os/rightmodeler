"""Shared helpers for the rightmodeler skill scripts."""

from __future__ import annotations

import gzip
import json
import os
import sys
from pathlib import Path
from typing import Any

WORKDIR = Path(".rightmodeler")
ENV_KEY = "OPENROUTER_API_KEY"


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
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                # CloudWatch S3 exports prefix each line with an ISO timestamp:
                # "2026-07-15T12:00:00.000Z {json}"
                if " " in line:
                    try:
                        out.append(json.loads(line.split(" ", 1)[1]))
                    except json.JSONDecodeError:
                        pass
    return out


def _parse_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def resolve_openrouter_key() -> tuple[str | None, str | None]:
    key = os.environ.get(ENV_KEY)
    if key:
        return key, "environment"

    for base in (Path.cwd().resolve(), *Path.cwd().resolve().parents):
        env_path = base / ".env"
        if not env_path.is_file():
            continue
        for line in env_path.read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[7:].strip()
            if "=" not in stripped:
                continue
            name, raw = stripped.split("=", 1)
            if name.strip() != ENV_KEY:
                continue
            key = _parse_env_value(raw)
            if not key:
                break
            os.environ[ENV_KEY] = key
            return key, str(env_path)
    return None, None


def require_api_key() -> str:
    key, _ = resolve_openrouter_key()
    if not key:
        eprint(
            "ERROR: OPENROUTER_API_KEY is not set. Add `OPENROUTER_API_KEY=...` "
            "to your project root `.env` or export it before running rightmodeler."
        )
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
