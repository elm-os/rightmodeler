import {
  executionSchema,
  requestAttemptSchema,
  type Execution,
  type Ledger,
  type RequestAttempt,
} from "@rightmodeler/core";
import type { FamilyVerdict } from "@rightmodeler/kernel";
import { describe, expect, it } from "vitest";

import type { Corpus } from "./data/index.js";
import { familyReceipts } from "./pipeline.js";

const familyId = "summarize";
const candidateId = "acme/small-1";
const evidenceQuestionId = "question-1";
const stepIds = ["step-1", "step-2"] as const;

type ReplayPlan = Parameters<typeof familyReceipts>[1];
type ReplayOutput = Parameters<typeof familyReceipts>[2];
type Pricing = NonNullable<
  ReplayOutput["candidates"][number]["currentPricing"]
>;
type CurrentPricingByStep = readonly [Pricing | null, Pricing | null];

const plan = {
  top: 2,
  includeFreeModels: false,
  sampleSizes: { [familyId]: 3 },
  familyPlans: [],
  steps: stepIds.map((stepId) => ({
    family: familyId,
    stepId,
    evidenceQuestionId,
    currentModel: "acme/max-1",
    needsTools: false,
    needsStructuredOutput: false,
    observedContextTokens: 100,
  })),
  cases: [],
} satisfies ReplayPlan;

const verdict = {
  evidenceQuestionId,
  corpusSplit: "holdout",
  familyId,
  candidateId,
  candidateFamily: "acme-small",
  caseIds: ["case-1", "case-2", "case-3"],
  candidateCostUsd: 0.001,
  gatePolicyVersion: "policy-1",
  referenceCeilingMultiplier: 1,
  evaluatorKinds: [],
  weakestEvaluatorKind: "deterministic",
  nExecutions: 3,
  nReviewTrials: 3,
  nTrajectories: 3,
  nDistinctSteps: 2,
  excludedExecutions: 0,
  excludedFraction: 0,
  assessmentAbsent: 0,
  assessmentAbsentReasons: [],
  worstCaseBound: 1,
  availability: {
    availableExecutions: 3,
    executions: 3,
    rate: 1,
    lowerBound: 1,
  },
  unsafeSubstitutions: 0,
  coveredEvidenceCases: 3,
  requiredAbstentions: 0,
  satisfiedRequiredAbstentions: 0,
  decision: "recommend",
} satisfies FamilyVerdict;

const incumbentPricing: Pricing = { input: 0.001, output: 0.002 };

function replayOutput(
  currentPricingByStep: CurrentPricingByStep,
): ReplayOutput {
  return {
    completed: 3,
    skipped: 0,
    candidates: stepIds.map((stepId, index) => ({
      stepId,
      candidates: [],
      droppedByTop: 0,
      droppedFreeModels: 0,
      droppedByOutputCeiling: 0,
      currentPricing: currentPricingByStep[index]!,
    })),
    evaluation: {
      evaluatorKind: "deterministic",
      gateMetric: "quality",
      assessmentAbsences: [],
    },
    familyBlocks: [],
  };
}

function execution(
  executionId: string,
  caseId: string,
  stepId: string,
  terminalOutcome: Execution["terminalOutcome"] = "success",
  attribution: Execution["attribution"] = "ok",
  selectionStage = "shortlist",
): Execution {
  return executionSchema.parse({
    executionId,
    evidenceQuestionId,
    caseId,
    stepId,
    candidateId,
    trajectoryId: `trajectory-${caseId}`,
    corpusSplit: selectionStage === "holdout" ? "holdout" : "shortlist",
    selectionStage,
    terminalOutcome,
    finalOutput: null,
    attribution,
  });
}

function attempt(
  executionId: string,
  index: number,
  costUsd: number,
  latencyMs?: number,
): RequestAttempt {
  return requestAttemptSchema.parse({
    attemptId: `${executionId}-attempt-${index}`,
    logicalCallId: `${executionId}-call`,
    executionId,
    streamOutcome: "completed",
    usage: null,
    costUsd,
    costIsEstimate: false,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  });
}

function corpusCase(
  caseId: string,
  stepIndex: number,
  usage?: { inputTokens: number; outputTokens: number },
): Corpus["cases"][number] {
  return {
    caseId,
    content: {
      family: familyId,
      model: "acme/max-1",
      messages: [],
      output: null,
      trajectoryId: `trajectory-${caseId}`,
      stepIndex,
    },
    split: "shortlist",
    ...(usage === undefined ? {} : { observation: { usage, toolCalls: [] } }),
  };
}

const winnerExecutions = [
  execution("execution-1", "case-1", "step-1"),
  execution("execution-2", "case-2", "step-2"),
  execution("execution-3", "case-3", "step-1", "success", "ok", "holdout"),
];

