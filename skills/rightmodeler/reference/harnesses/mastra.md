# Mastra harness

## Live docs first

- [Mastra agents](https://mastra.ai/docs/agents/overview)
- [Mastra tools](https://mastra.ai/docs/agents/using-tools)
- [Agent `generate`](https://mastra.ai/reference/agents/generate)

Fetch these pages before acting and check the installed Mastra and AI SDK versions. Mastra model
router strings and directly supplied AI SDK models have different transport seams.

## Where the model id is bound

An `Agent` binds `model`, commonly as a `provider/model-name` router string or a model object with
an `id`. The model may also be a dynamic function of request context.

Swap the model on the agent serving the scanned step, not the entire `Mastra` instance. Verify the
generated steps/provider metadata and stored execution identify the candidate.

## Correlation forwarding

Mastra does not copy inbound server headers into model requests automatically. A model object can
carry `headers`, and call-time `modelSettings.headers` takes precedence when values vary.

Resolve `x-rm-step` and a fresh `x-rm-call` at each logical agent model call. A single agent may
loop, so do not assign one call ID to the whole `agent.generate` invocation.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable. Supply a model object whose `url` is
`process.env.OPENAI_BASE_URL`; Mastra does not document automatic resolution of this variable.
For a router string, use the documented provider/gateway configuration instead of assuming it is
read.

The `MastraClient` `baseUrl` targets a Mastra server, not the model provider. Changing it does not
redirect provider traffic.

## Side-effect mocking

Replace side-effecting `createTool({ execute })` implementations before registering the agent.
Keep the tool ID, description, and schemas; look up the recorded result by tool ID, canonical
context input, and occurrence.

Fail on unknown calls, argument drift, duplicate consumption, or unused expected results. Replace
MCP toolsets with local recorded tools rather than connecting to the live MCP server.

## Entry point

Retrieve the registered agent with `mastra.getAgentById(...)`, then call
`agent.generate(recordedInput)` for one case. This preserves instance services while reaching the
terminal output after all tool steps.

Emit `steps`, `toolCalls`, `toolResults`, usage, and terminal `text` as JSON. Use streaming only
when chunk behavior is part of the application contract.

## Coupling detection

Inspect agent tools, dynamic model/instruction functions, workflows, networks, memory, processors,
and the returned `steps`. Any tool, workflow transition, or later consumer of generated output is
coupling.

Confirm coupled cases end to end. Compare step and tool order, arguments/results, workflow state,
terminal text, and deterministic checks. A missing or extra step fails the case.
