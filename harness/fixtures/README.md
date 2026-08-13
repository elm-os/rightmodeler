# Shared test fixtures

`demo-app/` is inert scan-target source that covers AI SDK text and structured generation, OpenAI-compatible tool calling, Anthropic messages, and a LiteLLM-style model pin. `demo-app/src/model-notes.ts` is the comment-only red herring that scanners must ignore.

`traces/otel-genai.json` contains 15 runs and 17 current-convention GenAI spans across summarize and support task families (10 summarize and 7 support spans). The two pairs sharing `trace-trajectory-a` and `trace-trajectory-b` exercise trajectory clustering. Record `trace-support-pii-01` is the only trace record containing fake personal data; scrub tests should target its prompt.

`traces/openai.jsonl` contains eight request/response pairs in the append-friendly shape emitted by the capture script. It covers accepted summarize outputs and support tool calls with stable case identifiers, usage, and fake model identifiers.

`stub-provider/server.mjs` is a dependency-free OpenAI-compatible test server with a four-model price and capability catalog plus deterministic non-streaming chat completions. Run it with `--selftest` to exercise both endpoints and the streaming rejection path on an ephemeral port.

`langgraph-app/` is a standalone three-node StateGraph fixture. Its classify node routes requests, its lookup node sends a tool-calling chat request and invokes a deterministic local order tool, and its answer node composes the terminal output. The documented tool-route case input is `Where is order ORD-104?`. From the repository root, verify it with `python harness/fixtures/langgraph-app/main.py --selftest` after installing its pinned requirements in an isolated environment.

`traces/langgraph-otel.json` contains 14 three-span trajectories recorded for the LangGraph fixture. Within each trace, the records are classify, lookup, then answer; every lookup record carries the `lookup_order` tool-call metadata.
