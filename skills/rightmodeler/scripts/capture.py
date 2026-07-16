"""Capture replayable LLM logs from an app that has no observability setup.

Copy this single stdlib-only file into the user's app and either wrap the
client once at startup:

    from capture import wrap_openai, wrap_anthropic
    client = wrap_openai(OpenAI(), "llm-log.jsonl")          # OpenAI-compatible
    client = wrap_anthropic(Anthropic(), "llm-log.jsonl")    # Anthropic

or log a call explicitly where the request is made:

    from capture import log_call
    resp = client.chat.completions.create(model=m, messages=msgs)
    log_call("llm-log.jsonl", model=m, messages=msgs, response=resp)

Every call appends one JSON line in the OpenAI JSONL shape that `ingest.py`
autodetects as `openai_jsonl`, so after collecting some traffic the log is
directly replayable:

    python ingest.py llm-log.jsonl --out normalized.json

Notes:
- Streaming calls (`stream=True`) are passed through unlogged — there is no
  final response object to serialize. Log those call sites explicitly after
  assembling the full text, or disable streaming while collecting a corpus.
- Sync clients only; for async, call `log_call` yourself after awaiting.
- The log contains full prompts and outputs. Treat it like production data.
"""

from __future__ import annotations

import json
import threading
import uuid
from typing import Any

_LOCK = threading.Lock()


def _plain(obj: Any) -> Any:
    """Best-effort: pydantic model (OpenAI/Anthropic SDKs) → dict, else as-is."""
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json", exclude_none=True)
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    return obj


def log_call(
    path: str,
    model: str,
    messages: list[dict],
    response: Any,
    system: str | None = None,
    tools: list[dict] | None = None,
    name: str | None = None,
    case_id: str | None = None,
) -> None:
    """Append one replayable record. `response` may be an OpenAI or Anthropic
    SDK response object or an already-plain dict.

    `case_id` groups the calls of one logical request/run. Independent calls get
    a fresh id automatically (each is its own case); inside an agent loop, pass
    the request's id on every call so the loop is classified for E2E replay
    instead of being replayed step-by-step."""
    resp = _plain(response)
    if isinstance(resp, dict) and "choices" not in resp:
        if "output" in resp:  # OpenAI Responses API
            resp = _responses_to_openai(resp)
        elif "content" in resp:  # Anthropic Messages API
            resp = _anthropic_to_openai(resp)
    record: dict[str, Any] = {
        "name": name or "chat",
        "case_id": case_id or uuid.uuid4().hex[:12],
        "model": model,
        "messages": ([{"role": "system", "content": system}] if system else [])
        + [_plain(m) for m in messages],
        "response": resp,
    }
    if tools:
        record["tools"] = [_plain(t) for t in tools]
    if isinstance(resp, dict) and resp.get("usage"):
        record["usage"] = resp["usage"]
    line = json.dumps(record, default=str)
    with _LOCK, open(path, "a") as f:
        f.write(line + "\n")


def _anthropic_to_openai(resp: dict) -> dict:
    """Anthropic Messages response → OpenAI chat.completion shape."""
    text_parts, tool_calls = [], []
    for block in resp.get("content") or []:
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            tool_calls.append(
                {
                    "id": block.get("id"),
                    "type": "function",
                    "function": {
                        "name": block.get("name"),
                        "arguments": json.dumps(block.get("input") or {}),
                    },
                }
            )
    message: dict[str, Any] = {"role": "assistant", "content": "\n".join(text_parts) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    usage = resp.get("usage") or {}
    return {
        "model": resp.get("model"),
        "choices": [{"message": message, "finish_reason": resp.get("stop_reason")}],
        "usage": {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        },
    }


def _responses_to_openai(resp: dict) -> dict:
    """OpenAI Responses API response → chat.completion shape."""
    texts, tool_calls = [], []
    for item in resp.get("output") or []:
        if item.get("type") == "message":
            for c in item.get("content") or []:
                if c.get("type") in ("output_text", "text"):
                    texts.append(c.get("text", ""))
        elif item.get("type") == "function_call":
            tool_calls.append(
                {
                    "id": item.get("call_id"),
                    "type": "function",
                    "function": {
                        "name": item.get("name"),
                        "arguments": item.get("arguments") or "{}",
                    },
                }
            )
    message: dict[str, Any] = {"role": "assistant", "content": "\n".join(texts) or None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    usage = resp.get("usage") or {}
    return {
        "model": resp.get("model"),
        "choices": [{"message": message, "finish_reason": resp.get("status")}],
        "usage": {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        },
    }


def wrap_openai(client: Any, path: str) -> Any:
    """Patch an OpenAI(-compatible) client so every chat.completions.create
    (and responses.create, if present) call is logged. Returns the same client."""
    original = client.chat.completions.create

    def create(*args: Any, **kwargs: Any) -> Any:
        resp = original(*args, **kwargs)
        if not kwargs.get("stream"):
            log_call(
                path,
                model=kwargs.get("model", ""),
                messages=kwargs.get("messages") or [],
                response=resp,
                tools=kwargs.get("tools"),
            )
        return resp

    client.chat.completions.create = create

    if hasattr(client, "responses"):
        original_responses = client.responses.create

        def create_response(*args: Any, **kwargs: Any) -> Any:
            resp = original_responses(*args, **kwargs)
            if not kwargs.get("stream"):
                raw_input = kwargs.get("input")
                messages = (
                    raw_input
                    if isinstance(raw_input, list)
                    else [{"role": "user", "content": raw_input or ""}]
                )
                log_call(
                    path,
                    model=kwargs.get("model", ""),
                    messages=messages,
                    response=resp,
                    system=kwargs.get("instructions"),
                    tools=kwargs.get("tools"),
                )
            return resp

        client.responses.create = create_response
    return client


def wrap_anthropic(client: Any, path: str) -> Any:
    """Patch an Anthropic client so every messages.create call is logged.
    Returns the same client."""
    original = client.messages.create

    def create(*args: Any, **kwargs: Any) -> Any:
        resp = original(*args, **kwargs)
        if not kwargs.get("stream"):
            system = kwargs.get("system")
            log_call(
                path,
                model=kwargs.get("model", ""),
                messages=kwargs.get("messages") or [],
                response=resp,
                system=system if isinstance(system, str) else None,
                tools=kwargs.get("tools"),
            )
        return resp

    client.messages.create = create
    return client
