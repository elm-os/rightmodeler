# Vercel AI Gateway reference

## Read the live API docs first (mandatory)

- [AI Gateway](https://vercel.com/docs/ai-gateway)
- [OpenAI Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions)
- [REST API](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)
- [Usage and billing](https://vercel.com/docs/ai-gateway/observability-and-spend/usage)
- [Authentication and BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok)

Fetch these before any call to Vercel AI Gateway; this file is a snapshot dated July
22, 2026, and the live docs win on any conflict.

## Base URL, auth, and environment

Base URL: `https://ai-gateway.vercel.sh/v1`. Chat: `POST /chat/completions`. Auth:
`Authorization: Bearer $AI_GATEWAY_API_KEY`.

Required setup:

```env
RIGHTMODELER_PROVIDER=vercel-ai-gateway
AI_GATEWAY_API_KEY=...
```

Vercel also documents OIDC authentication, but rightmodeler does not read
`VERCEL_OIDC_TOKEN`.

## Model catalog and slugs

Discover models at run time with unauthenticated `GET /models`; the scripts consume
`data[]`. Request slugs use `creator/model-name` (illustrative example:
`anthropic/claude-opus-4.8`). The scripts use `id`, map `context_window` to
`context_length`, and map `pricing.input` / `pricing.output` to normalized
`pricing.prompt` / `pricing.completion`.

They also consume `type`, `released` or `created`, `tags`, and any existing
`supported_parameters`. The provider's endpoint-detail API exposes richer per-endpoint
data, but the scripts do not call it.

## Cost semantics

The implemented fallback chain is:

1. response `usage.cost`, when present;
2. `GET /generation?id=<response-id>` up to three times, using `total_cost`;
3. response token counts multiplied by the model catalog's base input/output prices.

The first two set `cost_is_estimate=false`; the catalog fallback sets it to `true`.
An estimate can omit tiered pricing, cache charges, web search, and surcharges, and can
be zero when the model or prices cannot be resolved. For BYOK generations, Vercel says
`upstream_inference_cost` is outside `total_cost`; the implementation ignores that
field, so its exact-looking value does not include upstream BYOK spend.

## Structured outputs and tool calling

Chat completions support OpenAI-compatible tools and JSON Schema structured outputs.
For shortlisting, the scripts preserve catalog `supported_parameters` and augment it
from tags: `tool-use` adds `tools` and `tool_choice`; `structured-output` or
`structured-outputs` adds `structured_outputs`.

The live catalog may omit structured-output capability markers even for models that
support the API feature. In that case rightmodeler cannot discover structured-output
support and will not shortlist the model for a schema-constrained step.

## Limits and quirks

- The client does not send `seed` on this route.
- `/models` needs no auth; `/credits` and `/generation` do.
- The client retries `402`, `429`, `500`, `502`, and `503` with exponential backoff,
  up to four attempts.
- Generation records can appear shortly after completion. The three immediate lookup
  attempts may therefore fall through to an estimate.
- The live pages do not publish a single numeric inference rate limit; handle `429`
  rather than copying a fixed cap.

## Preflight and troubleshooting

`preflight.py` selects Vercel AI Gateway, reports the key source, calls `/credits` and
prints `balance` plus `total_used`, fetches `/models`, and requires at least three
resolvable language-model families for neutral judge selection.

| Message / symptom                                            | Fix                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `missing required environment variables: AI_GATEWAY_API_KEY` | Set the API key in the process environment or project `.env`; OIDC alone is not implemented.      |
| `401`                                                        | Replace the missing or invalid AI Gateway API key.                                                |
| `402`                                                        | Replenish credits or resolve the key's spend quota.                                               |
| `429`                                                        | Back off and reduce concurrency.                                                                  |
| `could not reach vercel-ai-gateway account endpoint`         | Check `/credits`, network access, key validity, and balance.                                      |
| `catalog has only N resolvable model families`               | Restore catalog access to at least three creator families or provide an explicit `--judge-model`. |
