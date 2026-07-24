"""Provider-agnostic model catalog and chat client with cost accounting.

Usage as a module:
    from provider import get_provider
    orr = get_provider()
    models = orr.list_models()
    resp = orr.chat("openai/gpt-4o-mini", messages, tools=..., response_format=...)
    print(resp["text"], resp["cost"], resp["model"])

CLI:
    python provider.py models              # dump catalog as json
    python provider.py account             # provider account info
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, replace
from typing import Any

import httpx

from common import eprint, model_family, parse_price, resolve_env_var


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    base_url: str
    env_key: str
    extra_env: list[str]
    docs: list[str]


OPENROUTER_CONFIG = ProviderConfig(
    name="openrouter",
    base_url="https://openrouter.ai/api/v1",
    env_key="OPENROUTER_API_KEY",
    extra_env=[],
    docs=[
        "https://openrouter.ai/docs/api-reference/overview",
        "https://openrouter.ai/docs/use-cases/usage-accounting",
        "https://openrouter.ai/docs/features/provider-routing",
    ],
)

VERCEL_AI_GATEWAY_CONFIG = ProviderConfig(
    name="vercel-ai-gateway",
    base_url="https://ai-gateway.vercel.sh/v1",
    env_key="AI_GATEWAY_API_KEY",
    extra_env=[],
    docs=[
        "https://vercel.com/docs/ai-gateway",
        "https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions",
        "https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api",
        "https://vercel.com/docs/ai-gateway/observability-and-spend/usage",
        "https://vercel.com/docs/ai-gateway/authentication-and-byok/authentication",
    ],
)

LITELLM_CONFIG = ProviderConfig(
    name="litellm",
    base_url="",
    env_key="LITELLM_PROXY_API_KEY",
    extra_env=["LITELLM_PROXY_API_BASE"],
    docs=[
        "https://docs.litellm.ai/docs/providers/litellm_proxy",
        "https://docs.litellm.ai/docs/proxy/virtual_keys",
        "https://docs.litellm.ai/docs/proxy/cost_tracking",
        "https://docs.litellm.ai/docs/proxy/health",
        "https://docs.litellm.ai/docs/anthropic_unified",
    ],
)


class Provider:
    config: ProviderConfig
    models_path = "/models"
    supports_seed = True

    def __init__(
        self,
        api_key: str | None = None,
        timeout: float = 120.0,
        key_source: str | None = None,
    ):
        config = self.__class__.config
        resolved_key, resolved_source = resolve_env_var(config.env_key)
        key = api_key or resolved_key
        extra = {name: resolve_env_var(name)[0] for name in config.extra_env}
        missing = ([config.env_key] if not key else []) + [
            name for name, value in extra.items() if not value
        ]
        if missing:
            _configuration_error(
                f"{config.name} is missing required environment variables: {', '.join(missing)}"
            )
        base_url = self._base_url(extra)
        if base_url != config.base_url:
            config = replace(config, base_url=base_url)
        self.config = config
        self.api_key = key
        self.key_source = key_source or resolved_source
        headers = {"Authorization": f"Bearer {self.api_key}"}
        headers.update(self._headers())
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers=headers,
        )
        self._catalog: list[dict] | None = None

    def _base_url(self, extra: dict[str, str | None]) -> str:
        return self.config.base_url

    def _headers(self) -> dict[str, str]:
        return {}

    # -- catalog ---------------------------------------------------------
    def list_models(self, refresh: bool = False) -> list[dict]:
        if self._catalog is None or refresh:
            r = self._client.get(self.models_path)
            r.raise_for_status()
            self._catalog = self._normalize_catalog(r.json()["data"])
        return self._catalog

    def _normalize_catalog(self, models: list[dict]) -> list[dict]:
        return models

    def model_info(self, model_id: str) -> dict | None:
        for m in self.list_models():
            if m["id"] == model_id or m.get("canonical_slug") == model_id:
                return m
        # apps often log bare model names ("claude-sonnet-5"); resolve when unambiguous
        suffix = [m for m in self.list_models() if m["id"].split("/", 1)[-1] == model_id]
        if len(suffix) == 1:
            return suffix[0]
        return None

    def model_family(self, model_id: str | None) -> str:
        if not model_id:
            return "unknown"
        info = self.model_info(model_id)
        resolved_id = (info or {}).get("canonical_slug") or (info or {}).get("id") or model_id
        return model_family(resolved_id)

    def price_per_token(self, model_id: str) -> tuple[float, float]:
        """(prompt, completion) USD per token; (0,0) if unknown."""
        m = self.model_info(model_id)
        if not m:
            return (0.0, 0.0)
        p = m.get("pricing", {})
        return (parse_price(p.get("prompt")), parse_price(p.get("completion")))

    def account_info(self) -> dict:
        self.list_models(refresh=True)
        return {}

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
        {text, tool_calls, model, cost, cost_is_estimate, usage, raw, error}
        Never raises on model/HTTP errors — returns {"error": ...} so the
        orchestrator can record a failed candidate and move on.
        """
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if seed is not None and self.supports_seed:
            body["seed"] = seed
        if max_tokens:
            body["max_tokens"] = max_tokens
        if tools:
            body["tools"] = tools
            body["tool_choice"] = tool_choice or "auto"
        if response_format:
            body["response_format"] = response_format
        self._apply_provider_preferences(body, require_parameters)
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
            if (
                r.status_code in (404, 503)
                and body.get("provider", {}).get("require_parameters")
                and "no endpoints found" in r.text.lower()
            ):
                # OpenRouter can reject strict parameter routing when no endpoint
                # advertises every supplied parameter. Drop the preference and retry.
                body.pop("provider")
                last_err = f"HTTP {r.status_code} with require_parameters: {r.text[:200]}"
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
            return self._normalize(data, r.headers)
        return {"error": f"exhausted retries: {last_err}", "model": model}

    def _apply_provider_preferences(self, body: dict[str, Any], require_parameters: bool) -> None:
        return None

    def _normalize(self, data: dict, headers: Any) -> dict:
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
        cost, cost_is_estimate = self._cost(data, headers)
        return {
            "text": msg.get("content"),
            "tool_calls": tool_calls,
            "model": data.get("model"),  # what actually served the request
            "cost": cost,
            "cost_is_estimate": cost_is_estimate,
            "usage": usage,
            "finish_reason": choice.get("finish_reason"),
            "raw": data,
            "error": None,
        }

    def _cost(self, data: dict, headers: Any) -> tuple[float, bool]:
        return self._estimate_cost(data), True

    def _estimate_cost(self, data: dict) -> float:
        prompt_price, completion_price = self.price_per_token(data.get("model") or "")
        usage = data.get("usage", {}) or {}
        return (usage.get("prompt_tokens") or 0) * prompt_price + (
            usage.get("completion_tokens") or 0
        ) * completion_price


