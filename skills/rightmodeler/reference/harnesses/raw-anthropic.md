# Raw Anthropic SDK harness

## Live docs first

- [Messages API](https://platform.claude.com/docs/en/api/messages)
- [Claude Python SDK](https://github.com/anthropics/anthropic-sdk-python)
- [Tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)

Fetch these pages before acting and check the installed SDK version. The live request and tool
schemas override this reference.

## Where the model id is bound

The ID is the `model` argument to `client.messages.create(...)`. Bind the candidate at that call,
or construct a client wrapper whose single responsibility is to substitute the model for one
identified step.

Do not confuse `model` with `max_tokens`, which is independently required. Verify the response's
model field and the recorded execution identify the candidate.

## Correlation forwarding

The SDK does not forward ambient application headers. Use `Anthropic(default_headers={...})` for
client defaults or `extra_headers={...}` in request options where supported by the installed
SDK. Put `x-rm-step` and a fresh `x-rm-call` on every logical Messages call.

Create the logical ID outside transport retry handling so retries keep one ID. Do not derive a
step from URL order or concurrent request order.

## Base URL override

The Python SDK honors `ANTHROPIC_BASE_URL`; `Anthropic(base_url=...)` is the explicit override.
Wire `base_url=os.environ["ANTHROPIC_BASE_URL"]` in a Mode B harness so the routing contract is
visible and testable.

An OpenAI-compatible proxy is not automatically an Anthropic Messages endpoint. Use a proxy
route that implements `/v1/messages`; a pinned `https://api.anthropic.com` blocks Mode B.

## Side-effect mocking

Register the same tool schemas sent in `tools`, but dispatch each returned `tool_use` block to a
trace-backed replacement. Key results by tool name, canonicalized `input`, and occurrence, then
return a `tool_result` block with the original `tool_use_id`.

Preserve ordering when several tool blocks occur in one response. Fail on an unrecorded tool,
argument mismatch, duplicate consumption, or missing result; never call the live implementation.

## Entry point

For a single-shot call, invoke `client.messages.create(...)` once with the recorded system,
messages, tools, and token limit. For a tool loop, expose a one-case function that continues
until the model emits a terminal response and returns the complete block sequence plus text.

The wrapper input should include a case ID, recorded messages, and recorded tool results. Its
output must be machine-readable and include the terminal result.

## Coupling detection

Treat any `tool_use`, reused message history, prompt-caching prefix, or downstream consumer of a
content block as coupling. Inspect loops that append assistant and `tool_result` messages before
calling Messages again.

Confirm coupled cases end to end. Compare content-block order, tool names and inputs, tool
results, stop reason, subsequent calls, and terminal output. A changed loop count or missing tool
round is a case failure.
