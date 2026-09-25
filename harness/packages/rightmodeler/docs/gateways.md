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

## Envoy AI Gateway (Agent Router)

Envoy AI Gateway was renamed Agent Router on 2026-09-09; its resources, `aigw` CLI and images keep their names. Verified on v1.1.0 (Apache 2.0) running standalone with `aigw run` (`envoyproxy/ai-gateway-cli:v1.1.0`); always use a release tag, because the `latest` image follows the development branch.

As a replay route:

- Declare each replay model as an `Exact` `x-ai-eg-model` match under the upstream's own id, one `backendRef`, no `modelNameOverride`, no priority fallback and no `BackendTrafficPolicy` retries on the replay route. A fallback or an override answers with another model, so a replayed response it answers is left out as `attribution_substituted`.
- Raise the Gateway's `ClientTrafficPolicy` `bufferLimit` (Envoy Gateway's 32 KiB default is too small for real prompts) and the route's `timeouts.request` for slow models.
- The gateway lists only the declared ids at `/v1/models`, so pass `--catalog-reference` with the upstream's public list.
- The gateway replaces `Authorization` with the route's key, so `--api-key-env` may name any non-empty variable.

```sh
docker run --rm -p 127.0.0.1:1975:1975 -e AI_GATEWAY_API_KEY \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 \
  -e 'OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES=agent-session-id:session.id,x-rightmodeler-family:rightmodeler.family,x-rightmodeler-replay:rightmodeler.replay' \
  -v "$PWD/aigw.yaml:/config.yaml:ro" envoyproxy/ai-gateway-cli:v1.1.0 run /config.yaml
export AIGW_CLIENT_KEY=unused
npx rightmodeler init --traces ./spans.jsonl --repo . \
  --base-url http://127.0.0.1:1975/v1 --api-key-env AIGW_CLIENT_KEY \
  --catalog-reference https://ai-gateway.vercel.sh/v1/models \
  --header 'x-rightmodeler-replay: 1' --max-cost-usd 25
```

As a trace source, rightmodeler reads the gateway's default OpenInference spans from an OpenTelemetry collector's file export:

- Set `OTEL_EXPORTER_OTLP_ENDPOINT`. Map headers to span attributes with `OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES` as comma-separated `header:attribute` pairs; setting it replaces the default `agent-session-id:session.id`, so repeat that pair.
- Send `agent-session-id` from your application so the steps of one conversation form one ordered run, and `x-rightmodeler-family: <name>` so each call has its family. Send `x-rightmodeler-replay: 1` with rightmodeler's replays (`--header`) so a later export leaves them out.
- Each span's request body gives the model your application asked for and the conversation as sent; the response gives the output; the token counts give usage.
- Failed calls, replay-tagged calls, and calls whose prompt or output the gateway hid (`OPENINFERENCE_HIDE_INPUTS`, `OPENINFERENCE_HIDE_OUTPUTS`) are left out of the corpus with a `trace_steps_excluded` warning that names each reason.
- A span records the model that answered but not whether a priority fallback chose it (a `modelNameOverride` alias looks the same), so a call that fell back is read as an answer to the model your application asked for, with the fallback's output and usage. Keep fallback routes off the traffic you export, or expect those answers among the recorded outputs rightmodeler compares candidates against.
- Steps whose recorded conversation contains tool calls are read but not replayed yet (`recorded_messages_not_replayable`).
- With `AI_GATEWAY_TRACING_SEMCONV=gen_ai`, the spans are read by the OTel GenAI reader instead. Also set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, because that convention records no messages without it and rightmodeler cannot read a span with none. Those spans are grouped by trace (propagate `traceparent` from your client), carry no `response_format` or `tool_choice`, and record images by type only.
- Access logs carry no message content and are not a trace source.

On Kubernetes (Kubernetes 1.32 or newer, Envoy Gateway 1.8.1 or newer, Helm charts `ai-gateway-crds-helm` and `ai-gateway-helm` v1.1.0), the same resources apply; set `OTEL_EXPORTER_OTLP_ENDPOINT` through the `ai-gateway-helm` chart's `extProc.extraEnvVars` and the header mapping through its `controller.spanRequestHeaderAttributes`. Mode B on the cloud backend cannot reach an in-cluster gateway.

