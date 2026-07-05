"""Minimal OpenRouter client: model catalog + chat completions with cost accounting.

Usage as a module:
    from openrouter import OpenRouter
    orr = OpenRouter()
    models = orr.list_models()
    resp = orr.chat("openai/gpt-4o-mini", messages, tools=..., response_format=...)
    print(resp["text"], resp["cost"], resp["model"])

CLI:
    python openrouter.py models              # dump catalog as json
    python openrouter.py key                 # credits / key info
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any

import httpx

from common import parse_price, require_api_key

BASE = "https://openrouter.ai/api/v1"


class OpenRouter:
    def __init__(self, api_key: str | None = None, timeout: float = 120.0):
        self.api_key = api_key or require_api_key()
        self._client = httpx.Client(
            base_url=BASE,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "HTTP-Referer": "https://github.com/cheaper-models",
                "X-Title": "cheaper-models",
            },
        )
        self._catalog: list[dict] | None = None

    # -- catalog ---------------------------------------------------------
    def list_models(self, refresh: bool = False) -> list[dict]:
        if self._catalog is None or refresh:
            r = self._client.get("/models")
            r.raise_for_status()
            self._catalog = r.json()["data"]
        return self._catalog

    def model_info(self, model_id: str) -> dict | None:
        for m in self.list_models():
            if m["id"] == model_id or m.get("canonical_slug") == model_id:
                return m
        return None

    def price_per_token(self, model_id: str) -> tuple[float, float]:
        """(prompt, completion) USD per token; (0,0) if unknown."""
        m = self.model_info(model_id)
        if not m:
            return (0.0, 0.0)
        p = m.get("pricing", {})
        return (parse_price(p.get("prompt")), parse_price(p.get("completion")))

    def key_info(self) -> dict:
        r = self._client.get("/key")
        r.raise_for_status()
        return r.json().get("data", r.json())

    # -- inference -------------------------------------------------------
    def chat(
        self,
        model: str,
        messages: list[dict],
        tools: list[dict] | None = None,
        tool_choice: Any | None = None,
        response_format: dict | None = None,
        temperature: float = 0.0,
        seed: int | None = 7,
        max_tokens: int | None = None,
        require_parameters: bool = True,
        extra: dict | None = None,
        max_retries: int = 4,
    ) -> dict:
        """Returns a normalized dict:
        {text, tool_calls, model, cost, usage, raw, error}
        Never raises on model/HTTP errors — returns {"error": ...} so the
        orchestrator can record a failed candidate and move on.
        """
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if seed is not None:
            body["seed"] = seed
        if max_tokens:
            body["max_tokens"] = max_tokens
        if tools:
            body["tools"] = tools
            body["tool_choice"] = tool_choice or "auto"
        if response_format:
            body["response_format"] = response_format
        if require_parameters:
            body["provider"] = {"require_parameters": True}
        if extra:
            body.update(extra)

        backoff = 1.0
        last_err = None
        for attempt in range(max_retries):
            try:
                r = self._client.post("/chat/completions", json=body)
            except httpx.HTTPError as e:  # network
                last_err = str(e)
                time.sleep(backoff)
                backoff *= 2
                continue
            if r.status_code in (429, 402, 500, 502, 503):
                last_err = f"HTTP {r.status_code}: {r.text[:200]}"
                time.sleep(backoff)
                backoff *= 2
                continue
            if r.status_code >= 400:
                return {"error": f"HTTP {r.status_code}: {r.text[:300]}", "model": model}
            data = r.json()
            if "error" in data:
                return {"error": str(data["error"]), "model": model}
            return self._normalize(data)
        return {"error": f"exhausted retries: {last_err}", "model": model}

    @staticmethod
    def _normalize(data: dict) -> dict:
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message", {}) or {}
        usage = data.get("usage", {}) or {}
        tool_calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function", {})
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    pass
            tool_calls.append({"id": tc.get("id"), "name": fn.get("name"), "arguments": args})
        return {
            "text": msg.get("content"),
            "tool_calls": tool_calls,
            "model": data.get("model"),  # what actually served the request
            "cost": usage.get("cost", 0.0),
            "usage": usage,
            "finish_reason": choice.get("finish_reason"),
            "raw": data,
            "error": None,
        }


def _main(argv: list[str]) -> int:
    orr = OpenRouter()
    cmd = argv[0] if argv else "models"
    if cmd == "models":
        json.dump(orr.list_models(), sys.stdout, indent=2)
    elif cmd == "key":
        json.dump(orr.key_info(), sys.stdout, indent=2)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
