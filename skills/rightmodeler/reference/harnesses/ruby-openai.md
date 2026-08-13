# OpenAI Ruby SDK harness

## Live docs first

- [OpenAI Ruby SDK](https://github.com/openai/openai-ruby)
- [OpenAI API reference](https://platform.openai.com/docs/api-reference)
- [Function calling guide](https://platform.openai.com/docs/guides/function-calling)

Fetch these pages before acting and inspect the locked gem version. Use the current generated
types and `request_options` contract rather than older community-gem examples.

## Where the model id is bound

Bind the ID in `client.responses.create(model: ..., input: ...)` or
`client.chat.completions.create(model: ..., messages: ...)`. Substitute at the narrowest method
that represents the scanned step.

Verify the returned model metadata and execution fact name the candidate. Do not mutate one
shared options hash used by unrelated calls.

## Correlation forwarding

The SDK does not turn thread locals or Rack headers into provider headers. Add per-request values
with `request_options: { extra_headers: { ... } }`; client-wide defaults are appropriate only
when every call shares the same value.

Send `x-rm-step` and a fresh `x-rm-call` per logical call. Generate the call ID before invoking
the SDK so automatic retries retain it.

## Base URL override

Current generated clients accept `base_url:` and may read `OPENAI_BASE_URL`; wire the constructor
explicitly as `OpenAI::Client.new(base_url: ENV.fetch("OPENAI_BASE_URL"))` for Mode B.

If the repository pins the vendor URL or builds a separate transport that ignores this client
option, Mode B is blocked until that route becomes configurable.

## Side-effect mocking

Replace the application's function-name dispatch table with lambdas backed by the recorded
trace. Match name, canonical JSON arguments, and occurrence, and return the recorded tool output
under the original call ID.

Raise on unknown calls, argument drift, duplicate consumption, or missing expected results.
Preserve array order for multiple tool calls.

## Entry point

Use the method that processes one request or job and reaches one terminal response. It should
accept a case hash containing case ID, messages/input, and recorded tool results, then return a
JSON-serializable result.

Avoid starting Rails or a queue worker when the service object can be called directly. A thin
command wrapper is sufficient when process isolation is required.

## Coupling detection

Inspect response IDs, tool-call loops, service-object chaining, jobs enqueued from model output,
and state persisted for later calls. These are downstream consumers even when they run in a
different class.

Confirm those paths end to end. Compare calls, tool arguments/results, enqueued behavior under
the harness, terminal output, and deterministic checks; sequence divergence fails the case.
