# AutoGen harness

## Live docs first

- [AutoGen AgentChat quickstart](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/quickstart.html)
- [AgentChat agents API](https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.agents.html)
- [OpenAI model client](https://microsoft.github.io/autogen/stable/reference/python/autogen_ext.models.openai.html)

Fetch these pages before acting and distinguish current AgentChat from legacy 0.2 configuration.

## Where the model id is bound

Current AgentChat binds the model in `OpenAIChatCompletionClient(model=...)`, which is supplied as
an `AssistantAgent`'s `model_client`. Teams can contain several agents and clients.

Substitute only the client for the scanned agent/step. Verify model-client events and the stored
execution identify the candidate.

## Correlation forwarding

AutoGen does not translate task data or runtime message metadata into provider HTTP headers. The
OpenAI client configuration accepts `default_headers`; set correlation there or wrap the client
when headers must vary per logical call.

Send `x-rm-step` and a fresh `x-rm-call` for each client `create` operation. Agent `run` may call
the client several times, so one run-level header is not enough.

## Base URL override

Use `OPENAI_BASE_URL` as the harness variable and pass
`base_url=os.environ["OPENAI_BASE_URL"]` to `OpenAIChatCompletionClient`. Current configuration
supports `base_url`; explicit wiring avoids legacy `api_base` ambiguity.

A literal endpoint pins the client. Azure and Anthropic clients use their own endpoint contracts.

## Side-effect mocking

Replace registered function tools, workbenches, `AgentTool`, and `TeamTool` boundaries with local
trace-backed tools. Preserve names and schemas, match canonical arguments and occurrence, and
return recorded results in the expected `FunctionExecutionResult` form.

Fail on unknown, mismatched, duplicate, or missing calls. Do not launch live code executors or MCP
workbenches. Preserve call IDs and disable parallel tool calls where the agent-as-tool contract
requires it.

## Entry point

Use `await agent.run(task=recorded_task)` or the team's corresponding `run` method for one case.
Use `run_stream` only if stream events affect behavior, and consume it through termination.

Emit the complete `TaskResult.messages`, tool events, stop reason, and terminal message as JSON.

## Coupling detection

Inspect team membership, handoffs, termination conditions, model contexts, memory, tools, nested
agents, and `max_tool_iterations`. Messages from one agent consumed by another are direct coupling.

Confirm teams end to end. Compare speaker/message order, handoffs, tool calls/results, terminal
message, and checks. A changed termination path or speaker sequence fails the case.

Treat a changed termination reason as coupling even when the final text happens to match.
