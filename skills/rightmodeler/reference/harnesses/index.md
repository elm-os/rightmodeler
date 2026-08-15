# Harness reference index

## Live docs first

- [Architecture contract](../../../../harness/docs/Architecture.md)
- [OpenAI API reference](https://platform.openai.com/docs/api-reference)

Fetch the live framework pages listed in the selected reference before inspecting or changing a
harness. Use this index only to choose the shape; the selected file supplies the operational
details.

## Where the model id is bound

- `vercel-ai-sdk.md`: AI SDK model argument or provider model factory.
- `langgraph.md`: model client inside a graph node; includes the shipped fixture contract.
- `langchain-js.md` and `langchain-py.md`: chat-model constructor or configurable model.
- `crewai.md`, `mastra.md`, and `autogen.md`: agent-level model/client configuration.
- `dspy.md`: `dspy.LM` plus `dspy.configure` or `dspy.context`.
- `raw-openai.md` and `raw-anthropic.md`: SDK request model field.
- `litellm-proxy.md`: proxy alias in the OpenAI-compatible request.
- `go-openai.md`, `ruby-openai.md`, and `java-langchain4j.md`: language SDK request or builder.

Bind at the narrowest call site that represents one scanned step. Do not replace a shared model
object when the same object serves unrelated steps.

## Correlation forwarding

No framework should be assumed to forward ambient headers. Select the reference that names its
exact header option. In Mode B, every logical provider call must carry `x-rm-step` and a fresh
`x-rm-call`; keep the same logical ID across transport retries.

## Base URL override

Select a shape whose provider client can target the Mode B proxy. OpenAI-compatible harnesses
normally wire `OPENAI_BASE_URL` explicitly or use an SDK that reads it. Anthropic-native
harnesses use `ANTHROPIC_BASE_URL`. Provider-neutral frameworks may require constructor options
instead of reading either variable.

If the application pins a vendor URL, stop Mode B work for that call site until the client can be
configured. Mode A remains available only for uncoupled recorded calls.

## Side-effect mocking

Use the chosen framework's tool registration seam. Build a trace-backed replacement for each
side-effecting tool, keyed by tool name plus canonical arguments. Consume recorded results in
order and fail on any mismatch; never fall through to the live side effect.

Pure deterministic tools may remain local. Record that choice so their outputs are distinguished
from replayed results.

## Entry point

Prefer one natural single-case call: graph `invoke`, chain or module `invoke`, agent `generate` or
`run`, crew `kickoff`, or raw SDK request. Wrap it only when the application lacks a machine-
readable one-case command.

For the shipped Mode B driver, `modebConfig` version `1` supplies the image, application command
containing `{caseFile}`, canonical-to-runtime `stepMap`, and optional confirmation run-set cap.

## Coupling detection

Inspect graph edges, workflow steps, agent/team handoffs, tool loops, shared memory, and output
parsers. Any step with downstream consumers, or any step evaluated on a model-authored prefix,
requires end-to-end confirmation.

Compare the full logical call sequence and final behavior. A changed branch, tool argument,
handoff, retry path, or missing downstream call is observable coupling and counts as a failed
case. Use the framework-specific reference for the exact artifacts to inspect.
