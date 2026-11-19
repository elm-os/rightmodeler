import { readFile } from "node:fs/promises";

import { toWireMessages } from "@rightmodeler/replay";
import { describe, expect, it } from "vitest";

import { crucibleAdapter, parseTraceRecords } from "../adapters.js";

interface CrucibleRecord {
  schema: string;
  span: Record<string, unknown>;
  facts: Record<string, unknown>[];
}

const trace = (suffix: string) => `c3a1e2f4b5d6478990a1b2c3d4e5f${suffix}`;

async function records(): Promise<CrucibleRecord[]> {
  return parseTraceRecords(
    await readFile(
      new URL("../../../../../fixtures/traces/crucible.jsonl", import.meta.url),
      "utf8",
    ),
  ) as CrucibleRecord[];
}

async function record(spanId: string): Promise<CrucibleRecord> {
  return (await records()).find(({ span }) => span.span_id === spanId)!;
}

function withSpan(
  source: CrucibleRecord,
  fields: Record<string, unknown>,
): CrucibleRecord {
  return { ...source, span: { ...source.span, ...fields } };
}

describe("Crucible span export", () => {
  it("maps a traced conversation into one ordered run and skips its agent and tool spans", async () => {
    const source = await records();
    const spans = source
      .map(({ span }) => span)
      .filter(({ trace_id }) => trace_id === trace("601"));
    const generations = spans.filter(
      ({ observation_type }) => observation_type === "generation",
    );
    const result = crucibleAdapter.adaptWithReport(source);
    const run = result.runs.find(({ traceId }) => traceId === trace("601"));

    expect(result.droppedRecords).toEqual([]);
    expect(spans).toHaveLength(4);
    expect(run?.steps.map(({ timestamp }) => timestamp)).toEqual(
      generations.map(({ start_time }) => start_time),
    );
    expect(run?.steps[0]?.output).toEqual(generations[0]!.output);
    expect(run?.steps[1]?.messages).toEqual([
      ...(generations[1]!.input as unknown[]),
      { tool_definitions: generations[1]!.tool_definitions },
    ]);
    run?.steps.forEach((step, index) => {
      expect(step).toMatchObject({
        family: "support",
        systemPrompt: "Help the customer.",
        trajectoryId: "cr-session-1",
        costUsd: generations[index]!.total_cost_usd,
        durationMs: (generations[index]!.duration_us as number) / 1000,
      });
    });
  });

  it("sends a text-only call to replay and keeps a call that offered tools out", async () => {
    const replayed = await record("708192a3b4c5d6e7");
    const [textOnly] = crucibleAdapter.adapt([
      withSpan(replayed, { attributes: {} }),
    ])[0]!.steps;
    const [offeredTools] = crucibleAdapter
      .adapt(await records())
      .find(({ traceId }) => traceId === trace("601"))!.steps;

    expect(toWireMessages(textOnly!.messages)).toEqual([
      { role: "user", content: "Summarize: the parcel left the depot." },
    ]);
    expect(() => toWireMessages(offeredTools!.messages)).toThrow(
      "role is unsupported",
    );
  });

  it("leaves cut, failed and replay calls out by name", async () => {
    const result = crucibleAdapter.adaptWithReport(await records());

    expect(
      result.excludedSteps?.map(({ traceId, reason }) => [traceId, reason]),
    ).toEqual([
      [trace("604"), "content_truncated"],
      [trace("605"), "call_failed"],
      [trace("606"), "replay_traffic"],
    ]);
    expect(result.runs.flatMap(({ steps }) => steps)).toHaveLength(4);
  });

  it("reads a raw body's messages and keeps the recorded output over a correction", async () => {
    const summarize = await record("3c4d5e6f708192a3");
    const [run] = crucibleAdapter.adapt([summarize]);

    expect(summarize.facts).toContainEqual(
      expect.objectContaining({ table: "fact_corrections", key: "output" }),
    );
    expect(run?.steps[0]).toMatchObject({
      model: "acme/large-1",
      messages: (summarize.span.input as { messages: unknown[] }).messages,
      output: summarize.span.output,
      family: "summarize",
      costUsd: 0.00034,
      trajectoryId: trace("602"),
    });
  });

  it("reads an indexed body in index order and the response model first", async () => {
    const triage = await record("4d5e6f708192a3b4");
    const input = triage.span.input as Record<string, unknown>;
    const [step] = crucibleAdapter.adapt([triage])[0]!.steps;
    const [requested] = crucibleAdapter.adapt([
      withSpan(triage, { model_response: "" }),
    ])[0]!.steps;
    const [unindexedOutput] = crucibleAdapter.adapt([
      withSpan(triage, { output: "refund" }),
    ])[0]!.steps;

    expect(step).toMatchObject({
      model: "acme/small-1-0801",
      messages: [input["0"], input["1"]],
      output: [{ role: "assistant", content: "refund" }],
      family: "triage",
    });
    expect(requested?.model).toBe("acme/small-1");
    expect(unindexedOutput?.output).toBe("refund");
  });

  it("reads an indexed body that Crucible stored as the message array", async () => {
    const triage = await record("4d5e6f708192a3b4");
    const input = triage.span.input as Record<string, unknown>;
    const output = triage.span.output as Record<string, unknown>;
    const result = crucibleAdapter.adaptWithReport([
      withSpan(triage, {
        input: [input["0"], input["1"]],
        output: [output["0"]],
      }),
      withSpan(triage, { input: "refund" }),
    ]);

    expect(result.runs[0]?.steps[0]).toMatchObject({
      messages: [input["0"], input["1"]],
      output: [output["0"]],
    });
    expect(result.droppedRecords.map(({ reason }) => reason)).toEqual([
      "Crucible record 2 input must be a message array or an object keyed by message index",
    ]);
  });

  it("reads an unfinished stream, unrecorded content and an unpriced call", async () => {
    const triage = await record("4d5e6f708192a3b4");
    const result = crucibleAdapter.adaptWithReport([
      withSpan(triage, { output: "", finish_reasons: [] }),
      withSpan(triage, { input: "", output: "" }),
      withSpan(triage, { cost_source: "none", total_cost_usd: 0 }),
    ]);

    expect(result.excludedSteps?.map(({ reason }) => reason)).toEqual([
      "stream_incomplete",
      "content_hidden",
    ]);
    expect(result.runs[0]?.steps).toHaveLength(1);
    expect(result.runs[0]?.steps[0]?.costUsd).toBeUndefined();
  });

  it("reads a body Crucible cut as opaque text", async () => {
    const triage = await record("4d5e6f708192a3b4");
    const [run] = crucibleAdapter.adapt([
      withSpan(triage, {
        metadata: '{"rightmodeler.family":"triage"}',
        truncated_fields: ["metadata"],
      }),
    ]);

    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]?.family).toBeUndefined();
  });

  it("names a record of another schema version as a dropped record", async () => {
    const newer = {
      ...(await record("4d5e6f708192a3b4")),
      schema: "crucible.span/2",
    };
    const result = crucibleAdapter.adaptWithReport([newer]);

    expect(crucibleAdapter.detect([newer])).toBeGreaterThanOrEqual(0.75);
    expect(result.droppedRecords).toEqual([
      {
        recordIndex: 0,
        reason:
          "Crucible record 1 has schema crucible.span/2; this rightmodeler reads crucible.span/1",
      },
    ]);
  });
});