const winnerAttemptInputs = [
  ["execution-1", 1, 0.005, 1],
  ["execution-1", 2, 0.01, 1_000],
  ["execution-2", 1, 0.01, 2],
  ["execution-2", 2, 0.02, 3],
  ["execution-3", 1, 0.015, 4],
  ["execution-3", 2, 0.03, 5],
] as const;

const winnerAttempts = winnerAttemptInputs.map(
  ([executionId, index, costUsd, latencyMs]) =>
    attempt(executionId, index, costUsd, latencyMs),
);
const cases = [
  corpusCase("case-1", 0, { inputTokens: 10, outputTokens: 5 }),
  corpusCase("case-2", 1, { inputTokens: 20, outputTokens: 10 }),
  corpusCase("case-3", 2, { inputTokens: 30, outputTokens: 15 }),
];

const excludedExecutions = [
  execution("failed", "case-1", "step-1", "failure"),
  execution("non-ok", "case-2", "step-2", "success", "lost"),
  execution("confirm", "case-3", "step-1", "success", "ok", "confirm"),
];
const excludedAttempts = excludedExecutions.map(({ executionId }, index) =>
  attempt(executionId, 1, 100, 10_000 + index),
);

function receipt({
  executions = winnerExecutions,
  requestAttempts = winnerAttempts,
  corpusCases = cases,
  currentPricingByStep = [incumbentPricing, incumbentPricing],
}: {
  executions?: readonly Execution[];
  requestAttempts?: readonly RequestAttempt[];
  corpusCases?: Corpus["cases"];
  currentPricingByStep?: CurrentPricingByStep;
} = {}) {
  const ledger: Ledger = {
    executions,
    requestAttempts,
    assessments: [],
    spendEvents: [],
    cascadeFindings: [],
    lifecycleEvents: [],
    droppedRows: 0,
  };
  const corpus = {
    corpusVersionId: "corpus-1",
    seed: 1,
    cases: corpusCases,
    strata: [{ family: familyId, corpusShare: 1, trafficShare: 1 }],
  } satisfies Corpus;

  return familyReceipts(
    ledger,
    plan,
    replayOutput(currentPricingByStep),
    corpus,
    [verdict],
  )[0]!;
}

describe("familyReceipts", () => {
  it("averages per-execution costs and sorts attempts for an even p50", () => {
    const result = receipt();

    expect(result.winnerCostPerCaseUsd).toBeCloseTo(0.03);
    expect(result.incumbentCostPerCaseUsd).toBeCloseTo(0.04);
    expect(result.costDeltaPct).toBeCloseTo(-25);
    expect(result.winnerLatencyP50Ms).toBe(3.5);
  });

  it("excludes failed, non-ok-attribution, and confirm executions", () => {
    const result = receipt({
      executions: [...winnerExecutions, ...excludedExecutions],
      requestAttempts: [...winnerAttempts, ...excludedAttempts],
    });

    expect(result).toEqual(receipt());
  });

  it("nulls the incumbent and delta when one winner case lacks usage", () => {
    const fourthExecution = execution("execution-4", "case-4", "step-2");
    const fourthAttempts = [
      attempt("execution-4", 1, 0.02, 6),
      attempt("execution-4", 2, 0.04, 7),
    ];
    const result = receipt({
      executions: [...winnerExecutions, fourthExecution],
      requestAttempts: [...winnerAttempts, ...fourthAttempts],
      corpusCases: [...cases, corpusCase("case-4", 3)],
    });

    expect(result.winnerCostPerCaseUsd).toBeCloseTo(0.0375);
    expect(result.incumbentCostPerCaseUsd).toBeNull();
    expect(result.costDeltaPct).toBeNull();
  });

  it("nulls unavailable incumbent pricing and a zero-cost delta", () => {
    const unpriced = receipt({
      currentPricingByStep: [null, incumbentPricing],
    });
    const zeroPriced = receipt({
      currentPricingByStep: [
        { input: 0, output: 0 },
        { input: 0, output: 0 },
      ],
    });

    expect(unpriced.incumbentCostPerCaseUsd).toBeNull();
    expect(unpriced.costDeltaPct).toBeNull();
    expect(zeroPriced.incumbentCostPerCaseUsd).toBe(0);
    expect(zeroPriced.costDeltaPct).toBeNull();
  });

  it("returns no p50 when eligible attempts have no latency", () => {
    const attemptsWithoutLatency = winnerAttemptInputs.map(
      ([executionId, index, costUsd]) => attempt(executionId, index, costUsd),
    );
    const result = receipt({
      executions: [...winnerExecutions, ...excludedExecutions],
      requestAttempts: [...attemptsWithoutLatency, ...excludedAttempts],
    });

    expect(result.winnerLatencyP50Ms).toBeNull();
  });
});
