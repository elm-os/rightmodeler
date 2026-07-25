"""Append-only run ledger for the rightmodeler agent.

The ledger lives at .rightmodeler/agent/ledger.jsonl, one entry per run,
shaped by packages/contracts/schemas/agent-run-ledger.schema.json. It is the
agent's memory: which (step, candidate) pairs were evaluated at which price,
what the incumbent looked like, what was deferred, and which proposals a
human has already answered.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from common import WORKDIR, read_jsonl

AGENT_DIR = WORKDIR / "agent"
LEDGER_PATH = AGENT_DIR / "ledger.jsonl"
HEARTBEAT_PATH = AGENT_DIR / "heartbeat"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_entries(path: Path = LEDGER_PATH) -> list[dict]:
    if not path.exists():
        return []
    return read_jsonl(path)


def append_entry(entry: dict, path: Path = LEDGER_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, default=str) + "\n")


def touch_heartbeat(path: Path = HEARTBEAT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(utc_now() + "\n", encoding="utf-8")


def next_run_id(entries: list[dict]) -> str:
    return f"run-{len(entries) + 1:04d}"


def evaluated_pairs(entries: list[dict]) -> dict[tuple[str, str], dict]:
    """Latest complete evaluation per (step_id, candidate_model)."""
    pairs: dict[tuple[str, str], dict] = {}
    for entry in entries:
        for ev in entry.get("evaluations", []):
            if ev.get("complete"):
                pairs[(ev["step_id"], ev["candidate_model"])] = ev
    return pairs


def standing_rejections(entries: list[dict]) -> set[tuple[str, str]]:
    """Pairs a human already answered: any proposed or closed PR decision."""
    rejected: set[tuple[str, str]] = set()
    for entry in entries:
        for dec in entry.get("decisions", []):
            if dec.get("decision") in ("proposed", "closed", "merged"):
                rejected.add((dec["step_id"], dec["candidate_model"]))
    return rejected


def deferred_pairs(entries: list[dict]) -> list[dict]:
    """Deferred pairs from the most recent run, minus ones since evaluated."""
    if not entries:
        return []
    evaluated = evaluated_pairs(entries)
    return [
        d
        for d in entries[-1].get("deferred", [])
        if (d["step_id"], d["candidate_model"]) not in evaluated
    ]


def incumbent_history(entries: list[dict]) -> dict[str, dict]:
    """Earliest recorded incumbent per step, for price-rise comparison."""
    first: dict[str, dict] = {}
    for entry in entries:
        for inc in entry.get("incumbents", []):
            first.setdefault(inc["step_id"], inc)
    return first


def summarize(entries: list[dict]) -> dict:
    """Digest counts for status output."""
    outcomes = [e.get("outcome") for e in entries]
    return {
        "runs": len(entries),
        "proposals": outcomes.count("proposal"),
        "abstentions": outcomes.count("abstention"),
        "deferrals": outcomes.count("deferral"),
        "aborts": outcomes.count("abort"),
        "total_spend_usd": round(sum(e.get("spend_usd", 0.0) for e in entries), 6),
        "last_run_at": entries[-1].get("started_at") if entries else None,
        "last_outcome": entries[-1].get("outcome") if entries else None,
        "candidates_checked": sum(len(e.get("evaluations", [])) for e in entries),
    }
