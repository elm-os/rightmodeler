# Shared test fixtures

`demo-app/` is inert scan-target source that covers AI SDK text and structured generation, OpenAI-compatible tool calling, Anthropic messages, and a LiteLLM-style model pin. `demo-app/src/model-notes.ts` is the comment-only red herring that scanners must ignore.

`traces/otel-genai.json` contains 15 runs and 17 current-convention GenAI spans across summarize and support task families (10 summarize and 7 support spans). The two pairs sharing `trace-trajectory-a` and `trace-trajectory-b` exercise trajectory clustering. Record `trace-support-pii-01` is the only trace record containing fake personal data; scrub tests should target its prompt.

`traces/openai.jsonl` contains eight request/response pairs in the append-friendly shape emitted by the capture script. It covers accepted summarize outputs and support tool calls with stable case identifiers, usage, and fake model identifiers. The `support-004` record is the fixture's planted scrub target.

The remaining trace fixtures are synthetic, append-friendly examples of each adapter's selected export shape: `langfuse.jsonl` uses enriched observation rows, `braintrust.jsonl` uses BTQL span rows, `langsmith.jsonl` uses the v2 bulk run row schema represented as JSONL, `openinference.jsonl` uses OTLP/JSON trace envelopes, `helicone.jsonl` uses request export rows with bodies, `weave.jsonl` uses streamed call rows, `claude-code.jsonl` uses local session transcript entries, and `codex.jsonl` uses persisted rollout entries. Every trace fixture contains `demo.person@example.test` and `+1-202-555-0147` together in exactly one record so the shared scrub test can prove both values are removed without using real personal data.

`stub-provider/server.mjs` is a dependency-free OpenAI-compatible test server with a four-model price and capability catalog plus deterministic non-streaming chat completions. Run it with `--selftest` to exercise both endpoints and the streaming rejection path on an ephemeral port.

`catalogs/ai-gateway-models.json` is a sanitized eight-model sample of the AI Gateway model-catalog response. It preserves per-token string pricing, context and output limits, capability parameters, tags, and model types so replay tests cover language-model normalization, capability-aware shortlisting, and exclusion of embedding entries.

`langgraph-app/` is a standalone three-node StateGraph fixture. Its classify node routes requests, its lookup node handles a `lookup_order` tool selection and invokes the deterministic local order tool, and its answer node composes the terminal output. Lookup-routed inputs without an order number use `ORD-000`. The documented tool-route case input is `Where is order ORD-104?`. From the repository root, verify it with `python harness/fixtures/langgraph-app/main.py --selftest` after installing its pinned requirements in an isolated environment.

`traces/langgraph-otel.json` contains 14 trajectories and 37 spans recorded for the LangGraph fixture. Lookup responses match the stub's text-only `finish_reason: stop` response; tool context remains in the fixture request rather than appearing as a response tool-call part. The recorded routes are:

| Trace                | Input                                  | Route                      |
| -------------------- | -------------------------------------- | -------------------------- |
| `trace-langgraph-01` | `Where is order ORD-104?`              | classify → lookup → answer |
| `trace-langgraph-02` | `What is the status of order ORD-104?` | classify → lookup → answer |
| `trace-langgraph-03` | `Track order ORD-205.`                 | classify → lookup → answer |
| `trace-langgraph-04` | `Look up delivery ORD-508.`            | classify → lookup → answer |
| `trace-langgraph-05` | `Track shipment ORD-114.`              | classify → lookup → answer |
| `trace-langgraph-06` | `Find the ETA for ORD-215.`            | classify → lookup → answer |
| `trace-langgraph-07` | `Check delivery ORD-417.`              | classify → lookup → answer |
| `trace-langgraph-08` | `Look up ORD-518.`                     | classify → lookup → answer |
| `trace-langgraph-09` | `Has order ORD-619 arrived?`           | classify → lookup → answer |
| `trace-langgraph-10` | `Do you offer weekend support?`        | classify → answer          |
| `trace-langgraph-11` | `What payment methods do you accept?`  | classify → answer          |
| `trace-langgraph-12` | `Where can I find the privacy policy?` | classify → answer          |
| `trace-langgraph-13` | `Tell me about your warranty.`         | classify → answer          |
| `trace-langgraph-14` | `How do refunds work?`                 | classify → answer          |
