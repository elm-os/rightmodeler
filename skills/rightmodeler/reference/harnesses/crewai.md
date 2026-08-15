# CrewAI harness

## Live docs first

- [CrewAI LLMs](https://docs.crewai.com/en/concepts/llms)
- [CrewAI tools](https://docs.crewai.com/en/concepts/tools)
- [Crew execution](https://docs.crewai.com/en/concepts/crews)

Fetch these pages before acting and check the installed CrewAI version. Current native-provider
clients differ from older LiteLLM-only releases.

## Where the model id is bound

The ID may be the `llm` value in `agents.yaml`, the `MODEL` environment variable, or
`LLM(model="provider/model-id")` assigned to an `Agent`. A manager agent can have a separate
model, so inventory every agent and manager before choosing the step boundary.

Swap only the agent responsible for the scanned step. Verify execution events and provider
response metadata show the candidate.

## Correlation forwarding

CrewAI does not forward arbitrary kickoff inputs or web headers to provider HTTP requests. The
current native OpenAI provider exposes `default_headers` through `LLM`; use that provider option
for correlation, or a custom LLM implementation when call-local headers are required.

Emit `x-rm-step` and a fresh `x-rm-call` for each logical LLM call. Agent-level default headers
are insufficient if one agent performs several distinct steps; use an LLM hook/client boundary.

## Base URL override

For the native OpenAI provider, CrewAI documents `OPENAI_BASE_URL` and `LLM(base_url=...)`. Wire
`base_url=os.environ["OPENAI_BASE_URL"]` for Mode B. Other native providers use their own endpoint
options; LiteLLM-backed providers use the provider's `api_base` contract.

A literal URL or provider client without an endpoint option is pinned and blocks Mode B.

## Side-effect mocking

Replace each side-effecting `BaseTool`, `@tool`, or MCP-derived tool before assigning it to an
agent. Preserve name, description, and argument schema, but return the recorded result selected
by canonical arguments and occurrence.

Fail on unknown calls, drifted arguments, duplicate consumption, and missing expected results.
Do not let delegation, code execution, or MCP calls escape to live services.

## Entry point

Use `crew.kickoff(inputs={...})` for one case; for a Flow, invoke its documented single-input
entry method. Await the complete kickoff rather than replaying one Task in isolation when agents
delegate or share context.

Emit the task/agent sequence, tool calls/results, and final `CrewOutput` in machine-readable form.

## Coupling detection

Inspect task context dependencies, sequential or hierarchical process configuration, delegation,
manager decisions, shared memory, tools, planning, and kickoff hooks. Output from one task used as
context for another is downstream coupling.

Confirm those crews end to end. Compare agent/task order, delegation, tool behavior, terminal
output, and deterministic checks. A different delegation or skipped task fails the case.