class OpenRouterProvider(Provider):
    config = OPENROUTER_CONFIG

    def _headers(self) -> dict[str, str]:
        return {
            "HTTP-Referer": "https://github.com/elm-os/rightmodeler",
            "X-Title": "rightmodeler",
        }

    def _apply_provider_preferences(self, body: dict[str, Any], require_parameters: bool) -> None:
        if require_parameters:
            body["provider"] = {"require_parameters": True}

    def account_info(self) -> dict:
        r = self._client.get("/key")
        r.raise_for_status()
        return r.json().get("data", r.json())

    def _cost(self, data: dict, headers: Any) -> tuple[float, bool]:
        usage = data.get("usage", {}) or {}
        if "cost" in usage:
            return parse_price(usage["cost"]), False
        return self._estimate_cost(data), True


class VercelAIGatewayProvider(Provider):
    config = VERCEL_AI_GATEWAY_CONFIG
    supports_seed = False

    def _normalize_catalog(self, models: list[dict]) -> list[dict]:
        normalized = []
        tag_parameters = {
            "reasoning": ["reasoning"],
            "tool-use": ["tools", "tool_choice"],
            "structured-output": ["structured_outputs"],
            "structured-outputs": ["structured_outputs"],
        }
        for model in models:
            item = dict(model)
            pricing = dict(item.get("pricing") or {})
            if "input" in pricing:
                pricing["prompt"] = pricing["input"]
            if "output" in pricing:
                pricing["completion"] = pricing["output"]
            supported = list(item.get("supported_parameters") or [])
            for tag in item.get("tags") or []:
                for parameter in tag_parameters.get(tag, []):
                    if parameter not in supported:
                        supported.append(parameter)
            item["pricing"] = pricing
            item["context_length"] = item.get("context_window")
            item["supported_parameters"] = supported
            normalized.append(item)
        return normalized

    def _cost(self, data: dict, headers: Any) -> tuple[float, bool]:
        usage = data.get("usage", {}) or {}
        if usage.get("cost") is not None:
            return usage["cost"], False
        generation_id = data.get("id")
        if generation_id:
            for attempt in range(3):
                try:
                    r = self._client.get("/generation", params={"id": generation_id})
                    if r.status_code == 200:
                        generation = r.json().get("data", r.json())
                        if generation.get("total_cost") is not None:
                            return parse_price(generation["total_cost"]), False
                except (httpx.HTTPError, ValueError):
                    pass
                if attempt < 2:
                    time.sleep(0.1)
        return self._estimate_cost(data), True

    def account_info(self) -> dict:
        r = self._client.get("/credits")
        r.raise_for_status()
        return r.json()


