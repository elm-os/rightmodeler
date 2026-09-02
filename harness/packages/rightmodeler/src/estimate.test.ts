import type { ModelCatalogEntry, StepShortlist } from "@rightmodeler/replay";
import { describe, expect, it } from "vitest";

import { estimateReplayCost } from "./estimate.js";

const first = model("provider/first", 0.001, 0.002);
const second = model("provider/second", 0.002, 0.003);
const judge = {
  modelId: "provider/judge",
  pricing: { input: 0.0001, output: 0.0002 },
  maxOutputTokens: 100,
};
const candidates: StepShortlist[] = [
  {
    stepId: "step-1",
    candidates: [first, second],
    droppedByTop: 0,
    droppedFreeModels: 0,
    droppedByOutputCeiling: 0,
  },
  {
    stepId: "step-2",
    candidates: [first, second],
    droppedByTop: 0,
    droppedFreeModels: 0,
    droppedByOutputCeiling: 0,
  },
];

describe("estimateReplayCost", () => {
  it("prices every shortlist cell and the most expensive possible holdout winner", () => {
    const estimate = estimateReplayCost({
      steps: [
        { family: "family", stepId: "step-1" },
        { family: "family", stepId: "step-2" },
      ],
      cases: [
        replayCase("shortlist", "step-1", 100, 10),
        replayCase("shortlist", "step-2", 50, 5),
        replayCase("holdout", "step-1", 200, 20),
        replayCase("holdout", "step-2", 100, 10),
      ],
      candidates,
      judge,
    });

    expect(estimate.shortlistCostUsd).toBeCloseTo(0.525);
    expect(estimate.holdoutCostUsd).toBeCloseTo(0.69);
    expect(estimate.projectedCostUsd).toBeCloseTo(
      1.215 + estimate.judgeCostUsd,
    );
    expect(estimate.candidateExecutions).toBe(6);
    expect(estimate.judgeCalls).toBe(12);
    expect(estimate).toMatchObject({
      corpusCases: 4,
      shortlistCases: 2,
      holdoutCases: 2,
      shortlist: [
        {
          stepId: "step-1",
          candidateIds: ["provider/first", "provider/second"],
        },
        {
          stepId: "step-2",
          candidateIds: ["provider/first", "provider/second"],
        },
      ],
    });
  });

  it("fails loudly when a case references an unknown step", () => {
    expect(() =>
      estimateReplayCost({
        steps: [],
        cases: [replayCase("shortlist", "missing", 1, 1)],
        candidates: [],
        judge: undefined,
      }),
    ).toThrow("unknown step: missing");
  });

  it("fails loudly when a shortlisted candidate has no price", () => {
    expect(() =>
      estimateReplayCost({
        steps: [{ family: "family", stepId: "step-1" }],
        cases: [replayCase("shortlist", "step-1", 1, 1)],
        candidates: [
          {
            stepId: "step-1",
            candidates: [{ ...first, pricing: null }],
            droppedByTop: 0,
            droppedFreeModels: 0,
            droppedByOutputCeiling: 0,
          },
        ],
        judge: undefined,
      }),
    ).toThrow("Shortlisted candidate has no pricing: provider/first");
  });

  it("omits judge cost when an external evaluator is configured", () => {
    const estimate = estimateReplayCost({
      steps: [],
      cases: [],
      candidates: [],
      judge: undefined,
    });

    expect(estimate.judgeCostUsd).toBe(0);
    expect(estimate.judgeCalls).toBe(0);
    expect(
      estimate.exclusions.some((exclusion) =>
        exclusion.includes("Built-in judge"),
      ),
    ).toBe(false);
  });
});

function model(id: string, input: number, output: number): ModelCatalogEntry {
  return {
    id,
    family: id.split("/")[0]!,
    contextLength: 128_000,
    pricing: { input, output },
    supportsTools: true,
    supportsStructuredOutput: true,
  };
}

function replayCase(
  corpusSplit: "shortlist" | "holdout",
  stepId: string,
  contextTokens: number,
  maxOutputTokens: number,
) {
  return { corpusSplit, stepId, contextTokens, maxOutputTokens } as const;
}
