import type { StepRecord } from "@rightmodeler/core";
import { describe, expect, it } from "vitest";

import { AMBIGUOUS_MODEL_ID_REASON, reconcile } from "./index.js";

function step(stepId: string, currentModel: string | null): StepRecord {
  return {
    stepId,
    callSite: { path: `src/${stepId}.ts`, line: 1, matcherSlug: "model-call" },
    family: "model-call",
    replayMode: "single_shot",
    prefixProvenance: "unknown",
    riskTier: "normal",
    capabilityRequirements: [],
    evaluatorLadder: [],
    currentModel,
    observedCostUsd: 0,
    downstreamStepIds: [],
    candidates: [],
    analysisHistory: [],
    status: "pending",
    contentHash: "hash",
  };
}

describe("trace-to-call-site reconciliation", () => {
  it("matches exact model ids and reports every unmatched side", () => {
    const result = reconcile(
      [
        { model: "acme/unique", caseId: "case-1" },
        { model: "acme/missing", caseId: "case-2" },
      ],
      [step("unique", "acme/unique"), step("unobserved", null)],
    );

    expect(result.caseStepLinks).toEqual([
      { caseId: "case-1", stepId: "unique" },
    ]);
    expect(result.unmatchedTraceSteps).toHaveLength(1);
    expect(
      result.unmatchedCallSites.map(({ stepRecord }) => stepRecord.stepId),
    ).toEqual(["unobserved"]);
  });

  it("marks both sides ambiguous when call sites share a model id", () => {
    const result = reconcile(
      [{ model: "acme/shared", caseId: "case-shared" }],
      [step("first", "acme/shared"), step("second", "acme/shared")],
    );

    expect(result.ambiguousTraceSteps).toEqual([
      expect.objectContaining({
        reason: AMBIGUOUS_MODEL_ID_REASON,
        candidateStepIds: ["first", "second"],
      }),
    ]);
    expect(result.ambiguousCallSites).toHaveLength(2);
    expect(
      result.ambiguousCallSites.every(
        ({ reason }) => reason === AMBIGUOUS_MODEL_ID_REASON,
      ),
    ).toBe(true);
    expect(result.caseStepLinks).toEqual([]);
  });
});