class LiteLLMProvider(Provider):
    config = LITELLM_CONFIG
    models_path = "/v1/models"

    def _base_url(self, extra: dict[str, str | None]) -> str:
        return (extra["LITELLM_PROXY_API_BASE"] or "").rstrip("/")

    def list_models(self, refresh: bool = False) -> list[dict]:
        if self._catalog is None or refresh:
            r = self._client.get(self.models_path)
            r.raise_for_status()
            models = r.json()["data"]
            details: list[dict] = []
            info = self._client.get("/model/info")
            if info.status_code == 200:
                details = info.json().get("data", [])
            self._catalog = self._enrich_catalog(models, details)
        return self._catalog

    def _enrich_catalog(self, models: list[dict], details: list[dict]) -> list[dict]:
        details_by_name: dict[str, list[dict]] = {}
        for detail in details:
            if detail.get("model_name"):
                details_by_name.setdefault(detail["model_name"], []).append(detail)
        normalized = []
        for model in models:
            item = dict(model)
            mapped = details_by_name.get(item.get("id"), [])
            info = (mapped[0].get("model_info") or {}) if mapped else {}
            upstream_models = [detail.get("litellm_params", {}).get("model") for detail in mapped]
            families = {model_family(model_id) for model_id in upstream_models}
            item["resolved_family"] = (
                next(iter(families))
                if upstream_models and "unknown" not in families and len(families) == 1
                else "unknown"
            )
            pricing = dict(item.get("pricing") or {})
            if info.get("input_cost_per_token") is not None:
                pricing["prompt"] = info["input_cost_per_token"]
            if info.get("output_cost_per_token") is not None:
                pricing["completion"] = info["output_cost_per_token"]
            supported = list(item.get("supported_parameters") or [])
            if info.get("supports_function_calling") and "tools" not in supported:
                supported.append("tools")
            if info.get("supports_response_schema") and "structured_outputs" not in supported:
                supported.append("structured_outputs")
            item["pricing"] = pricing
            item["context_length"] = (
                info.get("max_input_tokens")
                or info.get("max_tokens")
                or item.get("max_input_tokens")
                or item.get("max_tokens")
                or item.get("context_length")
            )
            item["supported_parameters"] = supported
            normalized.append(item)
        return normalized

    def model_family(self, model_id: str | None) -> str:
        if not model_id:
            return "unknown"
        info = self.model_info(model_id)
        return (info or {}).get("resolved_family") or "unknown"

    def account_info(self) -> dict:
        readiness = self._client.get("/health/readiness")
        readiness.raise_for_status()
        models = self.list_models(refresh=True)
        return {"readiness": readiness.json(), "model_count": len(models)}

    def _cost(self, data: dict, headers: Any) -> tuple[float, bool]:
        value = headers.get("x-litellm-response-cost")
        if value is not None:
            try:
                return float(value), False
            except (TypeError, ValueError):
                pass
        return self._estimate_cost(data), True


PROVIDER_TYPES = {
    "openrouter": OpenRouterProvider,
    "vercel-ai-gateway": VercelAIGatewayProvider,
    "litellm": LiteLLMProvider,
}


def _configuration_error(reason: str | None = None) -> None:
    if reason:
        eprint(f"ERROR: {reason}.")
    else:
        eprint("ERROR: no rightmodeler replay provider is configured.")
    eprint("Configure one of:")
    for provider_type in PROVIDER_TYPES.values():
        config = provider_type.config
        variables = " + ".join([config.env_key, *config.extra_env])
        eprint(f"  {config.name}: {variables}")
        for url in config.docs:
            eprint(f"    {url}")
    eprint(
        "Set RIGHTMODELER_PROVIDER to openrouter, vercel-ai-gateway, or litellm "
        "to choose explicitly."
    )
    sys.exit(2)


def _resolved_setup(config: ProviderConfig) -> tuple[str | None, str | None, bool]:
    key, source = resolve_env_var(config.env_key)
    extras_ready = all(resolve_env_var(name)[0] for name in config.extra_env)
    return key, source, extras_ready


def get_provider(name: str | None = None) -> Provider:
    explicit_name = name or resolve_env_var("RIGHTMODELER_PROVIDER")[0]
    if explicit_name:
        provider_type = PROVIDER_TYPES.get(explicit_name)
        if provider_type is None:
            _configuration_error(f"unknown RIGHTMODELER_PROVIDER value: {explicit_name}")
        key, source, extras_ready = _resolved_setup(provider_type.config)
        if not key or not extras_ready:
            missing = [provider_type.config.env_key, *provider_type.config.extra_env]
            missing = [variable for variable in missing if not resolve_env_var(variable)[0]]
            _configuration_error(
                f"{explicit_name} is missing required environment variables: {', '.join(missing)}"
            )
        return provider_type(api_key=key, key_source=source)

    detected = []
    for provider_type in PROVIDER_TYPES.values():
        key, source, extras_ready = _resolved_setup(provider_type.config)
        if key and extras_ready:
            detected.append((provider_type, key, source))
    if not detected:
        _configuration_error()
    if len(detected) > 1:
        eprint(
            f"[info] multiple replay providers configured; using {detected[0][0].config.name}. "
            "Set RIGHTMODELER_PROVIDER to override."
        )
    provider_type, key, source = detected[0]
    return provider_type(api_key=key, key_source=source)


def _main(argv: list[str]) -> int:
    orr = get_provider()
    cmd = argv[0] if argv else "models"
    if cmd == "models":
        json.dump(orr.list_models(), sys.stdout, indent=2)
    elif cmd in ("account", "key"):
        json.dump(orr.account_info(), sys.stdout, indent=2)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
