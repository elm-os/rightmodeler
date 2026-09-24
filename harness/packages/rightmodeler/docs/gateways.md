# Gateways

Rightmodeler replays and judges through any OpenAI-compatible base URL, so a gateway in front of your models can be the replay route. This guide covers open-source gateways verified at pinned releases.

## What a replay route needs

- `--base-url` is the gateway's OpenAI-compatible root, ending in `/v1`, and `--api-key-env` names the variable holding the key the gateway expects.
- The gateway's `/v1/models` lists the replay models. When it lists ids without prices or capabilities, pass `--catalog-reference` with the upstream's public model list; see [Catalogs without pricing or capabilities](getting-started.md#catalogs-without-pricing-or-capabilities).
- Headers the gateway reads per request are passed with `--header 'name: value'`; see [Gateways that route by header](getting-started.md#gateways-that-route-by-header).
- The replay route runs no fallbacks, model aliases, response caching or request plugins for the replay models. Rightmodeler never asks a gateway for them, and it checks each replayed response (in Mode B, each response to a step whose model it sets): one that names another model, reports a cache hit, or reports a changed request is left out of the evidence as `attribution_substituted`; see [Which model answered](getting-started.md#which-model-answered).
- Replay latency includes the gateway hop; rightmodeler does not separate the gateway's share.
- Mode B on the cloud backend calls the base URL from a remote sandbox, so it cannot reach a gateway on localhost or a private network. Use the Docker backend for a local gateway.

## Portkey

Verified on the open-source Portkey gateway 1.15.2 (MIT, `portkeyai/gateway:1.15.2`), the latest tagged release as of 2026-09-22. Portkey picks the upstream for each request from two headers and needs no server configuration:

```sh
docker run -d --name portkey -p 127.0.0.1:8787:8787 portkeyai/gateway:1.15.2
npx rightmodeler init --traces ./traces.jsonl --repo . \
  --base-url http://127.0.0.1:8787/v1 --api-key-env AI_GATEWAY_API_KEY \
  --header 'x-portkey-provider: openai' \
  --header 'x-portkey-custom-host: https://ai-gateway.vercel.sh/v1' \
  --max-cost-usd 25
```

- Use the `openai` provider with a custom host for any OpenAI-compatible upstream (Vercel AI Gateway, OpenRouter, a LiteLLM proxy). Portkey's `openrouter` provider rewrites requests and does not serve the model catalog.
- `--api-key-env` holds the upstream's key: Portkey forwards `Authorization` to the upstream and has no key of its own.
- The catalog, per-call cost, and rate-limit and credit errors come from the upstream through Portkey unchanged.
- Rightmodeler sends no `x-portkey-config`, so fallbacks, load balancing, retries, caching and guardrail or mutator hooks stay off. If you pass one with `--header`, a replayed response whose model differs (`override_params`, targets), that reports `x-portkey-cache-status: HIT`, or whose hook results show `transformed: true` is left out as `attribution_substituted`.
- Bind the container to 127.0.0.1, or start it headless (`docker run ... portkeyai/gateway:1.15.2 run start:node -- --headless`): the 1.15.2 console and live log stream are served without authentication and show provider keys.
- Portkey 1.15.2 keeps no traces or logs that rightmodeler can read. Export traces from your application: OpenTelemetry GenAI, AI SDK telemetry, or the OpenAI SDK JSONL shape.
