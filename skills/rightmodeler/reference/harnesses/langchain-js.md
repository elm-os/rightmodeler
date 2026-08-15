# LangChain JavaScript harness

## Live docs first

- [LangChain JavaScript models](https://docs.langchain.com/oss/javascript/langchain/models)
- [ChatOpenAI integration](https://docs.langchain.com/oss/javascript/integrations/chat/openai)
- [Tools](https://docs.langchain.com/oss/javascript/langchain/tools)

Fetch these pages before acting and identify the installed integration package. Provider-specific
chat classes can have different transport settings.

## Where the model id is bound

For `@langchain/openai`, bind the ID in `new ChatOpenAI({ model: ... })`. A configurable model or
runnable may choose it from runtime config; inspect `.bind`, configurable alternatives, and agent
construction before editing a shared instance.

Change only the chat model serving the scanned runnable step. Verify `AIMessage.response_metadata`
or provider metadata and the execution record show the candidate.

## Correlation forwarding

LangChain does not automatically copy request-framework headers to the model provider. For
`ChatOpenAI`, pass client defaults as `configuration: { defaultHeaders: {...} }`. If the installed
integration exposes per-call provider headers, prefer those for `x-rm-step` and `x-rm-call`.

Create a fresh logical call ID at the runnable/model boundary, not inside retry callbacks. Ensure
nested agents receive explicit correlation instead of ambient web headers.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable and wire it through
`configuration: { baseURL: process.env.OPENAI_BASE_URL }`. `ChatOpenAI` documents `baseURL` in
the `configuration` object; do not assume every LangChain provider reads the environment itself.

A literal `baseURL` takes precedence and pins the route. Change that wiring before Mode B.

## Side-effect mocking

Replace side-effecting `DynamicStructuredTool`, `tool(...)`, or registered callable instances
before creating the agent. The replacement must keep the same name and schema, match canonical
arguments plus occurrence, and return the recorded tool result.

Fail on schema-valid but unrecorded inputs as well as malformed inputs, duplicate consumption,
and missing expected results. Preserve `tool_call_id` relationships in `ToolMessage` values.

## Entry point

Use one runnable's `invoke(input, config)` or `stream(...)` when streaming is behaviorally
important. For an agent, invoke the compiled agent once with the recorded message state and wait
for its terminal output.

Wrap that call in a one-case command only if the repository lacks a callable boundary. Emit the
messages, tool calls/results, and final output as JSON.

## Coupling detection

Inspect `RunnableSequence` composition, branches, agent executors, message history, retrievers,
output parsers, and any runnable fed by the model result. Callback nesting alone is not proof of
independence.

Route tool loops, model-authored histories, and downstream runnables to Mode B. Compare runnable
and tool sequence, arguments/results, terminal output, and deterministic checks; changed sequence
is a failed case.
