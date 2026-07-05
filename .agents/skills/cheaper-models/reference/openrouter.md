# OpenRouter reference

Base URL: `https://openrouter.ai/api/v1` · Auth: `Authorization: Bearer $OPENROUTER_API_KEY`.
OpenAI-compatible — the OpenAI SDK works by setting `base_url` to the above.

## Endpoints we use

| Purpose                      | Call                                    |
| ---------------------------- | --------------------------------------- |
| Chat completion              | `POST /chat/completions`                |
| List models + pricing        | `GET /models`                           |
| Model's provider endpoints   | `GET /models/{author}/{slug}/endpoints` |
| Per-generation cost/stats    | `GET /generation?id=<id>`               |
| Remaining credits / key info | `GET /key`                              |

Model slug: `provider/model`, e.g. `anthropic/claude-opus-4`, `openai/gpt-4o-mini`,
`meta-llama/llama-3.3-70b-instruct`. Suffixes: `:free`, `:nitro` (throughput), `:floor`
(cheapest), `:exacto` (most reliable tool-calling). `~author/model-latest` = newest in family.

## Model listing + shortlisting (`shortlist.py`)

`GET /models` → `{ "data": [ { id, context_length, architecture, pricing, supported_parameters,
top_provider } ] }`. **Pricing is USD per single token as a string** — `"0.00003"` = $0.03/1M
prompt tokens. Multiply directly.

Filter query params: `?supported_parameters=tools` / `=structured_outputs`, `order=pricing-low-to-high`,
`max_price`, `context`. Shortlist logic: keep models that (a) support what the step needs
(tools and/or structured_outputs, enough context_length) and (b) cost strictly less than the
current model per `usage.cost`; test the cheapest N.

## Cost accounting (critical)

`usage` is returned automatically on every response (legacy include-flags are no-ops):

```json
"usage": {
  "prompt_tokens": 194,
  "completion_tokens": 2,
  "total_tokens": 196,
  "cost": 0.00095,                                  // authoritative charge — compare THIS
  "cost_details": { "upstream_inference_cost": 0 }  // BYOK only
}
```

**Compare `usage.cost`, never token counts** — every model uses its own tokenizer.
Audit path: `GET /generation?id=<response.id>` → `total_cost`, native token counts, latency.

## Structured output + tools

Structured output: `response_format: {type:"json_schema", json_schema:{name, strict:true,
schema:{... , additionalProperties:false, required:[...]}}}`. Add `provider.require_parameters:
true` to only route to providers that honor it. Not universal — filter via
`?supported_parameters=structured_outputs`.

Tools: OpenAI-compatible `tools` + `tool_choice` (`auto|none|required|{function}`). Sending
`tools` auto-restricts routing to tool-capable providers. Reliability varies — model pages
expose a Tool Call Error Rate; `:exacto` routes to the most reliable providers. Resend `tools`
every turn.

## Routing, fallbacks, limits

Model fallback: top-level `models: [primary, backup]` — fires on context/moderation/ratelimit/
downtime; **read the response `model` field** to attribute cost to what actually ran. Provider
control: `provider: { order, allow_fallbacks, require_parameters, only, ignore, sort:{by:"price"} }`.

Limits: credit-based + global. `402` = negative balance, `429` = rate limit. Check credits:
`GET /key` → `limit_remaining`, `usage`, `is_free_tier`.

## Gotchas for parallel benchmarking

- Keep concurrency modest; retry-with-backoff on 429/402. Avoid `:free` variants (60 rpm +
  daily caps + downtime) for benchmarking.
- Prompt caching is per-provider (OpenAI auto ≥1024 tok; Anthropic needs direct routing or
  per-block `cache_control`; DeepSeek/Gemini auto) — affects cost comparisons; OpenRouter uses
  provider-sticky routing to maximize cache hits.
- `require_parameters: true` avoids silent capability mismatches that corrupt benchmark results.

Sources: openrouter.ai/docs (quickstart, models, usage-accounting, routing, structured-outputs,
tool-calling, limits, prompt-caching).
