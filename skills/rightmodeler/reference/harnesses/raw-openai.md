# Raw OpenAI SDK harness

## Live docs first

- [OpenAI API reference](https://platform.openai.com/docs/api-reference)
- [OpenAI Python SDK](https://github.com/openai/openai-python)

Fetch both before acting. Confirm the repository's installed SDK version and whether the call uses
Responses or Chat Completions. The Phase A OpenAI JSONL path described below is Mode A and does
not execute the user's SDK.

## Where the model id is bound

In application code, the ID is the `model` argument to `client.responses.create(...)` or
`client.chat.completions.create(...)`. In Phase A Mode A, the harness replaces it with
`cell.candidate.id` in its own provider request; the recorded incumbent is only reference data.

The OpenAI JSONL adapter groups records by `case_id`, separates system messages, and uses the
request model, falling back to the response model, as the incumbent. Verify the provider response
and persisted execution name the candidate.

## Correlation forwarding

OpenAI Python does not infer rightmodeler correlation. `extra_headers={...}` adds headers to one
request; `OpenAI(default_headers={...})` supplies client defaults. For Mode B, send `x-rm-step`
and a fresh `x-rm-call` per logical call.

Phase A Mode A is different: it forwards only `RecordedCase.headers` unchanged. Its generated
logical-call UUID is ledger correlation and is not injected as `x-rm-call`; it does not add
`x-rm-step` either.

## Base URL override

The Python SDK honors `OPENAI_BASE_URL`, and `OpenAI(base_url=...)` overrides it explicitly. A
Mode B application must read that variable or pass it into the client; the driver points it at
the local proxy.

Phase A Mode A instead uses the CLI `--base-url`. It does not read `OPENAI_BASE_URL`; its API-key
variable defaults to `RIGHTMODELER_API_KEY` and can be changed with `--api-key-env`.

## Side-effect mocking

For application Mode B, replace every callable in the request's `tools` dispatcher with a lookup
of recorded tool results by tool name, canonical arguments, and occurrence. Return the result as
the matching tool message with the original tool-call ID.

Fail on an unknown tool, argument mismatch, reused result, or missing record. Phase A's JSONL
adapter does not build executable tool fixtures, so route tool calls and downstream coupling to
Mode B instead of claiming they were replayed.

## Entry point

The natural raw SDK unit is one `responses.create` or `chat.completions.create` call with the
recorded messages and options. Expose a one-case wrapper only when end-to-end execution is needed.

There is no public single-case Mode A CLI. `replayModeA(...)` is the programmatic driver;
`rightmodeler init` runs the resumable pipeline over all planned cells.

## Coupling detection

Mode A sees only the recorded request and accepted response. It cannot observe later branches,
tools, memory writes, or consumers, so it is valid only for uncoupled single-shot steps.

Scan the application for use of the response ID, output text, parsed object, or tool calls after
the SDK call. Any downstream consumer or model-authored prefix requires Mode B. During Mode B,
compare logical call order, tools, terminal output, and deterministic checks; sequence divergence
is a failed case.
