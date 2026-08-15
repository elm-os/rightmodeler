# Vercel AI SDK harness

## Live docs first

- [AI SDK `generateText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)
- [AI SDK tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)

Fetch these pages before acting and identify the provider package and AI SDK major version. Core
options and provider transport options are separate contracts.

## Where the model id is bound

`generateText` and `streamText` receive `model`, either as a gateway string such as
`provider/model` or a provider-created `LanguageModel`. With `@ai-sdk/openai`, the provider model
factory receives the provider model ID.

Bind the candidate at the call or provider factory dedicated to the scanned step. Verify the
result's model metadata and recorded execution name the candidate.

## Correlation forwarding

AI SDK does not copy inbound Next.js or Fetch headers automatically. Core generation calls accept
`headers: Record<string, string | undefined>` for HTTP providers. Provider factories also expose
provider-level `headers` for defaults.

Set `x-rm-step` and a fresh `x-rm-call` in the generation call's `headers`. Generate the logical
ID before the call so provider retries keep it; do not reuse one ID across AI SDK steps.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable and construct the provider with
`createOpenAI({ baseURL: process.env.OPENAI_BASE_URL })`. The default `openai` provider is not a
promise that this environment variable will be read; explicit construction is the harness seam.

Other providers have their own `baseURL` option. A default singleton or literal URL that bypasses
the variable must be replaced before Mode B.

## Side-effect mocking

Replace each side-effecting `tool({ execute })` implementation with a trace-backed `execute` that
keeps the same input schema. Match tool name, canonical input, and occurrence, then return the
recorded result in its original JSON-compatible shape.

Fail on unknown or mismatched calls, duplicate consumption, and unused expected results. Preserve
tool-call IDs and result order in multi-step generation.

## Entry point

Use one `generateText({...})` call for a single case. For an agentic loop, invoke the existing
function that calls `generateText`/`streamText` through its stop condition and returns the final
step.

The one-case wrapper should accept recorded messages, tools, and case ID, then emit `steps`, tool
calls/results, usage, and terminal text as JSON.

## Coupling detection

Inspect `stopWhen`, step callbacks, `prepareStep`, tool execution, response messages reused in a
later generation, and application code consuming the result. Multiple `steps` or any tool call
is direct evidence of coupling.

Confirm coupled cases end to end. Compare AI SDK step order, tool arguments/results, finish
reasons, terminal output, and deterministic checks; a changed sequence fails the case.
