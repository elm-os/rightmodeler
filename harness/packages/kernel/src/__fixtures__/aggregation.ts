import type { Assessment, Execution } from "@rightmodeler/core";

import type { AggregationFact } from "../aggregation.js";

export interface FactOverrides {
  assessment?: Assessment | null;
  executionId?: string;
  attribution?: Execution["attribution"];
  candidateCostUsd?: number;
  candidateFamily?: string;
  candidateId?: string;
  caseId?: string;
  corpusSplit?: string;
  evaluatorKind?: string;
  expectedEvaluatorAssignments?: readonly {
    readonly caseId: string;
    readonly stratumId: string;
    readonly evaluatorKind: string;
  }[];
  evidenceCovered?: boolean;
  evidenceQuestionId?: string;
  familyId?: string;
  gatePolicyVersion?: string;
  hasDeterministicEvidence?: boolean;
  judgeModel?: string;
  judgeVersion?: string;
  orderConsistent?: boolean;
  passed?: boolean;
  score?: number;
  referenceCeilingMultiplier?: number;
  requiredAbstention?: boolean;
  requiresDeterministicEvidence?: boolean;
  stepId?: string;
  stratumId?: string;
  trajectoryId?: string;
  terminalOutcome?: Execution["terminalOutcome"];
  unsafeSubstitution?: boolean;
}

export function aggregationFact(
  index: number,
  overrides: FactOverrides = {},
): AggregationFact {
  const executionId = overrides.executionId ?? `execution-${index}`;
  const attribution = overrides.attribution ?? "ok";
  const execution: Execution = {
    executionId,
    evidenceQuestionId: overrides.evidenceQuestionId ?? "question-1",
    caseId: overrides.caseId ?? `case-${index}`,
    stepId: overrides.stepId ?? `step-${index % 2}`,
    candidateId: overrides.candidateId ?? "candidate-1",
    trajectoryId: overrides.trajectoryId ?? `trajectory-${index}`,
    corpusSplit: overrides.corpusSplit ?? "holdout",
    selectionStage: "confirm",
    terminalOutcome:
      overrides.terminalOutcome ??
      (overrides.requiredAbstention ? "abstain" : "success"),
    finalOutput: { answer: index },
    attribution,
  };
  const assessment =
    overrides.assessment === null || attribution !== "ok"
      ? undefined
      : (overrides.assessment ?? {
          assessmentId: `assessment-${index}`,
          executionId,
          evaluatorId: `evaluator-${overrides.judgeModel ?? "default"}`,
          metricName: "correctness",
          score: overrides.score ?? (overrides.passed === false ? 0 : 1),
          passed: overrides.passed ?? true,
          rubricVersion: overrides.judgeVersion ?? "rubric-1",
          artifactRef: null,
        });

  const fact: AggregationFact = {
    execution,
    assessment,
    gatePolicyVersion: overrides.gatePolicyVersion ?? "gate-1",
    familyId: overrides.familyId ?? "family-1",
    candidateFamily: overrides.candidateFamily ?? "candidate-family",
    evaluatorKind: overrides.evaluatorKind ?? "judge",
    candidateCostUsd: overrides.candidateCostUsd ?? 0.1,
    referenceCeilingMultiplier: overrides.referenceCeilingMultiplier ?? 1,
    unsafeSubstitution: overrides.unsafeSubstitution ?? false,
    evidenceCovered: overrides.evidenceCovered ?? true,
    expectedEvaluatorAssignments: overrides.expectedEvaluatorAssignments ?? [],
    stratumId: overrides.stratumId ?? "default",
    requiredAbstention: overrides.requiredAbstention ?? false,
    requiresDeterministicEvidence:
      overrides.requiresDeterministicEvidence ?? false,
    hasDeterministicEvidence: overrides.hasDeterministicEvidence ?? true,
    judgeModel: overrides.judgeModel,
    judgeVersion: overrides.judgeVersion,
    orderConsistent:
      overrides.orderConsistent ??
      ((overrides.evaluatorKind ?? "judge") === "judge" ? true : undefined),
  };
  return fact;
}

export function aggregationFacts(
  count: number,
  overrides: FactOverrides | ((index: number) => FactOverrides) = {},
): AggregationFact[] {
  const facts = Array.from({ length: count }, (_, index) =>
    aggregationFact(
      index,
      typeof overrides === "function" ? overrides(index) : overrides,
    ),
  );
  const expectedEvaluatorAssignments = facts.map((fact) => ({
    caseId: fact.execution.caseId,
    stratumId: fact.stratumId,
    evaluatorKind: fact.evaluatorKind,
  }));
  return facts.map((fact) =>
    fact.expectedEvaluatorAssignments.length === 0
      ? { ...fact, expectedEvaluatorAssignments }
      : fact,
  );
}

export function withExpectedAssignments(
  facts: readonly AggregationFact[],
): AggregationFact[] {
  const expectedEvaluatorAssignments = facts.map((fact) => ({
    caseId: fact.execution.caseId,
    stratumId: fact.stratumId,
    evaluatorKind: fact.evaluatorKind,
  }));
  return facts.map((fact) =>
    fact.expectedEvaluatorAssignments.length === 0
      ? { ...fact, expectedEvaluatorAssignments }
      : fact,
  );
}

const evaluatorKindAssignments = Array.from({ length: 20 }, (_, caseIndex) => ({
  caseId: `case-${caseIndex}`,
  stratumId: "default",
  evaluatorKind: caseIndex < 10 ? "deterministic" : "judge",
}));

export const aggregationScenarios = {
  partitionsAndJudgePooling: [
    ...aggregationFacts(10, (index) => ({
      judgeModel: index % 2 === 0 ? "judge-a" : "judge-b",
      judgeVersion: index % 2 === 0 ? "v1" : "v2",
      orderConsistent: index % 2 === 0,
      passed: index % 2 === 0,
    })),
    ...aggregationFacts(10, (index) => ({
      caseId: `case-${index + 10}`,
      evidenceQuestionId: "question-2",
      executionId: `execution-${index + 10}`,
      trajectoryId: `trajectory-${index + 10}`,
    })),
  ],
  evaluatorKinds: [
    ...Array.from({ length: 10 }, (_, index) =>
      aggregationFact(index, {
        evaluatorKind: "deterministic",
        expectedEvaluatorAssignments: evaluatorKindAssignments,
      }),
    ),
    ...Array.from({ length: 10 }, (_, offset) =>
      aggregationFact(offset + 10, {
        evaluatorKind: "judge",
        expectedEvaluatorAssignments: evaluatorKindAssignments,
        passed: offset < 7,
      }),
    ),
  ],
  excludedFraction: aggregationFacts(20, (index) => ({
    attribution: index === 18 ? "ambiguous" : index === 19 ? "lost" : "ok",
  })),
  availabilityDivergence: aggregationFacts(20, (index) => ({
    attribution: index >= 17 ? "silent-failure" : "ok",
  })),
  trajectoryClustering: aggregationFacts(10, (index) => ({
    trajectoryId: `trajectory-${Math.floor(index / 2)}`,
  })),
  insufficientReviewTrials: aggregationFacts(9),
  insufficientDistinctSteps: aggregationFacts(10, { stepId: "only-step" }),
  insufficientDistinctTrajectories: aggregationFacts(10, (index) => ({
    trajectoryId: `trajectory-${index % 4}`,
  })),
} satisfies Readonly<Record<string, readonly AggregationFact[]>>;