## Bifrost

Verified on the open-source Bifrost gateway transports/v2.2.1 (Apache 2.0, `maximhq/bifrost:v2.2.1`); pin the image, because releases arrive weekly. Enterprise features ship in a separate image; this guide uses the open-source one.

As a replay route:

- Model ids are `<provider>/<upstream id>`, for example `vercel/openai/gpt-4o-mini` for Vercel AI Gateway configured as an OpenAI-typed custom provider. Bifrost answers with the upstream id, which rightmodeler accepts as the requested model.
- Set every `compat` flag to `false` in the `client` block: a `client` block that omits them turns them all on, and the compat plugin can drop parameters such as `response_format` while answering 200.
- Configure no key `aliases` or routing rules for replay models; an alias answers with another model and is left out as `attribution_substituted`.
- Pass `--catalog-reference` with the upstream's public list. A custom provider lists ids and context only, with no prices or capabilities, and through Vercel AI Gateway every model carries the same `created` date: Bifrost copies Vercel's `created`, one placeholder for all models, and drops the real `released` date. Rightmodeler ranks judges partly by release date, and the reference's release dates win over the gateway's, so judges rank as they do on Vercel itself instead of the most expensive first. Bifrost's own pricing sheet is not used.
- The billed cost comes from the upstream through Bifrost's `usage.cost.total_cost`.
- Send `x-bf-cache-no-store: true` and `x-bf-dim-rightmodeler: replay` with rightmodeler's replays (`--header`): the first keeps replays out of a semantic cache (a cache hit is still detected and left out), the second tags them so a later log export leaves them out.

```sh
docker volume create bifrost-data
docker create --name bifrost -p 127.0.0.1:8080:8080 -e AI_GATEWAY_API_KEY -v bifrost-data:/app/data maximhq/bifrost:v2.2.1
docker cp config.json bifrost:/app/data/config.json && docker start bifrost
export BIFROST_KEY=unused
npx rightmodeler init --traces ./bifrost-logs.jsonl --repo . \
  --base-url http://127.0.0.1:8080/v1 --api-key-env BIFROST_KEY \
  --catalog-reference https://ai-gateway.vercel.sh/v1/models \
  --header 'x-bf-cache-no-store: true' --header 'x-bf-dim-rightmodeler: replay' \
  --max-cost-usd 25
```

As a trace source, rightmodeler reads Bifrost's own request logs, exported from its management API (add credentials once an admin exists):

```sh
curl -s 'http://127.0.0.1:8080/api/logs?objects=chat_completion,chat_completion_stream&order=asc&limit=1000&offset=0' | jq -r '.logs[].id' \
  | while read -r id; do curl -s "http://127.0.0.1:8080/api/logs/$id"; echo; done > bifrost-logs.jsonl
```

With more than 1000 rows, repeat with `offset=1000`, `2000` and so on, appending (`>>`) to the same file, until a page returns fewer than 1000 rows; `order=asc` keeps earlier pages in place while new calls are logged. Do not pass `roots_only=true`: it hides fallback rows.

- Send `x-bf-session-id` from your application so the steps of one conversation form one ordered run, and `x-bf-dim-rightmodeler-family: <name>` so each call has its family.
- Each row gives the model the application asked for (`provider/model`, or the alias it sent), the conversation as sent (`input_history`), the output (`output_message`), usage, cost, latency and retries.
- Failed calls, answers from a configured fallback, rightmodeler's own replays and calls whose content was not logged are left out of the corpus with a `trace_steps_excluded` warning that names each reason. Steps whose conversation contains tool calls are read but not replayed yet.
- Bifrost's OpenTelemetry plugin export reads through the OTel GenAI reader, but it summarizes messages and loses tool-call ids: use the log export for anything but plain text calls.
- Streamed calls through Mode B are checked on the stream's model and headers only; Bifrost reports a semantic-cache hit only in the response body, so such a hit on a streamed Mode B call is not detected.
- Rightmodeler records every replay's latency through Bifrost, gateway hop included, and does not separate Bifrost's own overhead. Bifrost's published benchmark reports 11 microseconds of overhead on a t3.xlarge at 5,000 requests per second, excluding JSON marshalling and the HTTP call; measure it on your own traffic.
