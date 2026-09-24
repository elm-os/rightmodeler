import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { bifrostAdapter, parseTraceRecords } from "../adapters.js";

type BifrostRow = Record<string, unknown> & {
  id: string;
  session_id?: string;
  timestamp: string;
};

async function rows(): Promise<BifrostRow[]> {
  return parseTraceRecords(
    await readFile(
      new URL("../../../../../fixtures/traces/bifrost.jsonl", import.meta.url),
      "utf8",
    ),
  ) as BifrostRow[];
}

async function session(id: string): Promise<BifrostRow[]> {
  return (await rows())
    .filter(({ session_id }) => session_id === id)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

describe("Bifrost log export", () => {
  it("maps a Bifrost tool round trip into one ordered run with its calls intact", async () => {
    const captured = await session("bf-s2");
    const result = bifrostAdapter.adaptWithReport(await rows());
    const run = result.runs.find(({ traceId }) => traceId === "bf-s2");

    expect(captured).toHaveLength(2);
    expect(run?.steps).toHaveLength(2);
    expect(run?.steps.map(({ timestamp }) => timestamp)).toEqual(
      captured.map(({ timestamp }) => timestamp),
    );
    expect(run?.steps[1]?.messages).toEqual(captured[1]!.input_history);
    expect(run?.steps[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({
            function: expect.objectContaining({ name: "lookup_order" }),
          }),
        ],
      }),
    );
    expect(run?.steps[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: expect.any(String),
      }),
    );
    run?.steps.forEach((step, index) => {
      expect(step).toMatchObject({
        model: "vercel/amazon/nova-micro",
        family: "support",
        trajectoryId: "bf-s2",
        costUsd: captured[index]!.cost,
        durationMs: captured[index]!.latency,
        retryCount: captured[index]!.number_of_retries,
      });
    });
  });

  it("leaves failed calls, fallback answers and replay traffic out by name", async () => {
    const result = bifrostAdapter.adaptWithReport(await rows());

    expect(result.droppedRecords).toEqual([]);
    expect(
      result.excludedSteps?.map(({ traceId, reason }) => [traceId, reason]),
    ).toEqual(
      expect.arrayContaining([
        ["bf-s5", "call_failed"],
        ["bf-s5", "fallback_answer"],
        ["bf-s6", "replay_traffic"],
      ]),
    );
    expect(result.excludedSteps).toHaveLength(3);
    expect(result.runs.flatMap(({ steps }) => steps)).toHaveLength(6);
  });

  it("takes the caller's alias as the recorded model", async () => {
    const [row] = await session("bf-s3");
    const [run] = bifrostAdapter.adapt([{ ...row, alias: "fast" }]);

    expect(run?.steps[0]?.model).toBe("vercel/fast");
  });

  it("reads a still-running row as unfinished and a content-hidden row as hidden", async () => {
    const [row] = await session("bf-s3");
    const result = bifrostAdapter.adaptWithReport([
      { ...row, status: "processing" },
      { ...row, content_hidden: true },
    ]);

    expect(result.excludedSteps?.map(({ reason }) => reason)).toEqual([
      "stream_incomplete",
      "content_hidden",
    ]);
    expect(result.runs).toEqual([]);
  });

  it("names a non-chat log row as a dropped record with the export filter", async () => {
    const [row] = await session("bf-s3");
    const result = bifrostAdapter.adaptWithReport([
      row,
      { ...row, id: "bf-embedding", object: "embedding" },
    ]);

    expect(result.runs).toHaveLength(1);
    expect(result.droppedRecords).toEqual([
      {
        recordIndex: 1,
        reason:
          "Bifrost log bf-embedding is not a chat completion (object embedding); export chat completions only (objects=chat_completion,chat_completion_stream)",
      },
    ]);
  });
});
