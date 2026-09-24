import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  aiSdkAdapter,
  otelGenAiAdapter,
  parseTraceRecords,
} from "../adapters.js";
import { type NormalizedRun } from "../normalized-run.js";
import { scrubRuns } from "../scrub.js";

const abortedTraceId = "00000000000000000000000000000007";
const supportTraceId = "00000000000000000000000000000002";
const functionIds = [
  "extract-order",
  "extract-order-stream",
  "summarize",
  "support-agent",
  "triage",
];

type OtlpSpan = {
  traceId: string;
  attributes: Array<{ key: string; value: unknown }>;
};

async function records(filename: string): Promise<Record<string, unknown>[]> {
  return parseTraceRecords(
    await readFile(
      new URL(`../../../../../fixtures/traces/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>[];
}

function spansOf(record: Record<string, unknown>): OtlpSpan[] {
  return (
    record as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
    }
  ).resourceSpans.flatMap(({ scopeSpans }) =>
    scopeSpans.flatMap(({ spans }) => spans),
  );
}

function attribute(span: OtlpSpan, key: string): unknown {
  const value = span.attributes.find((item) => item.key === key)?.value as
    Record<string, unknown> | undefined;
  return value?.stringValue;
}

function withSpans(
  record: Record<string, unknown>,
  change: (span: OtlpSpan) => OtlpSpan,
): Record<string, unknown> {
  const copy = structuredClone(record);
  const resource = (
    copy as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
    }
  ).resourceSpans;
  for (const { scopeSpans } of resource) {
    for (const scope of scopeSpans) scope.spans = scope.spans.map(change);
  }
  return copy;
}

function withoutTimestamps(runs: readonly NormalizedRun[]) {
  return [...runs]
    .sort((left, right) => left.traceId.localeCompare(right.traceId))
    .map(({ traceId, steps }) => ({
      traceId,
      steps: steps.map(({ timestamp: _timestamp, ...step }) => step),
    }));
}

function run(runs: readonly NormalizedRun[], traceId: string): NormalizedRun {
  const found = runs.find((candidate) => candidate.traceId === traceId);
  expect(found, traceId).toBeDefined();
  return found!;
}

function outputMessage(output: unknown) {
  return (output as Array<{ parts: unknown[]; finish_reason: string }>)[0]!;
}

function traceId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

describe("ai-sdk adapter", () => {
  it("keeps a batch line that holds only root, tool or foreign spans", async () => {
    const split = await records("ai-sdk-v7-legacy-split.jsonl");
    const unsplit = (await records("ai-sdk-v7-legacy.jsonl")).slice(0, 8);
    const foreign = {
      traceId: "0000000000000000000000000000f00d",
      spanId: "000000000000f00d",
      name: "GET /health",
      attributes: { "http.request.method": "GET" },
    };

    const result = aiSdkAdapter.adaptWithReport([...split, foreign]);
    const expected = aiSdkAdapter.adaptWithReport(unsplit);

    expect(split.length).toBeGreaterThan(unsplit.length);
    expect(result.droppedRecords).toEqual([]);
    expect(expected.droppedRecords).toEqual([]);
    expect(withoutTimestamps(result.runs)).toEqual(
      withoutTimestamps(expected.runs),
    );
    expect(result.runs).toHaveLength(7);
  });

  it("leaves an aborted stream out with stream_incomplete and keeps its siblings", async () => {
    const result = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );

    expect(result.excludedSteps).toEqual([
      { recordIndex: 6, traceId: abortedTraceId, reason: "stream_incomplete" },
    ]);
    expect(result.droppedRecords).toEqual([]);
    expect(result.runs).toHaveLength(144);
    expect(result.runs.map(({ traceId }) => traceId)).not.toContain(
      abortedTraceId,
    );
  });

  it("keeps the tool loop outcome", async () => {
    const { runs } = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );
    const [first, second] = run(runs, supportTraceId).steps;

    expect(outputMessage(first?.output).parts.at(-1)).toEqual({
      type: "tool_call",
      id: expect.any(String),
      name: "lookup_order",
      arguments: { orderId: "ORD-104" },
    });
    expect(outputMessage(first?.output).finish_reason).toBe("tool_call");
    const parts = (second?.messages as Array<{ parts: unknown[] }>).flatMap(
      ({ parts }) => parts,
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        name: "lookup_order",
        arguments: { orderId: "ORD-104" },
      }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool_call_response",
        response: { orderId: "ORD-104", status: "ships Tuesday" },
      }),
    );
    expect(outputMessage(second?.output).finish_reason).toBe("stop");
  });

  it("reads the full streamed text", async () => {
    const { runs } = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );
    const [step] = run(runs, traceId(5)).steps;

    expect(outputMessage(step?.output)).toEqual({
      role: "assistant",
      parts: [
        {
          type: "text",
          content: "Summary 7: the transit board delayed the fare change.",
        },
      ],
      finish_reason: "stop",
    });
  });

  it("reads object outputs as text parts", async () => {
    const { runs } = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );

    expect(outputMessage(run(runs, traceId(3)).steps[0]?.output).parts).toEqual(
      [
        {
          type: "text",
          content: '{"customer":"Dana","orderId":"ORD-300","urgency":"normal"}',
        },
      ],
    );
    expect(outputMessage(run(runs, traceId(4)).steps[0]?.output).parts).toEqual(
      [
        {
          type: "text",
          content: '{"customer":"Kai","orderId":"ORD-301","urgency":"low"}',
        },
      ],
    );
  });

  it("decodes v6 string tool input and ignores metadata", async () => {
    const source = await records("ai-sdk-v6.jsonl");
    const rawToolCalls = spansOf(source[1]!)
      .map((span) => attribute(span, "ai.response.toolCalls"))
      .find((value) => value !== undefined);
    const withMetadata = source.map((record) =>
      withSpans(record, (span) => ({
        ...span,
        attributes: [
          ...span.attributes,
          {
            key: "ai.telemetry.metadata.family",
            value: { stringValue: "metadata-family" },
          },
          {
            key: "ai.telemetry.metadata.model",
            value: { stringValue: "metadata-model" },
          },
        ],
      })),
    );

    const result = aiSdkAdapter.adaptWithReport(withMetadata);
    const [first, second] = run(result.runs, supportTraceId).steps;
    const scrubbed = scrubRuns(result.runs);

    expect(
      JSON.parse(String(rawToolCalls)) as Array<{ input: unknown }>,
    ).toEqual([expect.objectContaining({ input: '{"orderId":"ORD-104"}' })]);
    expect(result.droppedRecords).toEqual([]);
    expect(outputMessage(first?.output).parts).toEqual([
      {
        type: "tool_call",
        id: expect.any(String),
        name: "lookup_order",
        arguments: { orderId: "ORD-104" },
      },
    ]);
    expect(
      (second?.messages as Array<{ parts: unknown[] }>).flatMap(
        ({ parts }) => parts,
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        arguments: { orderId: "ORD-104" },
      }),
    );
    expect(JSON.stringify(scrubbed.runs)).not.toContain(
      "demo.person@example.test",
    );
    expect(JSON.stringify(scrubbed.runs)).not.toContain("+1-202-555-0147");
    expect(
      scrubbed.redactions.filter(({ kind }) => kind === "email"),
    ).toHaveLength(1);
    expect(
      scrubbed.redactions.filter(({ kind }) => kind === "phone"),
    ).toHaveLength(1);
    expect(JSON.stringify(result.runs)).not.toContain("metadata-");
    expect(
      new Set(
        result.runs.flatMap(({ steps }) => steps.map(({ family }) => family)),
      ),
    ).toEqual(new Set(functionIds));
  });

  it("reads the family from the functionId", async () => {
    const { runs } = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );

    expect(
      [
        ...new Set(
          runs.flatMap(({ steps }) => steps.map(({ family }) => family)),
        ),
      ].sort(),
    ).toEqual(functionIds);
  });

  it("names recordInputs and recordOutputs in the drop reason", async () => {
    const [planted] = await records("ai-sdk-v7-legacy.jsonl");
    const without = (keys: string[]) =>
      withSpans(planted!, (span) => ({
        ...span,
        attributes: span.attributes.filter(({ key }) => !keys.includes(key)),
      }));

    const noInputs = aiSdkAdapter.adaptWithReport([
      without(["ai.prompt.messages"]),
    ]);
    const noOutputs = aiSdkAdapter.adaptWithReport([
      without([
        "ai.response.text",
        "ai.response.toolCalls",
        "ai.response.reasoning",
      ]),
    ]);

    expect(noInputs.droppedRecords).toEqual([
      { recordIndex: 0, reason: expect.stringContaining("recordInputs") },
    ]);
    expect(noOutputs.droppedRecords).toEqual([
      { recordIndex: 0, reason: expect.stringContaining("recordOutputs") },
    ]);
  });
});

describe("otel-genai on the AI SDK GenAI dialect", () => {
  it("does not count an invoke_agent root beside its chat spans", async () => {
    const source = await records("ai-sdk-v7-genai.jsonl");
    const chatSpans = source.map((record) => {
      const spans = spansOf(record);
      return {
        id: spans[0]!.traceId,
        count: spans.filter(
          (span) => attribute(span, "gen_ai.operation.name") === "chat",
        ).length,
      };
    });
    const { runs } = otelGenAiAdapter.adaptWithReport(source);

    expect(runs.flatMap(({ steps }) => steps)).toHaveLength(
      chatSpans.reduce((total, { count }) => total + count, 0) - 1,
    );
    for (const { id, count } of chatSpans) {
      if (id === abortedTraceId) continue;
      expect(run(runs, id).steps, id).toHaveLength(count);
    }
  });

  it("treats agent_step and execute_tool as structure", async () => {
    const result = otelGenAiAdapter.adaptWithReport(
      await records("ai-sdk-v7-genai.jsonl"),
    );

    expect(result.droppedRecords).toEqual([]);
    expect(result.excludedSteps).toHaveLength(1);
  });

  it("inherits the family from the nearest invoke_agent", async () => {
    const genai = otelGenAiAdapter.adaptWithReport(
      await records("ai-sdk-v7-genai.jsonl"),
    );
    const legacy = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );
    const families = (runs: readonly NormalizedRun[]) =>
      withoutTimestamps(runs).map(({ traceId, steps }) => ({
        traceId,
        families: steps.map(({ family }) => family),
      }));

    expect(families(genai.runs)).toEqual(families(legacy.runs));
    expect(
      genai.runs.every(({ steps }) =>
        steps.every(({ family }) => family !== undefined),
      ),
    ).toBe(true);
  });

  it("leaves an aborted chat span out with stream_incomplete", async () => {
    const result = otelGenAiAdapter.adaptWithReport(
      await records("ai-sdk-v7-genai.jsonl"),
    );

    expect(result.excludedSteps).toEqual([
      { recordIndex: 6, traceId: abortedTraceId, reason: "stream_incomplete" },
    ]);
  });

  it("reads both dialects of the same calls identically", async () => {
    const legacy = aiSdkAdapter.adaptWithReport(
      await records("ai-sdk-v7-legacy.jsonl"),
    );
    const genai = otelGenAiAdapter.adaptWithReport(
      await records("ai-sdk-v7-genai.jsonl"),
    );

    expect(genai.runs).toHaveLength(144);
    expect(withoutTimestamps(genai.runs)).toEqual(
      withoutTimestamps(legacy.runs),
    );
  });

  it("still counts an invoke_agent span with no inference child", () => {
    const runs = otelGenAiAdapter.adapt([
      {
        traceId: "lone-agent",
        spanId: "lone-agent-root",
        startTimeUnixNano: "1",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "lone-agent",
          "gen_ai.request.model": "acme/large-1",
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "Hello" }] },
          ]),
          "gen_ai.output.messages": JSON.stringify([
            {
              role: "assistant",
              parts: [{ type: "text", content: "Hi" }],
              finish_reason: "stop",
            },
          ]),
        },
      },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.steps).toHaveLength(1);
    expect(runs[0]?.steps[0]?.family).toBe("lone-agent");
  });
});
