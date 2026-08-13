# OpenAI Go SDK harness

## Live docs first

- [OpenAI Go SDK](https://github.com/openai/openai-go)
- [Responses API reference](https://platform.openai.com/docs/api-reference/responses)
- [Function calling guide](https://platform.openai.com/docs/guides/function-calling)

Fetch these pages before acting and confirm the module major version. The official SDK uses
functional request options, and names can change across major versions.

## Where the model id is bound

For the Responses API, bind the model in `responses.ResponseNewParams.Model` passed to
`client.Responses.New(ctx, params)`. Chat Completions similarly binds it in its request params.

Replace only the params built for the scanned call site. Verify the response metadata and stored
execution show the candidate rather than relying on the constant's source text.

## Correlation forwarding

The SDK does not copy arbitrary values from `context.Context` into HTTP headers. Use
`option.WithHeader(name, value)` on `openai.NewClient(...)` for defaults or on the individual
request for call-local values.

Attach `x-rm-step` and a fresh `x-rm-call` as request options. Allocate the logical call ID before
the SDK's retry loop so every physical attempt stays grouped.

## Base URL override

Current SDK defaults honor `OPENAI_BASE_URL`; `option.WithBaseURL(...)` is the explicit client
override. Prefer `option.WithBaseURL(os.Getenv("OPENAI_BASE_URL"))` in Mode B so the application
cannot silently bypass the driver.

A client constructed with a literal vendor URL is pinned and must be changed before Mode B.

## Side-effect mocking

Replace the function dispatch map used after a function call with trace-backed Go functions.
Match function name, canonical JSON arguments, and occurrence; return the recorded output with
the original call ID in the next request.

Return errors for unknown or mismatched calls and unused expected results. Preserve ordering for
parallel calls rather than sorting them into a different conversation.

## Entry point

The natural single case is a function accepting `context.Context` plus a typed case value and
calling `client.Responses.New(...)` once, or iterating the application's existing tool loop.

Expose it as a small command only if the application has no callable case boundary. Print one
JSON result containing case ID, calls, and terminal output.

## Coupling detection

Inspect uses of response items, previous-response IDs, function calls, and shared conversation
state. Any returned value passed into another model call or application decision is downstream
coupling.

Run coupled paths end to end and compare item order, tools, terminal output, and deterministic
checks. A changed call count, function argument, or branch is a failed case.
