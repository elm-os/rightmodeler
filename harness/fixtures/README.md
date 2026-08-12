# Shared test fixtures

`demo-app/` is inert scan-target source that covers AI SDK text and structured generation, OpenAI-compatible tool calling, Anthropic messages, and a LiteLLM-style model pin. `demo-app/src/model-notes.ts` is the comment-only red herring that scanners must ignore.

`traces/otel-genai.json` contains 15 runs and 17 current-convention GenAI spans across summarize and support task families (10 summarize and 7 support spans). The two pairs sharing `trace-trajectory-a` and `trace-trajectory-b` exercise trajectory clustering. Record `trace-support-pii-01` is the only trace record containing fake personal data; scrub tests should target its prompt.

`traces/openai.jsonl` contains eight request/response pairs in the append-friendly shape emitted by the capture script. It covers accepted summarize outputs and support tool calls with stable case identifiers, usage, and fake model identifiers.

`stub-provider/server.mjs` is a dependency-free OpenAI-compatible test server with a four-model price and capability catalog plus deterministic non-streaming chat completions. Run it with `--selftest` to exercise both endpoints and the streaming rejection path on an ephemeral port.
