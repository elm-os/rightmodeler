# LiteLLM Proxy harness

## Live docs first

- [LiteLLM Proxy quick start](https://docs.litellm.ai/docs/simple_proxy)
- [Proxy configuration](https://docs.litellm.ai/docs/proxy/configs)
- [Pass-through endpoints](https://docs.litellm.ai/docs/pass_through/vertex_ai)

Fetch the proxy and endpoint pages before acting. Confirm which OpenAI-compatible endpoint the
application uses and which proxy `model_name` aliases are deployed.

## Where the model id is bound

The application sends the proxy alias in the OpenAI-compatible request's `model` field. The proxy
maps that alias through `model_list[].model_name` to `litellm_params.model` and provider settings.

Bind a candidate by request model for the scanned step; do not edit shared proxy configuration
during a replay. Verify proxy logs/provider response and the execution identify the resolved
candidate.

## Correlation forwarding

LiteLLM does not forward client headers upstream by default. When upstream propagation is needed,
set `general_settings.forward_client_headers_to_llm_api: true`; its `x-*` forwarding then includes
`x-rm-step` and `x-rm-call`. The rightmodeler proxy consumes both at its own boundary before the
LiteLLM request.

Configure the OpenAI-compatible client to send both headers per logical call. Keep the call ID
stable across client retries; do not depend on LiteLLM request IDs as a substitute.

## Base URL override

Use `OPENAI_BASE_URL` for an OpenAI-compatible application client and point it at the LiteLLM
proxy's `/v1` root. The proxy itself is started with its own config; provider routes use
`litellm_params.api_base` or provider-specific environment variables.

`LITELLM_PROXY_API_BASE` belongs to rightmodeler's replay-provider configuration, not arbitrary
application SDKs. A client pinned to another endpoint must be rewired for Mode B.

## Side-effect mocking

LiteLLM is a model gateway, not the application tool executor. Replace tools in the calling
framework using that framework's reference. Keep tool schemas in model requests so candidate
behavior remains comparable.

Use recorded tool results keyed by name, canonical arguments, and occurrence. Fail on mismatch,
duplicates, missing results, or any attempted live side effect.

## Entry point

Invoke the application's natural single-case entry while its OpenAI-compatible client targets the
proxy. For a transport-only smoke case, one `POST /v1/chat/completions` or `/v1/responses` request
is the smallest entry.

The application wrapper, not the proxy, must run through tools and return the terminal result.

## Coupling detection

Proxy logs expose model requests, retries, and routing, but cannot alone prove application-level
independence. Inspect the calling framework for tools, loops, branches, memory, and downstream
consumers.

During confirmation compare logical calls before and after LiteLLM routing, tool behavior,
terminal output, and checks. A fallback, changed call sequence, or route divergence fails the case.
