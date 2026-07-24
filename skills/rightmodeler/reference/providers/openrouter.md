# OpenRouter reference

## Read the live API docs first (mandatory)

- [Quickstart](https://openrouter.ai/docs/quickstart)
- [Models](https://openrouter.ai/docs/guides/overview/models)
- [API reference](https://openrouter.ai/docs/api_reference/overview)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
- [Limits](https://openrouter.ai/docs/api_reference/limits)

Fetch these before any call to OpenRouter; this file is a snapshot dated July 22,
2026, and the live docs win on any conflict.

## Base URL, auth, and environment

Base URL: `https://openrouter.ai/api/v1`. Chat: `POST /chat/completions`. Auth:
`Authorization: Bearer $OPENROUTER_API_KEY`.

Required setup:

```env
RIGHTMODELER_PROVIDER=openrouter
OPENROUTER_API_KEY=...
```

The client also sends rightmodeler's `HTTP-Referer` and `X-Title` attribution headers.

## Model catalog and slugs

Discover models at run time with `GET /models`; the scripts consume `data[]`. Request
slugs are the record's `id` in `author/model` form (illustrative example:
`openai/gpt-5.5`). Variant suffixes such as `:free` may appear. `model_info()` accepts
an exact `id`, an exact `canonical_slug`, or an unambiguous bare suffix; family
resolution prefers `canonical_slug`.

The scripts read `id`, `canonical_slug`, `type`, `context_length`, `architecture`,
`pricing.prompt`, `pricing.completion`, and `supported_parameters`. Catalog pricing is
USD per token; conditional overrides and non-token charges can make it incomplete for
a specific request.

## Cost semantics

The authoritative source is response `usage.cost`, the amount charged by OpenRouter.
The implementation has no fallback: if that field is absent, it records `0.0` and
still sets `cost_is_estimate=false`. Downstream, `false` means the provider value is
treated as exact; it does not prove the field was present. Use `GET /generation?id=...`
for an external audit when needed.

## Structured outputs and tool calling

Chat completions support OpenAI-compatible `tools`, `tool_choice`, and
`response_format.type=json_schema`. Detect model support from catalog
`supported_parameters`: `tools` for tool calling and `structured_outputs` for JSON
Schema output. The client normally sends `provider.require_parameters=true` so routing
only selects endpoints that advertise every supplied parameter.

## Limits and quirks

- Credit exhaustion returns `402`; rate limiting returns `429`. The client retries
  `402`, `429`, `500`, `502`, and `503` with exponential backoff, up to four attempts.
- If strict parameter routing returns `404` or `503` containing "no endpoints found",
  the client removes the provider preference and retries once. OpenRouter may then
  ignore unsupported parameters.
- Attribute the result to response `model`, which is what actually served the call.
- Free-variant and provider-specific limits drift; use the live limits page instead of
  relying on a copied numeric cap.

## Preflight and troubleshooting

`preflight.py` selects OpenRouter, reports the key source, calls `GET /key`, prints
remaining credits, warns on free-tier keys, fetches `/models`, and requires at least
three resolvable language-model families for neutral judge selection.

| Message / symptom                                            | Fix                                                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `missing required environment variables: OPENROUTER_API_KEY` | Set the key in the process environment or project `.env`.                                       |
| `401`                                                        | Replace an invalid, disabled, or missing key.                                                   |
| `402`                                                        | Add credits or raise/wait for the key's credit cap.                                             |
| `429`                                                        | Back off; honor `Retry-After` when present and avoid free variants for a large fleet.           |
| `no endpoints found`                                         | Choose a catalog model advertising the required parameters or allow the built-in relaxed retry. |
| `catalog has only N resolvable model families`               | Restore catalog access to at least three families or provide an explicit `--judge-model`.       |
