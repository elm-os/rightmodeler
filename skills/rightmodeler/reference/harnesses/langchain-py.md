# LangChain Python harness

## Live docs first

- [LangChain Python models](https://docs.langchain.com/oss/python/langchain/models)
- [ChatOpenAI integration](https://docs.langchain.com/oss/python/integrations/chat/openai)
- [Tools](https://docs.langchain.com/oss/python/langchain/tools)

Fetch these pages before acting and inspect the installed provider integration. Constructor and
runtime options differ between provider packages.

## Where the model id is bound

For `langchain-openai`, bind the model in `ChatOpenAI(model=...)`. It may instead come from
`init_chat_model(model=..., model_provider=...)`, a configurable field, or an agent factory.

Substitute at the narrowest model object serving the scanned step. Verify response metadata and
the stored execution show the candidate; do not mutate a global model shared by unrelated chains.

## Correlation forwarding

LangChain callbacks and runnable config metadata are not provider HTTP headers. For `ChatOpenAI`,
use `default_headers={...}` for client defaults; use the installed integration's request option
when it supports per-call headers.

Send `x-rm-step` and a fresh `x-rm-call` for each logical model invocation. Allocate the call ID
outside SDK retries, and pass it explicitly through nested runnables.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable and wire
`ChatOpenAI(base_url=os.environ["OPENAI_BASE_URL"])` or pass `base_url` to `init_chat_model`.
This explicit wiring avoids relying on transitive SDK environment discovery.

Provider-specific classes may use different variables. A literal endpoint pins the route and
blocks Mode B until changed.

## Side-effect mocking

Replace `@tool`, `StructuredTool`, or plain callable implementations before building the agent.
Keep each tool's name, description, and input schema, but look up the recorded result by tool
name, canonical arguments, and occurrence.

Return the native value expected by the agent and preserve tool-call IDs in message history. Raise
on unknown calls, argument drift, reused results, or missing expected results.

## Entry point

Invoke one chain or runnable with `.invoke(input, config=...)`. For a compiled agent, pass the
recorded message state and run until a terminal message. Use `.stream` only when chunk behavior
is part of the contract.

A thin one-case command should accept case JSON and print messages, tool events, and final output
as JSON; it should not start a web server.

## Coupling detection

Inspect LCEL pipes, `RunnableBranch`, agents, retrievers, output parsers, message-history wrappers,
and Python control flow using model output. Model-authored state passed into another call is
coupled even without a formal graph.

Confirm coupled paths end to end. Compare call and tool sequence, arguments/results, final output,
and deterministic checks. Do not discard a case because its branch differs.
