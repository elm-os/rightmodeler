import { readFileSync } from "node:fs";

import type { StepRecord } from "@rightmodeler/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AMBIGUOUS_MODEL_ID_REASON,
  AMBIGUOUS_TRACE_KEY_REASON,
  reconcile,
} from "./index.js";

const fixtureSpanSchema = z.object({
  traceId: z.string(),
  startTimeUnixNano: z.string(),
  name: z.enum(["classify", "lookup", "answer"]),
  attributes: z.object({
    "gen_ai.request.model": z.string(),
  }),
});

function step(
  stepId: string,
  currentModel: string | null,
  traceKey?: string,
): StepRecord {
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
    ...(traceKey === undefined ? {} : { traceKey }),
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

  it("does not positionally join incomplete trajectories", () => {
    const result = reconcile(
      [
        { model: "acme/first", trajectoryId: "one", stepIndex: 0 },
        { model: "acme/second", trajectoryId: "one", stepIndex: 1 },
        { model: "acme/first", trajectoryId: "two", stepIndex: 0 },
      ],
      [step("first", null), step("second", null)],
    );

    expect(result.unmatchedTraceSteps).toHaveLength(3);
    expect(result.callSites.map(({ stepRecord }) => stepRecord)).toEqual([
      step("first", null),
      step("second", null),
    ]);
  });

  it("derives models and topology from the LangGraph fixture trajectory", () => {
    const fixture = z
      .array(fixtureSpanSchema)
      .parse(
        JSON.parse(
          readFileSync(
            new URL(
              "../../../fixtures/traces/langgraph-otel.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      )
      .filter(({ traceId }) => traceId === "trace-langgraph-01")
      .sort((left, right) =>
        left.startTimeUnixNano.localeCompare(right.startTimeUnixNano),
      );
    expect(fixture.map(({ name }) => name)).toEqual([
      "classify",
      "lookup",
      "answer",
    ]);

    const result = reconcile(
      fixture.map(({ attributes, traceId }, stepIndex) => ({
        model: attributes["gen_ai.request.model"],
        trajectoryId: traceId,
        stepIndex,
      })),
      [step("classify", null), step("lookup", null), step("answer", null)],
    );

    expect(
      result.callSites.map(({ stepRecord }) => ({
        stepId: stepRecord.stepId,
        currentModel: stepRecord.currentModel,
        downstreamStepIds: stepRecord.downstreamStepIds,
        prefixProvenance: stepRecord.prefixProvenance,
      })),
    ).toEqual([
      {
        stepId: "classify",
        currentModel: "acme/large-1",
        downstreamStepIds: ["lookup", "answer"],
        prefixProvenance: "external",
      },
      {
        stepId: "lookup",
        currentModel: "acme/max-1",
        downstreamStepIds: ["answer"],
        prefixProvenance: "model_authored",
      },
      {
        stepId: "answer",
        currentModel: "acme/large-1",
        downstreamStepIds: [],
        prefixProvenance: "model_authored",
      },
    ]);
  });

  it("joins by trace key when call sites share a model", () => {
    const result = reconcile(
      [
        { model: "acme/shared", family: "summarize" },
        { model: "acme/shared", family: "triage" },
      ],
      [
        step("summarize", "acme/shared", "summarize"),
        step("triage", "acme/shared", "triage"),
      ],
    );

    expect(
      result.traceSteps.map(({ status, stepId, via }) => ({
        status,
        stepId,
        via,
      })),
    ).toEqual([
      { status: "matched", stepId: "summarize", via: "trace_key" },
      { status: "matched", stepId: "triage", via: "trace_key" },
    ]);
    expect(result.callSites.map(({ status }) => status)).toEqual([
      "matched",
      "matched",
    ]);
  });

  it("narrows a shared trace key by model", () => {
    const result = reconcile(
      [{ model: "b", family: "summarize" }],
      [step("first", "a", "summarize"), step("second", "b", "summarize")],
    );

    expect(result.traceSteps).toEqual([
      expect.objectContaining({
        status: "matched",
        stepId: "second",
        via: "trace_key",
      }),
    ]);
  });

  it("keeps a shared trace key ambiguous when the model does not separate them", () => {
    const result = reconcile(
      [{ model: "acme/shared", family: "summarize" }],
      [
        step("first", "acme/shared", "summarize"),
        step("second", "acme/shared", "summarize"),
      ],
    );

    expect(result.ambiguousTraceSteps).toEqual([
      expect.objectContaining({
        reason: AMBIGUOUS_TRACE_KEY_REASON,
        candidateStepIds: ["first", "second"],
        via: "trace_key",
      }),
    ]);
    expect(
      result.ambiguousCallSites.map(({ stepRecord, reason }) => ({
        stepId: stepRecord.stepId,
        reason,
      })),
    ).toEqual([
      { stepId: "first", reason: AMBIGUOUS_TRACE_KEY_REASON },
      { stepId: "second", reason: AMBIGUOUS_TRACE_KEY_REASON },
    ]);
  });

  it("falls back to the model join for a family with no keyed call site", () => {
    const result = reconcile(
      [{ model: "acme/other", family: "unclassified" }],
      [
        step("summarize", "acme/shared", "summarize"),
        step("other", "acme/other"),
      ],
    );

    expect(result.traceSteps).toEqual([
      expect.objectContaining({
        status: "matched",
        stepId: "other",
        via: "model",
      }),
    ]);
  });

  it("enriches a call site bound by trace key from its own trajectories", () => {
    const result = reconcile(
      [
        {
          model: "acme/shared",
          family: "summarize",
          trajectoryId: "trace-1",
          stepIndex: 0,
        },
        {
          model: "acme/shared",
          family: "triage",
          trajectoryId: "trace-1",
          stepIndex: 1,
        },
      ],
      [
        step("summarize", "acme/shared", "summarize"),
        step("triage", "acme/shared", "triage"),
      ],
    );

    expect(result.callSites[0]?.stepRecord).toMatchObject({
      stepId: "summarize",
      downstreamStepIds: ["triage"],
      prefixProvenance: "external",
    });
  });
});
