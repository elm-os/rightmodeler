# LiteLLM proxy reference

## Read the live API docs first (mandatory)

- [Proxy configuration](https://docs.litellm.ai/docs/proxy/configs)
- [Virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys)
- [Cost tracking](https://docs.litellm.ai/docs/proxy/cost_tracking)
- [Health checks](https://docs.litellm.ai/docs/proxy/health)
- [Model management](https://docs.litellm.ai/docs/proxy/model_management)
- [LiteLLM proxy provider](https://docs.litellm.ai/docs/providers/litellm_proxy)
- [Anthropic-compatible messages](https://docs.litellm.ai/docs/anthropic_unified)

Fetch these before any call to a LiteLLM proxy; this file is a snapshot dated July 22,
2026, and the live docs win on any conflict.

## Base URL, auth, and environment

The base URL is the user-operated proxy root from `LITELLM_PROXY_API_BASE`; it is not a
fixed hosted URL. Auth is `Authorization: Bearer $LITELLM_PROXY_API_KEY`. The key can
be a permitted virtual key or other proxy key accepted by that deployment.

Required setup:

```env
RIGHTMODELER_PROVIDER=litellm
LITELLM_PROXY_API_BASE=http://localhost:4000
LITELLM_PROXY_API_KEY=...
```

The URL is illustrative. Do not append `/v1`: the code appends its own versioned and
unversioned paths and only strips a trailing slash.

## Model catalog and slugs

Discover the proxy's configured models at run time with `GET /v1/models`; the scripts
consume `data[]` and use each public `id`. In LiteLLM configuration, that public slug
is operator-defined `model_name`, while `litellm_params.model` is the upstream route.
An illustrative public alias is `support-fast`; aliases need not use `provider/model`
form and multiple deployments may share one alias.

The scripts then call `GET /model/info` and group records by `model_name`. The first
mapping can add per-token prices, context limits, and capability flags; all mappings'
upstream model strings determine a family only when they resolve to the same known
family. If `/model/info` is unavailable, the base catalog still works but enrichment
and neutral-family resolution may not.

## Cost semantics

The authoritative source for rightmodeler is a parseable `x-litellm-response-cost`
response header. If it is absent or invalid, the scripts multiply response prompt and
completion token counts by the enriched catalog prices.

Header cost sets `cost_is_estimate=false`; catalog-derived cost sets it to `true`.
The estimate can be zero when the public response model does not resolve to priced
catalog metadata. Treat the header as LiteLLM's calculated spend, not proof that an
upstream invoice uses the same amount.

## Structured outputs and tool calling

LiteLLM exposes OpenAI-compatible tools and `response_format` when the mapped upstream
route supports them. The scripts detect support only from `/model/info`:
`model_info.supports_function_calling` adds `tools`, and
`model_info.supports_response_schema` adds `structured_outputs`. A missing or forbidden
detail endpoint therefore looks unsupported even when inference succeeds.

The proxy also exposes `/v1/messages` in Anthropic format, including tools and
`tool_choice`, across supported upstream providers.

## Limits and quirks

- Rate, spend, concurrency, retries, routing, and model access are deployment- and
  virtual-key-specific; there is no global LiteLLM proxy cap to copy here.
- The client sends `seed`, but sends no OpenRouter-style strict-provider preference.
  The proxy and upstream decide how unsupported parameters are handled.
- The live docs use both `/v1/model/info` and `/model/info`; the code calls the
  unversioned `/model/info` documented by the model-management API.
- The client retries `402`, `429`, `500`, `502`, and `503` with exponential backoff,
  up to four attempts.

## Preflight and troubleshooting

`preflight.py` calls `/health/readiness`, then `/v1/models` and `/model/info`.
Readiness is an unauthenticated process/database check, so it does not validate the
key by itself. Unlike hosted routes, fewer than three resolvable families produces a
warning and still reports READY; configure mapped judge models or plan an explicit
`--judge-model`.

| Message / symptom                                                                       | Fix                                                                                                                     |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `missing required environment variables: LITELLM_PROXY_API_KEY, LITELLM_PROXY_API_BASE` | Set both values in the process environment or project `.env`.                                                           |
| `404` or doubled `/v1/v1/...` paths                                                     | Set `LITELLM_PROXY_API_BASE` to the proxy root, without `/v1`.                                                          |
| readiness `503`                                                                         | Restore the proxy worker or its configured database.                                                                    |
| `401` / `403` from catalog or chat                                                      | Use a valid key with access to the configured model aliases and metadata endpoints.                                     |
| empty or unenriched catalog                                                             | Configure models in the proxy and permit `/model/info`; include cost, context, capability, and upstream model metadata. |
| `only N resolvable model families`                                                      | Map judge-capable aliases to unambiguous upstream families or pass `--judge-model`.                                     |
