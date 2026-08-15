# Harness reference contract

Use this file as the structural contract for every harness reference. Keep the seven H2
sections below, in this order, and do not add another H2 section. Write concrete instructions
for one pipeline shape, not general SDK advice.

## Live docs first

- Name and link the framework's current model/client API.
- Name and link the framework's current tool/execution API.
- Fetch these pages before acting. The live pages override this dated reference.
- Use official project or vendor documentation. Include at least one absolute `https://` URL.

## Where the model id is bound

- Name the constructor, configuration field, or call argument that owns the model ID.
- Distinguish a per-agent default from a per-call override.
- State the smallest substitution point that changes only the intended step.
- Say how to verify that the candidate, rather than the incumbent, served the call.

## Correlation forwarding

- State whether inbound or ambient headers are forwarded automatically.
- Name the exact SDK option for client-default or per-request extra headers.
- For Mode B, require `x-rm-step` and a fresh `x-rm-call` on every logical model call.
- Explain where to attach the headers so retries of one logical call retain correlation.

## Base URL override

- Name the environment variable used by the harness.
- State whether the framework honors it automatically, needs explicit constructor wiring, or
  pins an endpoint.
- Name the exact client option when explicit wiring is required.
- Treat a hard-coded provider endpoint as a Mode B blocker until the code is changed.

## Side-effect mocking

- Identify the framework's tool registration boundary.
- Replace each side-effecting implementation with a trace-backed function of tool name and
  canonical arguments.
- Return the recorded result in the framework's native tool-result shape.
- Fail loudly on an unrecorded call, argument mismatch, duplicate consumption, or missing result.
- Preserve tool-call order and call IDs when later messages depend on them.

## Entry point

- Name the natural one-case function, method, or command.
- Show the input shape needed to reproduce one recorded case.
- The entry point must run one case to a terminal output and emit machine-readable results.
- Do not use a batch, server, or interactive shell when a smaller invocation exists.

## Coupling detection

- Name the framework artifacts that expose branches, loops, tools, memory, or downstream nodes.
- Explain how an upstream model output reaches downstream behavior.
- Route any model-authored prefix or step with downstream consumers to end-to-end confirmation.
- Compare call sequence, tool arguments/results, terminal output, and deterministic checks.
- Treat call-sequence divergence as a case failure, not a row to discard.
