# Trace formats & the normalized schema

The user uploads agent trace logs. `ingest.py` autodetects the format and normalizes
everything into one schema so the rest of the pipeline is format-agnostic.

## Supported source formats

| Format                      | How it's exported / where it lives                                        | Detection hint                                                                                  |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **LangSmith**               | `client.read_run(id, load_child_runs=True)` / bulk export → run-tree JSON | keys `run_type`, `trace_id`, `parent_run_id`                                                    |
| **OTel GenAI**              | OTLP spans (json) with `gen_ai.*` attributes                              | attrs `gen_ai.request.model`, `gen_ai.input.messages`                                           |
| **OpenInference** (Phoenix) | OTLP spans, `openinference.span.kind` + `llm.*` attrs                     | `llm.model_name`, `llm.input_messages.0.message.role`                                           |
| **OpenAI JSONL**            | per-line request+response dumps                                           | top-level `model` + `messages` + `usage`                                                        |
| **Braintrust**              | span rows                                                                 | `span_id`, `root_span_id`, `span_attributes.type`                                               |
| **Langfuse**                | `GET /api/public/observations` / blob export                              | `traceId`, `observations`, `usageDetails`                                                       |
| **Claude Code**             | `~/.claude/projects/<enc-path>/*.jsonl`                                   | `type` in {user,assistant}, `message.content[].type == tool_use`, `parentUuid`                  |
| **Codex CLI**               | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`                            | line `{timestamp,type,payload}`, `payload.type` in {message,function_call,function_call_output} |
| **LiteLLM proxy**           | `StandardLoggingPayload` via s3/gcs/file/custom-callback logging          | `call_type` + `messages` + `response_cost`/`startTime`                                          |

Two topologies to handle: **tree** (parent-link: LangSmith, OTel, OpenInference,
Claude Code, Braintrust) and **flat-with-id-pairing** (Codex + OpenAI JSONL, join
`function_call` → `function_call_output` by `call_id`). OTel/OpenInference flatten
arrays into indexed dotted keys (`...messages.0.message.content`) — un-flatten first.
Tool `arguments` and tool schemas often arrive as JSON _strings_ — parse defensively.

## Normalized schema (`normalized.json`)

```json
{
  "trace_id": "string",
  "source_format": "langsmith|otel_genai|openinference|openai_jsonl|litellm|braintrust|langfuse|claude_code|codex_cli|reconstructed",
  "session_id": "string",
  "steps": [
    {
      "step_id": "string",
      "parent_id": "string|null",
      "case_id": "string|null",
      "order": 0,
      "kind": "llm|tool|chain|retriever|agent",
      "name": "string",
      "model": "string|null",
      "provider": "string|null",
      "system_prompt": "string|null",
      "input_messages": [
        {
          "role": "system|user|assistant|tool",
          "content": "string|array",
          "tool_calls": [{ "id": "string", "name": "string", "arguments": {} }]
        }
      ],
      "available_tools": [
        { "name": "string", "description": "string", "parameters_schema": {} }
      ],
      "tool_calls": [
        {
          "id": "string",
          "name": "string",
          "arguments": {},
          "result": { "content": "string|object", "is_error": false }
        }
      ],
      "output_text": "string|null",
      "output_messages": [{ "role": "assistant", "content": "string" }],
      "usage": {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0
      },
      "cost_usd": 0.0,
      "success": {
        "status": "ok|error",
        "error": null,
        "accepted": true,
        "scores": {},
        "source_signal": "feedback_stats|scores|is_error|user_accept"
      },
      "metadata": {},
      "raw": {}
    }
  ]
}
```

Design choices baked into the normalizer:

- One step per LLM/tool/chain span. Tool call + its result live together on the step
  (join by `tool_call_id` for flat formats).
- `raw` preserves the untouched source object so nothing is lost and replay can
  reconstruct the exact request.
- `success` is heterogeneous across tools — keep the normalized boolean _and_ the
  original signal so we know how much to trust it.
- `cost_usd`: only LangSmith/Braintrust/Langfuse carry it reliably; for CLI/OTel derive
  from `model` + token usage via the OpenRouter pricing table.
- `case_id`: null for real traces. Hand-built benchmark corpora (see
  [corpus-reconstruction.md](corpus-reconstruction.md)) set it per example so
  `analyze.py` can tell "same step, N cases" apart from "loop iterations".

## Field mapping cheat-sheet

| Normalized  | LangSmith                       | OTel GenAI              | OpenInference                  | Claude Code                   | Codex                            |
| ----------- | ------------------------------- | ----------------------- | ------------------------------ | ----------------------------- | -------------------------------- |
| kind        | `run_type`                      | `gen_ai.operation.name` | `openinference.span.kind`      | type + block type             | `payload.type`                   |
| model       | `extra.metadata.ls_model_name`  | `gen_ai.request.model`  | `llm.model_name`               | `message.model`               | `turn_context.model`             |
| input msgs  | `inputs.messages`               | `gen_ai.input.messages` | `llm.input_messages.*`         | `message.content[]`           | `payload.content[]`              |
| tool call   | child `tool` run                | `execute_tool` span     | `tool_call.function.*`         | `tool_use` block              | `function_call`                  |
| tool result | tool run `outputs`              | tool span output        | `output.value`                 | `tool_result`/`toolUseResult` | `function_call_output` (call_id) |
| avail tools | `extra.invocation_params.tools` | tool defs               | `llm.tools.*.tool.json_schema` | n/a                           | n/a                              |
| tokens      | `token_usage.*`                 | `gen_ai.usage.*_tokens` | `llm.token_count.*`            | `usage.*_tokens`              | `event_msg.token_count.usage`    |
| success     | `feedback_stats`, `error`       | span `status`           | span status                    | `is_error`                    | status/approval                  |

## What makes a step "replayable single-shot" vs "needs code-execution"

`analyze.py` classifies each step:

- **single-shot**: `kind == llm`, no `tool_calls`, not inside a loop, output not consumed
  by a later step's input → safe to replay in isolation (`replay_step.py`).
- **multi-step / tool / loop**: has tool calls, repeats (same node name appears >1× within
  the same `case_id`), or its output feeds a downstream step → must go through
  `run_pipeline.py` E2E replay.

## Log stores (CloudWatch, Datadog, GCP Logging): triage before ingesting

Users often point at their app's log store instead of an agent-trace export. Most
application logs record _that_ an LLM call happened (request lines, latencies, status
codes) but not the LLM inputs and outputs — and without input → accepted-output pairs
there is nothing to replay or judge. Triage before spending any effort on ingestion:

1. **Recency**: list log groups/streams and check the last-event timestamps — stale
   streams often mean the service moved (e.g. an infra migration) and you're looking
   at the wrong group.
2. **Pattern probe**: filter a bounded window for markers of LLM I/O: `system_prompt`,
   `messages`, `completion`, provider names, model IDs. Compute time windows from the
   stream's own timestamps, not hardcoded epochs.
3. **Sample and verify pairs**: pull a handful of matched events and check that a full
   input (system prompt + messages) AND the model's output are both present for the
   same call. Metadata-only logs fail this.
4. **Verdict**: if the pairs exist, export the window to JSONL and run
   `ingest.py --detect`. If they don't, say so plainly — do not fabricate a corpus
   from partial logs. Fall back to
   [corpus-reconstruction.md](corpus-reconstruction.md) if the app persists LLM
   outputs somewhere else (usually its database), or set up capture (below) and
   resume once traffic has been collected.

Export shapes `ingest.py` handles transparently: gzipped files (`.gz`), CloudWatch
S3-export lines (`<ISO timestamp> <json>`), CloudWatch event envelopes
(`{timestamp, message: "<json string>"}`), Firehose deliveries
(`{messageType, logEvents: [...]}`), and Docker/k8s `{log}` wrappers. Datadog
archives are newline-delimited `.json.gz` (handled) — `.json.zst` needs `zstd -d`
first.

## No usable logs at all? Set up capture

When an app has neither traces nor stored outputs, don't dead-end — help the user
start capturing. Every route below produces files `ingest.py` reads directly;
collect a few days of representative traffic (~8+ cases per task family is the
useful minimum), then analyze. The captured log contains full prompts and outputs
— treat it like production data.

- **SDK shim (fastest, stdlib-only)**: copy `scripts/capture.py` into the app and
  wrap the client once at startup — `wrap_openai` (chat.completions + Responses
  API) or `wrap_anthropic` — or call `log_call(...)` at the call site. Appends
  OpenAI-JSONL records with a per-call `case_id`; inside an agent loop, pass the
  request's id as `case_id` on every call so the loop is classified for E2E
  replay. Streaming calls pass through unlogged — log those call sites explicitly
  after assembling the final message, or disable streaming while collecting.
- **LiteLLM proxy**: any payload-logging destination (`s3_bucket`, `gcs_bucket`,
  custom `success_callback`) writes `StandardLoggingPayload` — ingested natively
  as `litellm`. Records redacted by `turn_off_message_logging` are skipped with a
  warning.
- **Vercel AI SDK**: ~20-line language-model middleware
  (`wrapLanguageModel({model, middleware: {wrapGenerate}})`) appending
  `{model, messages: prompt, output: result.text}` JSONL — the generic adapter
  ingests it.
- **LangChain**: a `BaseCallbackHandler` joining `on_chat_model_start` /
  `on_llm_end` on `run_id`, writing the same generic shape.
- **Provider/proxy exports** (when the app already runs through one): OpenAI
  stored completions (`store: true`, then `GET /v1/chat/completions` +
  `/{id}/messages` — standard chat-completion objects); Helicone
  `POST /v1/request/query` (follow `signed_body_url` when inline bodies are
  omitted); Portkey Logs Export API (JSONL of raw request/response). OpenRouter
  and the Anthropic console do **not** export payloads.

Sources: LangSmith export docs, OTel GenAI semconv, OpenInference spec, Braintrust/Langfuse
data models, Claude Code & Codex session-format write-ups (see research notes in git history).
