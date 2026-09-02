import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  adaptWithReport,
  braintrustAdapter,
  claudeCodeAdapter,
  codexAdapter,
  detectFormat,
  heliconeAdapter,
  langfuseAdapter,
  langsmithAdapter,
  openAiJsonlAdapter,
  openInferenceAdapter,
  otelGenAiAdapter,
  parseTraceRecords,
  traceAdapters,
  weaveAdapter,
  type NamedTraceAdapter,
  type TraceFormat,
} from "../adapters.js";
import { scrubRuns } from "../scrub.js";

const plantedEmail = "demo.person@example.test";
const plantedPhone = "+1-202-555-0147";

interface FixtureCase {
  format: TraceFormat;
  filename: string;
  adapter: NamedTraceAdapter;
  traceId: string;
  model: string;
  trajectoryIds: string[];
  usage: Array<{ inputTokens: number; outputTokens: number }>;
  malformedRecord: unknown;
  withoutUsage(record: Record<string, unknown>): Record<string, unknown> | null;
}

function without(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

const fixtures: FixtureCase[] = [
  {
    format: "otel-genai",
    filename: "otel-genai.json",
    adapter: otelGenAiAdapter,
    traceId: "trace-trajectory-a",
    model: "acme/large-1",
    trajectoryIds: ["trace-trajectory-a", "trace-trajectory-a"],
    usage: [
      { inputTokens: 25, outputTokens: 16 },
      { inputTokens: 35, outputTokens: 17 },
    ],
    malformedRecord: {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "acme/large-1",
        "gen_ai.input.messages": [],
        "gen_ai.output.messages": [],
      },
    },
    withoutUsage: (record) => ({
      ...record,
      attributes: without(
        record.attributes as Record<string, unknown>,
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
      ),
    }),
  },
  {
    format: "openai-jsonl",
    filename: "openai.jsonl",
    adapter: openAiJsonlAdapter,
    traceId: "support-001",
    model: "acme/large-1",
    trajectoryIds: ["support-001"],
    usage: [{ inputTokens: 41, outputTokens: 19 }],
    malformedRecord: {
      model: "acme/large-1",
      messages: [],
      response: { choices: [] },
    },
    withoutUsage: (record) => ({
      ...without(record, "usage"),
      response: without(record.response as Record<string, unknown>, "usage"),
    }),
  },
  {
    format: "langfuse",
    filename: "langfuse.jsonl",
    adapter: langfuseAdapter,
    traceId: "lf-trace-1",
    model: "acme/large-1",
    trajectoryIds: ["lf-session-1", "lf-session-1"],
    usage: [
      { inputTokens: 24, outputTokens: 9 },
      { inputTokens: 17, outputTokens: 8 },
    ],
    malformedRecord: {
      id: "lf-bad",
      trace_id: "lf-trace-bad",
      parent_observation_id: "",
      type: "GENERATION",
      input: "{}",
      output: "{}",
      usage_details: {},
    },
    withoutUsage: (record) => without(record, "usage_details"),
  },
  {
    format: "braintrust",
    filename: "braintrust.jsonl",
    adapter: braintrustAdapter,
    traceId: "bt-root-1",
    model: "acme/large-1",
    trajectoryIds: ["bt-root-1", "bt-root-1"],
    usage: [
      { inputTokens: 26, outputTokens: 10 },
      { inputTokens: 18, outputTokens: 9 },
    ],
    malformedRecord: {
      id: "bt-bad",
      span_id: "bt-span-bad",
      root_span_id: "bt-root-bad",
      span_parents: [],
      span_attributes: { type: "llm" },
      input: [],
      output: {},
      metadata: {},
      metrics: {},
    },
    withoutUsage: (record) => without(record, "metrics"),
  },
  {
    format: "langsmith",
    filename: "langsmith.jsonl",
    adapter: langsmithAdapter,
    traceId: "ls-trace-1",
    model: "acme/large-1",
    trajectoryIds: ["ls-thread-1", "ls-thread-1"],
    usage: [
      { inputTokens: 28, outputTokens: 11 },
      { inputTokens: 19, outputTokens: 8 },
    ],
    malformedRecord: {
      id: "ls-bad",
      trace_id: "ls-trace-bad",
      parent_run_id: null,
      dotted_order: "20260801T120000000000Zls-bad",
      run_type: "llm",
      inputs: {},
      outputs: {},
      extra: { metadata: {} },
    },
    withoutUsage: (record) =>
      without(record, "prompt_tokens", "completion_tokens"),
  },
  {
    format: "openinference",
    filename: "openinference.jsonl",
    adapter: openInferenceAdapter,
    traceId: "0a0b0c0d0e0f10111213141516171819",
    model: "acme/large-1",
    trajectoryIds: ["oi-session-1", "oi-session-1"],
    usage: [
      { inputTokens: 30, outputTokens: 12 },
      { inputTokens: 18, outputTokens: 10 },
    ],
    malformedRecord: {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "bad",
                  attributes: [
                    {
                      key: "openinference.span.kind",
                      value: { stringValue: "LLM" },
                    },
                    {
                      key: "llm.model_name",
                      value: { stringValue: "acme/large-1" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    withoutUsage: (record) =>
      JSON.parse(JSON.stringify(record), (key, value: unknown) =>
        key === "attributes" && Array.isArray(value)
          ? value.filter(
              (attribute) =>
                !String((attribute as Record<string, unknown>).key).startsWith(
                  "llm.token_count.",
                ),
            )
          : value,
      ) as Record<string, unknown>,
  },
  {
    format: "helicone",
    filename: "helicone.jsonl",
    adapter: heliconeAdapter,
    traceId: "hc-session-1",
    model: "acme/large-1",
    trajectoryIds: ["hc-session-1", "hc-session-1"],
    usage: [
      { inputTokens: 31, outputTokens: 12 },
      { inputTokens: 20, outputTokens: 9 },
    ],
    malformedRecord: {
      response_id: "hc-response-bad",
      request_created_at: "2026-08-01T12:00:02.000Z",
      request_body: {},
      response_body: {},
      prompt_tokens: 1,
      completion_tokens: 1,
    },
    withoutUsage: (record) =>
      without(record, "prompt_tokens", "completion_tokens"),
  },
  {
    format: "weave",
    filename: "weave.jsonl",
    adapter: weaveAdapter,
    traceId: "wv-trace-1",
    model: "acme/large-1",
    trajectoryIds: ["wv-trace-1", "wv-trace-1"],
    usage: [
      { inputTokens: 33, outputTokens: 13 },
      { inputTokens: 21, outputTokens: 8 },
    ],
    malformedRecord: {
      id: "wv-bad",
      trace_id: "wv-trace-bad",
      op_name: "chat",
      parent_id: null,
      started_at: "2026-08-01T12:00:02.000Z",
      inputs: {},
      output: {},
      summary: {},
    },
    withoutUsage: (record) => without(record, "summary"),
  },
  {
    format: "claude-code",
    filename: "claude-code.jsonl",
    adapter: claudeCodeAdapter,
    traceId: "cc-session-1",
    model: "claude-sonnet-4-5-20250929",
    trajectoryIds: ["cc-prompt-1", "cc-prompt-1"],
    usage: [
      { inputTokens: 20403, outputTokens: 12 },
      { inputTokens: 20525, outputTokens: 9 },
    ],
    malformedRecord: {
      type: "assistant",
      uuid: "cc-bad",
      parentUuid: "cc-user-1",
      sessionId: "cc-session-1",
      message: { id: "cc-message-bad", content: [], usage: {} },
    },
    withoutUsage: (record) =>
      record.type === "assistant"
        ? {
            ...record,
            message: without(
              record.message as Record<string, unknown>,
              "usage",
            ),
          }
        : record,
  },
  {
    format: "codex",
    filename: "codex.jsonl",
    adapter: codexAdapter,
    traceId: "cx-session-1",
    model: "gpt-5.1-codex",
    trajectoryIds: ["cx-turn-1", "cx-turn-2"],
    usage: [
      { inputTokens: 19256, outputTokens: 527 },
      { inputTokens: 21954, outputTokens: 563 },
    ],
    malformedRecord: {
      timestamp: "2026-08-01T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: "not-an-array",
        internal_chat_message_metadata_passthrough: { turn_id: "cx-turn-2" },
      },
    },
    withoutUsage: (record) => {
      const payload = record.payload as Record<string, unknown>;
      return record.type === "event_msg" && payload.type === "token_count"
        ? null
        : record;
    },
  },
];

async function fixtureText(filename: string): Promise<string> {
  return readFile(
    new URL(`../../../../../fixtures/traces/${filename}`, import.meta.url),
    "utf8",
  );
}

describe("trace adapter conformance", () => {
  it("runs the 10 adapter by 10 fixture detection matrix", async () => {
    expect(traceAdapters).toHaveLength(fixtures.length);
    for (const fixture of fixtures) {
      const text = await fixtureText(fixture.filename);
      expect(
        fixture.adapter.detect(text),
        fixture.format,
      ).toBeGreaterThanOrEqual(0.7);
      for (const adapter of traceAdapters) {
        if (adapter === fixture.adapter) continue;
        expect(
          adapter.detect(text),
          `${adapter.name} cross-detected ${fixture.format}`,
        ).toBeLessThan(0.6);
      }
      expect(detectFormat(text, traceAdapters)).toBe(fixture.adapter);
    }
  });

  it("otel-genai accepts an OTLP resourceSpans export", async () => {
    const text = await fixtureText("otel-genai-otlp.jsonl");

    expect(otelGenAiAdapter.detect(text)).toBeGreaterThanOrEqual(0.7);
    for (const adapter of traceAdapters) {
      if (adapter === otelGenAiAdapter) continue;
      expect(adapter.detect(text), adapter.name).toBeLessThan(0.6);
    }
    expect(detectFormat(text, traceAdapters)).toBe(otelGenAiAdapter);

    const result = adaptWithReport(otelGenAiAdapter, parseTraceRecords(text));
    const run = result.runs[0];

    expect(result.droppedRecords).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(run?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(run?.steps.map(({ usage }) => usage)).toEqual([
      { inputTokens: 40, outputTokens: 11 },
      { inputTokens: 23, outputTokens: 9 },
    ]);
    expect(run?.steps[0]?.systemPrompt).toBe("Help the customer.");
    expect(run?.steps[0]?.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(result.runs)).toContain("lookup_order");

    const scrubbed = scrubRuns(result.runs);
    expect(
      scrubbed.redactions.filter(({ kind }) => kind === "email"),
    ).toHaveLength(1);
    expect(
      scrubbed.redactions.filter(({ kind }) => kind === "phone"),
    ).toHaveLength(1);
  });

  it.each(fixtures)(
    "$format maps grouping, model, usage, and tool metadata",
    async (fixture) => {
      const records = parseTraceRecords(await fixtureText(fixture.filename));
      const result = adaptWithReport(fixture.adapter, records);
      const run = result.runs.find(
        ({ traceId }) => traceId === fixture.traceId,
      );

      expect(result.droppedRecords).toEqual([]);
      expect(run?.sourceFormat).toBe(fixture.format);
      expect(run?.steps.map(({ model }) => model)).toEqual(
        fixture.trajectoryIds.map(() => fixture.model),
      );
      expect(run?.steps.map(({ trajectoryId }) => trajectoryId)).toEqual(
        fixture.trajectoryIds,
      );
      expect(run?.steps.map(({ usage }) => usage)).toEqual(fixture.usage);
      expect(JSON.stringify(result.runs)).toContain("lookup_order");
    },
  );

  it.each(fixtures)(
    "$format leaves usage absent when the source carries no token counts",
    async (fixture) => {
      const records = parseTraceRecords(await fixtureText(fixture.filename));
      const stripped = records.flatMap((record) => {
        const result = fixture.withoutUsage(record as Record<string, unknown>);
        return result === null ? [] : [result];
      });
      const result = adaptWithReport(fixture.adapter, stripped);
      const run = result.runs.find(
        ({ traceId }) => traceId === fixture.traceId,
      );

      expect(result.droppedRecords).toEqual([]);
      expect(run?.steps.map(({ usage }) => usage)).toEqual(
        fixture.trajectoryIds.map(() => undefined),
      );
    },
  );

  it.each(fixtures)(
    "$format reports one malformed record without discarding valid runs",
    async (fixture) => {
      const records = parseTraceRecords(await fixtureText(fixture.filename));
      const result = adaptWithReport(fixture.adapter, [
        ...records,
        fixture.malformedRecord,
      ]);

      expect(result.runs.length).toBeGreaterThan(0);
      expect(result.droppedRecords).toHaveLength(1);
      expect(result.droppedRecords[0]).toMatchObject({
        recordIndex: records.length,
        reason: expect.any(String),
      });
    },
  );

  it.each(fixtures)(
    "$format scrubs its single planted record",
    async (fixture) => {
      const text = await fixtureText(fixture.filename);
      const records = parseTraceRecords(text);
      const plantedRecords = records.filter((record) => {
        const serialized = JSON.stringify(record);
        return (
          serialized.includes(plantedEmail) && serialized.includes(plantedPhone)
        );
      });
      const result = adaptWithReport(fixture.adapter, records);
      const scrubbed = scrubRuns(result.runs);
      const serialized = JSON.stringify(scrubbed.runs);

      expect(plantedRecords).toHaveLength(1);
      expect(serialized).not.toContain(plantedEmail);
      expect(serialized).not.toContain(plantedPhone);
      expect(
        scrubbed.redactions.filter(({ kind }) => kind === "email"),
      ).toHaveLength(1);
      expect(
        scrubbed.redactions.filter(({ kind }) => kind === "phone"),
      ).toHaveLength(1);
    },
  );

  it("keeps a Weave model call without a family label", () => {
    const runs = weaveAdapter.adapt([
      {
        id: "wv-unlabeled",
        trace_id: "wv-trace-unlabeled",
        op_name: "",
        parent_id: null,
        started_at: "2026-08-01T12:00:00.000Z",
        inputs: {
          model: "acme/large-1",
          messages: [{ role: "user", content: "Hello" }],
        },
        output: "Hi",
        summary: {
          usage: {
            "acme/large-1": { prompt_tokens: 1, completion_tokens: 1 },
          },
        },
      },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.steps[0]?.family).toBeUndefined();
  });

  it("reads provider-shaped usage keys in a Weave summary", () => {
    const runs = weaveAdapter.adapt([
      {
        id: "wv-provider-usage",
        trace_id: "wv-trace-provider-usage",
        op_name: "chat",
        parent_id: null,
        started_at: "2026-08-01T12:00:00.000Z",
        inputs: {
          model: "acme/large-1",
          messages: [{ role: "user", content: "Hello" }],
        },
        output: "Hi",
        summary: {
          usage: {
            "acme/large-1": { input_tokens: 5, output_tokens: 2 },
          },
        },
      },
    ]);

    expect(runs[0]?.steps[0]?.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
    });
  });
});
