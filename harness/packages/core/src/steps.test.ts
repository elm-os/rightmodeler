import { describe, expect, it } from "vitest";

import { stepRecordSchema } from "./steps.js";

const record = {
  stepId: "step-1",
  callSite: {
    path: "src/summarize.mjs",
    line: 3,
    matcherSlug: "js-ai-sdk-generate-text",
  },
  family: "js-ai-sdk-generate-text",
  replayMode: "single_shot",
  prefixProvenance: "unknown",
  riskTier: "standard",
  capabilityRequirements: [],
  evaluatorLadder: [],
  currentModel: null,
  observedCostUsd: 0,
  downstreamStepIds: [],
  candidates: [],
  analysisHistory: [],
  status: "pending",
  contentHash: "hash",
};

describe("stepRecordSchema", () => {
  it("accepts an optional trace key and rejects an empty one", () => {
    expect(stepRecordSchema.safeParse(record).success).toBe(true);
    expect(
      stepRecordSchema.parse({ ...record, traceKey: "summarize" }).traceKey,
    ).toBe("summarize");
    expect(
      stepRecordSchema.safeParse({ ...record, traceKey: "" }).success,
    ).toBe(false);
  });
});
