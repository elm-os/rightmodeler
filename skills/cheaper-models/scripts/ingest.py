"""Ingest agent trace logs and normalize them into the common step schema.

Supports (autodetected): Claude Code JSONL, Codex CLI JSONL, OpenAI JSONL,
LangSmith run-tree JSON, OTel GenAI / OpenInference spans (json). Unknown shapes
fall back to a best-effort generic adapter.

CLI:
    python ingest.py <path> --out normalized.json      # normalize
    python ingest.py --detect <path>                   # just print detected format
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from typing import Any

from common import dump_json, eprint, read_jsonl


# --------------------------------------------------------------------------- #
# detection
# --------------------------------------------------------------------------- #
def _sample_records(path: str) -> tuple[list[dict], str]:
    """Return (records, kind) where kind is 'jsonl' or 'json'."""
    files = _expand(path)
    if not files:
        return [], "none"
    first = files[0]
    if first.endswith(".jsonl") or _looks_jsonl(first):
        recs = []
        for f in files:
            recs.extend(read_jsonl(f))
        return recs, "jsonl"
    with open(first) as fh:
        data = json.load(fh)
    return (data if isinstance(data, list) else [data]), "json"


def _expand(path: str) -> list[str]:
    if os.path.isdir(path):
        return sorted(glob.glob(os.path.join(path, "**", "*.json*"), recursive=True))
    if any(ch in path for ch in "*?["):
        return sorted(glob.glob(path, recursive=True))
    return [path] if os.path.exists(path) else []


def _looks_jsonl(path: str) -> bool:
    try:
        with open(path) as f:
            first = f.readline().strip()
            f.readline()
        json.loads(first)
        return True
    except Exception:  # noqa: BLE001
        return False


def detect_format(records: list[dict]) -> str:
    if not records:
        return "unknown"
    r = records[0]
    keys = set(r.keys())
    # Claude Code
    if "parentUuid" in keys or (
        r.get("type") in {"user", "assistant"} and "message" in keys and "sessionId" in keys
    ):
        return "claude_code"
    # Codex
    if keys >= {"timestamp", "type", "payload"} and isinstance(r.get("payload"), dict):
        return "codex_cli"
    # LangSmith run tree
    if "run_type" in keys or {"trace_id", "parent_run_id"} & keys:
        return "langsmith"
    # OpenInference / OTel spans
    attrs = r.get("attributes") or r.get("resource", {})
    if isinstance(attrs, dict):
        akeys = set(attrs.keys())
        if any(k.startswith("gen_ai.") for k in akeys):
            return "otel_genai"
        if any(k.startswith("llm.") or k.startswith("openinference.") for k in akeys):
            return "openinference"
    if "span_id" in keys and "root_span_id" in keys:
        return "braintrust"
    if "observations" in keys or ("traceId" in keys and "usageDetails" in keys):
        return "langfuse"
    # OpenAI JSONL
    if "messages" in keys and ("model" in keys or "response" in keys):
        return "openai_jsonl"
    return "generic"


# --------------------------------------------------------------------------- #
# step factory
# --------------------------------------------------------------------------- #
def _step(order: int, **kw: Any) -> dict:
    base = {
        "step_id": kw.get("step_id", f"s{order}"),
        "parent_id": kw.get("parent_id"),
        "order": order,
        "kind": kw.get("kind", "llm"),
        "name": kw.get("name", ""),
        "model": kw.get("model"),
        "provider": kw.get("provider"),
        "system_prompt": kw.get("system_prompt"),
        "input_messages": kw.get("input_messages", []),
        "available_tools": kw.get("available_tools", []),
        "tool_calls": kw.get("tool_calls", []),
        "output_text": kw.get("output_text"),
        "output_messages": kw.get("output_messages", []),
        "usage": kw.get("usage", {}),
        "cost_usd": kw.get("cost_usd", 0.0),
        "success": kw.get("success", {"status": "ok", "accepted": True, "source_signal": "none"}),
        "metadata": kw.get("metadata", {}),
        "raw": kw.get("raw", {}),
    }
    return base


def _content_to_text(content: Any) -> str | None:
    if content is None or isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") in (None, "text"):
                    parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(p for p in parts if p) or None
    return str(content)


# --------------------------------------------------------------------------- #
# adapters
# --------------------------------------------------------------------------- #
def adapt_claude_code(records: list[dict]) -> list[dict]:
    steps = []
    order = 0
    # index tool_results by tool_use_id (they arrive in later user turns)
    results: dict[str, dict] = {}
    for rec in records:
        msg = rec.get("message") or {}
        for block in msg.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                results[block.get("tool_use_id")] = block
    for rec in records:
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message") or {}
        content = msg.get("content") or []
        text = _content_to_text(content)
        tool_calls = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                res = results.get(block.get("id"), {})
                tool_calls.append(
                    {
                        "id": block.get("id"),
                        "name": block.get("name"),
                        "arguments": block.get("input", {}),
                        "result": {
                            "content": res.get("content"),
                            "is_error": bool(res.get("is_error")),
                        },
                    }
                )
        usage = msg.get("usage") or {}
        steps.append(
            _step(
                order,
                step_id=rec.get("uuid", f"s{order}"),
                parent_id=rec.get("parentUuid"),
                kind="agent" if tool_calls else "llm",
                name=rec.get("type", ""),
                model=msg.get("model"),
                provider="anthropic",
                output_text=text,
                tool_calls=tool_calls,
                usage={
                    "input_tokens": usage.get("input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
                    "cache_write_tokens": usage.get("cache_creation_input_tokens", 0),
                },
                raw=rec,
            )
        )
        order += 1
    return steps


def adapt_codex(records: list[dict]) -> list[dict]:
    steps = []
    order = 0
    model = None
    outputs: dict[str, Any] = {}
    for rec in records:
        payload = rec.get("payload") or {}
        if payload.get("type") == "function_call_output":
            outputs[payload.get("call_id")] = payload.get("output")
        if rec.get("type") in ("session_meta", "turn_context"):
            model = payload.get("model", model)
    for rec in records:
        payload = rec.get("payload") or {}
        ptype = payload.get("type")
        if ptype == "message":
            steps.append(
                _step(
                    order,
                    kind="llm",
                    name="message",
                    model=model,
                    provider=payload.get("model_provider"),
                    input_messages=[
                        {
                            "role": payload.get("role", "assistant"),
                            "content": _content_to_text(payload.get("content")),
                        }
                    ],
                    output_text=_content_to_text(payload.get("content"))
                    if payload.get("role") == "assistant"
                    else None,
                    raw=rec,
                )
            )
            order += 1
        elif ptype == "function_call":
            args = payload.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    pass
            cid = payload.get("call_id")
            steps.append(
                _step(
                    order,
                    kind="tool",
                    name=payload.get("name"),
                    model=model,
                    tool_calls=[
                        {
                            "id": cid,
                            "name": payload.get("name"),
                            "arguments": args,
                            "result": {"content": outputs.get(cid), "is_error": False},
                        }
                    ],
                    raw=rec,
                )
            )
            order += 1
    return steps


def adapt_openai_jsonl(records: list[dict]) -> list[dict]:
    steps = []
    for order, rec in enumerate(records):
        messages = rec.get("messages") or []
        system = next((m.get("content") for m in messages if m.get("role") == "system"), None)
        resp = rec.get("response") or {}
        choice = (resp.get("choices") or [{}])[0]
        out_msg = choice.get("message", {})
        tool_calls = []
        for tc in out_msg.get("tool_calls") or []:
            fn = tc.get("function", {})
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    pass
            tool_calls.append(
                {
                    "id": tc.get("id"),
                    "name": fn.get("name"),
                    "arguments": args,
                    "result": {"content": None, "is_error": False},
                }
            )
        usage = rec.get("usage") or resp.get("usage") or {}
        steps.append(
            _step(
                order,
                kind="agent" if tool_calls else "llm",
                name=rec.get("name", "chat"),
                model=rec.get("model") or resp.get("model"),
                system_prompt=system,
                input_messages=[m for m in messages if m.get("role") != "system"],
                available_tools=[
                    {
                        "name": t.get("function", {}).get("name"),
                        "description": t.get("function", {}).get("description"),
                        "parameters_schema": t.get("function", {}).get("parameters"),
                    }
                    for t in rec.get("tools") or []
                ],
                tool_calls=tool_calls,
                output_text=out_msg.get("content"),
                usage={
                    "input_tokens": usage.get("prompt_tokens", 0),
                    "output_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                },
                raw=rec,
            )
        )
    return steps


def adapt_langsmith(records: list[dict]) -> list[dict]:
    steps = []

    def walk(run: dict, order_ref: list[int]) -> None:
        rt = run.get("run_type", "chain")
        extra = run.get("extra") or {}
        meta = extra.get("metadata") or {}
        inputs = run.get("inputs") or {}
        outputs = run.get("outputs") or {}
        usage = (
            extra.get("token_usage") or (outputs.get("llm_output") or {}).get("token_usage") or {}
        )
        steps.append(
            _step(
                order_ref[0],
                step_id=run.get("id", f"s{order_ref[0]}"),
                parent_id=run.get("parent_run_id"),
                kind={"llm": "llm", "tool": "tool", "retriever": "retriever"}.get(rt, "chain"),
                name=run.get("name", rt),
                model=meta.get("ls_model_name")
                or (extra.get("invocation_params") or {}).get("model"),
                input_messages=inputs.get("messages", [])
                if isinstance(inputs.get("messages"), list)
                else [],
                output_text=_content_to_text(outputs.get("output") or outputs.get("generations")),
                usage={
                    "input_tokens": usage.get("prompt_tokens", 0),
                    "output_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                },
                success={
                    "status": "error" if run.get("error") else "ok",
                    "error": run.get("error"),
                    "accepted": not run.get("error"),
                    "scores": run.get("feedback_stats") or {},
                    "source_signal": "feedback_stats",
                },
                raw=run,
            )
        )
        order_ref[0] += 1
        for child in run.get("child_runs") or []:
            walk(child, order_ref)

    order_ref = [0]
    for run in records:
        walk(run, order_ref)
    return steps


def _unflatten_indexed(attrs: dict) -> dict:
    """Best-effort: collect gen_ai/llm messages from indexed dotted keys."""
    return attrs  # adapters below read known keys directly; kept for clarity


def adapt_spans(records: list[dict], flavor: str) -> list[dict]:
    steps = []
    for order, rec in enumerate(records):
        attrs = rec.get("attributes") or {}
        if flavor == "otel_genai":
            model = attrs.get("gen_ai.request.model") or attrs.get("gen_ai.response.model")
            in_msgs = attrs.get("gen_ai.input.messages") or attrs.get("gen_ai.prompt")
            out_msgs = attrs.get("gen_ai.output.messages") or attrs.get("gen_ai.completion")
            usage = {
                "input_tokens": attrs.get("gen_ai.usage.input_tokens", 0),
                "output_tokens": attrs.get("gen_ai.usage.output_tokens", 0),
            }
            system = attrs.get("gen_ai.system_instructions")
        else:  # openinference
            model = attrs.get("llm.model_name")
            in_msgs = _collect_indexed(attrs, "llm.input_messages")
            out_msgs = _collect_indexed(attrs, "llm.output_messages")
            usage = {
                "input_tokens": attrs.get("llm.token_count.prompt", 0),
                "output_tokens": attrs.get("llm.token_count.completion", 0),
                "total_tokens": attrs.get("llm.token_count.total", 0),
            }
            system = None
        if isinstance(in_msgs, str):
            try:
                in_msgs = json.loads(in_msgs)
            except json.JSONDecodeError:
                in_msgs = [{"role": "user", "content": in_msgs}]
        steps.append(
            _step(
                order,
                kind="llm",
                name=rec.get("name", "chat"),
                model=model,
                system_prompt=system,
                input_messages=in_msgs if isinstance(in_msgs, list) else [],
                output_text=_content_to_text(out_msgs),
                usage=usage,
                raw=rec,
            )
        )
    return steps


def _collect_indexed(attrs: dict, prefix: str) -> list[dict]:
    msgs: dict[int, dict] = {}
    for k, v in attrs.items():
        if not k.startswith(prefix + "."):
            continue
        rest = k[len(prefix) + 1 :]
        try:
            idx = int(rest.split(".", 1)[0])
        except ValueError:
            continue
        m = msgs.setdefault(idx, {})
        if rest.endswith("message.role"):
            m["role"] = v
        elif rest.endswith("message.content"):
            m["content"] = v
    return [msgs[i] for i in sorted(msgs)]


def adapt_generic(records: list[dict]) -> list[dict]:
    steps = []
    for order, rec in enumerate(records):
        steps.append(
            _step(
                order,
                kind="llm",
                name=rec.get("name", "step"),
                model=rec.get("model"),
                input_messages=rec.get("messages") or rec.get("input") or [],
                output_text=_content_to_text(rec.get("output") or rec.get("completion")),
                raw=rec,
            )
        )
    return steps


ADAPTERS = {
    "claude_code": adapt_claude_code,
    "codex_cli": adapt_codex,
    "openai_jsonl": adapt_openai_jsonl,
    "langsmith": adapt_langsmith,
    "otel_genai": lambda r: adapt_spans(r, "otel_genai"),
    "openinference": lambda r: adapt_spans(r, "openinference"),
    "generic": adapt_generic,
}


def normalize(path: str) -> dict:
    records, kind = _sample_records(path)
    fmt = detect_format(records)
    adapter = ADAPTERS.get(fmt, adapt_generic)
    steps = adapter(records)
    return {
        "trace_id": os.path.basename(path.rstrip("/")),
        "source_format": fmt,
        "session_id": None,
        "step_count": len(steps),
        "steps": steps,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--out")
    ap.add_argument("--detect", action="store_true")
    args = ap.parse_args()

    if args.detect:
        records, _ = _sample_records(args.path)
        print(detect_format(records))
        return 0

    result = normalize(args.path)
    eprint(f"detected format: {result['source_format']}  steps: {result['step_count']}")
    if args.out:
        dump_json(result, args.out)
        eprint(f"wrote {args.out}")
    else:
        json.dump(result, sys.stdout, indent=2, default=str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
