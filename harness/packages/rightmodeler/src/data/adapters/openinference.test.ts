import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { openInferenceAdapter, parseTraceRecords } from "../adapters.js";

type OtlpSpan = {
  traceId: string;
  name: string;
  startTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

async function records(filename: string): Promise<Record<string, unknown>[]> {
  return parseTraceRecords(
    await readFile(
      new URL(`../../../../../fixtures/traces/${filename}`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>[];
}

function spanOf(record: Record<string, unknown>): OtlpSpan {
  return (
    record as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
    }
  ).resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
}

function attribute(span: OtlpSpan, key: string): string | undefined {
  return span.attributes.find((item) => item.key === key)?.value.stringValue;
}

function withSpan(
  record: Record<string, unknown>,
  change: (span: OtlpSpan) => OtlpSpan,
): Record<string, unknown> {
  const copy = structuredClone(record);
  const scope = (
    copy as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
    }
  ).resourceSpans[0]!.scopeSpans[0]!;
  scope.spans = scope.spans.map(change);
  return copy;
}

function redacted(
  span: OtlpSpan,
  valueKey: string,
  indexedPrefix: string,
): OtlpSpan {
  return {
    ...span,
    attributes: span.attributes
      .filter(({ key }) => !key.startsWith(indexedPrefix))
      .map((item) =>
        item.key === valueKey
          ? { key: valueKey, value: { stringValue: "__REDACTED__" } }
          : item,
      ),
  };
}

async function envoy() {
  const source = await records("envoy-openinference.jsonl");
  return { source, result: openInferenceAdapter.adaptWithReport(source) };
}

describe("OpenInference reader", () => {
  it("reads the requested model and the conversation as sent from Envoy's request bodies", async () => {
    const { source, result } = await envoy();
    const steps = result.runs.flatMap(({ steps }) => steps);

    for (const step of steps) {
      const span = source
        .map(spanOf)
        .find(({ startTimeUnixNano }) => startTimeUnixNano === step.timestamp);
      const request = JSON.parse(attribute(span!, "input.value")!) as {
        model: string;
        messages: unknown[];
      };
      expect(step.model).toBe(request.model);
      expect(step.messages).toEqual(request.messages);
    }
    expect(steps.find(({ family }) => family === "fallback")?.model).toBe(
      "fallback-demo",
    );
    const support = result.runs.find(({ traceId }) => traceId === "envoy-s2");
    expect(support?.steps[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [expect.objectContaining({ type: "function" })],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: expect.any(String),
        }),
      ]),
    );
    expect(
      steps.some(({ messages }) =>
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "tools" in message,
        ),
      ),
    ).toBe(false);
  });

  it("groups an Envoy session into one ordered run", async () => {
    const { source, result } = await envoy();

    for (const session of ["envoy-s1", "envoy-s2"]) {
      const starts = source
        .map(spanOf)
        .filter((span) => attribute(span, "session.id") === session)
        .map(({ startTimeUnixNano }) => startTimeUnixNano)
        .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
      const run = result.runs.find(({ traceId }) => traceId === session);
      expect(
        run?.steps.map(({ stepIndex, timestamp, trajectoryId }) => ({
          stepIndex,
          timestamp,
          trajectoryId,
        })),
      ).toEqual([
        { stepIndex: 0, timestamp: starts[0], trajectoryId: session },
        { stepIndex: 1, timestamp: starts[1], trajectoryId: session },
      ]);
    }
  });

  it("takes the family from the mapped family header", async () => {
    const { source, result } = await envoy();

    expect(source.map(spanOf).map(({ name }) => name)).toContain(
      "ChatCompletion",
    );
    expect(
      [
        ...new Set(
          result.runs.flatMap(({ steps }) => steps.map(({ family }) => family)),
        ),
      ].sort(),
    ).toEqual(["extract", "fallback", "summarize", "support"]);
  });

  it("leaves failed and replay-tagged calls out by name and reads the rest", async () => {
    const { result } = await envoy();

    expect(result.droppedRecords).toEqual([]);
    expect(result.excludedSteps?.map(({ reason }) => reason).sort()).toEqual([
      "call_failed",
      "replay_traffic",
    ]);
    expect(result.runs.flatMap(({ steps }) => steps)).toHaveLength(7);
  });

  it("leaves a content-hidden span out by name", async () => {
    const { source } = await envoy();
    const [, second] = source
      .filter(
        (record) => attribute(spanOf(record), "session.id") === "envoy-s1",
      )
      .sort((left, right) =>
        BigInt(spanOf(left).startTimeUnixNano) <
        BigInt(spanOf(right).startTimeUnixNano)
          ? -1
          : 1,
      );

    for (const [valueKey, indexedPrefix] of [
      ["input.value", "llm.input_messages."],
      ["output.value", "llm.output_messages."],
    ] as const) {
      const hidden = withSpan(second!, (span) =>
        redacted(span, valueKey, indexedPrefix),
      );
      expect(openInferenceAdapter.adaptWithReport([hidden])).toEqual({
        runs: [],
        droppedRecords: [],
        excludedSteps: [
          { recordIndex: 0, traceId: "envoy-s1", reason: "content_hidden" },
        ],
      });
    }
  });

  it("reads a Phoenix export with indexed messages unchanged except for its session run key", async () => {
    const result = openInferenceAdapter.adaptWithReport(
      await records("openinference.jsonl"),
    );

    expect(result).toEqual({
      runs: [
        {
          version: "2",
          traceId: "oi-session-1",
          sourceFormat: "openinference",
          steps: [
            {
              stepIndex: 0,
              model: "acme/large-1",
              messages: [
                {
                  role: "user",
                  content:
                    "Reply to demo.person@example.test or call +1-202-555-0147 about order ORD-404.",
                },
                {
                  tools: [
                    { type: "function", function: { name: "lookup_order" } },
                  ],
                },
              ],
              output: [
                {
                  role: "assistant",
                  content: "I will check the order.",
                  "tool_calls.0.tool_call.id": "call-oi-1",
                  "tool_calls.0.tool_call.function.name": "lookup_order",
                  "tool_calls.0.tool_call.function.arguments": {
                    order_id: "ORD-404",
                  },
                },
              ],
              usage: { inputTokens: 30, outputTokens: 12 },
              family: "support",
              trajectoryId: "oi-session-1",
              timestamp: "100",
            },
            {
              stepIndex: 1,
              model: "acme/large-1",
              messages: [
                {
                  role: "tool",
                  content: "ready for pickup",
                  tool_call_id: "call-oi-1",
                },
              ],
              output: [
                {
                  role: "assistant",
                  content: "Order ORD-404 is ready for pickup.",
                },
              ],
              usage: { inputTokens: 18, outputTokens: 10 },
              family: "support",
              trajectoryId: "oi-session-1",
              timestamp: "200",
            },
          ],
        },
      ],
      droppedRecords: [],
    });
  });
});
