"""Shared helpers for the rightmodeler skill scripts."""

from __future__ import annotations

import gzip
import json
import os
import sys
from pathlib import Path
from typing import Any

WORKDIR = Path(".rightmodeler")


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


UNTRUSTED_CAP = 24000


def untrusted_block(label: str, text: Any, cap: int = UNTRUSTED_CAP) -> str:
    """Fence outsider-authored trace text so an LLM prompt reads it as inert data.

    `label` must be a caller-owned constant (TASK / REFERENCE / CANDIDATE), never
    trace-derived. The body is capped with a visible truncation marker first, then
    any fence marker the text itself carries is defused, so third-party content
    cannot close the block early and inject instructions.
    """
    body = "" if text is None else str(text)
    if len(body) > cap:
        body = f"{body[:cap]}\n[truncated: {len(body) - cap} more chars]"
    body = body.replace("<<<UNTRUSTED", "<<<-UNTRUSTED")
    body = body.replace("<<<END UNTRUSTED", "<<<-END UNTRUSTED")
    return f"<<<UNTRUSTED {label}>>>\n{body}\n<<<END UNTRUSTED {label}>>>"


_MD_UNSAFE = str.maketrans({"|": "\\|", "`": "'"})


def flatten(text: Any, limit: int = 120) -> str:
    """Collapse trace-derived text to a single capped line.

    Trace `name`, `step_id`, and `model` values are outsider-authored and
    unbounded. A newline lets them break out of whatever row or cell they are
    rendered into; the length lets them flood a view the agent reads back.
    """
    flat = " ".join(str(text if text is not None else "").split())
    return f"{flat[: limit - 1]}…" if len(flat) > limit else flat


def md_text(text: Any, limit: int = 120) -> str:
    """Flatten trace-derived text for interpolation into a Markdown line.

    On top of `flatten`, an unescaped pipe ends a table cell and a stray backtick
    opens a code span the rest of the line inherits. The backtick is replaced
    rather than escaped so the result is also safe inside a code span, which is
    how model ids are rendered. `str.translate` is single-pass, so the escaped
    output cannot be escaped a second time.
    """
    return flatten(text, limit).translate(_MD_UNSAFE)


def _parse_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def resolve_env_var(name: str) -> tuple[str | None, str | None]:
    value = os.environ.get(name)
    if value:
        return value, "environment"

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
            candidate, raw = stripped.split("=", 1)
            if candidate.strip() != name:
                continue
            value = _parse_env_value(raw)
            if not value:
                break
            os.environ[name] = value
            return value, str(env_path)
    return None, None


def require_provider() -> tuple[Any, str]:
    from provider import get_provider

    selected = get_provider()
    try:
        return selected.config, selected.api_key
    finally:
        selected._client.close()


def parse_price(v: Any) -> float:
    """Provider prices are strings or numbers in USD per single token."""
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
    if not model_id or "/" not in model_id:
        return "unknown"
    prefix = model_id.split("/", 1)[0].lower()
    return FAMILY_BY_PREFIX.get(prefix, prefix)
