import type { Assessment, Execution } from "@rightmodeler/core";

import {
  MIN_DISTINCT_STEPS,
  MIN_DISTINCT_TRAJECTORIES,
  MIN_REVIEW_TRIALS,
  clusterBootstrap,
  wilson,
} from "./statistics.js";
import type { Interval } from "./statistics.js";

export const EXCLUDED_FRACTION_MAX = 0.05;
export const DEFAULT_PASS_FRACTION = 0.75;

const AGGREGATION_BOOTSTRAP_RESAMPLES = 2_000;

export const ABSTAIN_REASONS = [
  "insufficient_availability",
  "excluded_fraction_exceeded",
  "insufficient_review_trials",
  "insufficient_distinct_steps",
  "insufficient_distinct_trajectories",
  "missing_deterministic_evidence",
  "required_abstention",
  "incomplete_evidence_coverage",
  "incomplete_evaluator_coverage",
] as const;

export type AbstainReason = (typeof ABSTAIN_REASONS)[number];
export interface AbstainReasonDetails {
  readonly reason: AbstainReason;
  readonly observed: number;
  readonly required: number;
}
export type FamilyDecision =
  "recommend" | "reject" | "abstain" | "inconclusive";

/**
 * A joined execution and its assigned evaluation context.
 *
 * Core ledger facts stay strict and immutable. Materialization joins them with
 * the predeclared evaluator assignment and release-eval labels before this
 * package derives a verdict.
 */
export interface AggregationFact {
  readonly execution: Execution;
  readonly assessment?: Assessment;
  readonly gatePolicyVersion: string;
  readonly familyId: string;
  readonly candidateFamily: string;
  readonly evaluatorKind: string;
  readonly candidateCostUsd: number;
  readonly referenceCeilingMultiplier: number;
  readonly unsafeSubstitution: boolean;
  readonly evidenceCovered: boolean;
  readonly expectedEvaluatorAssignments: readonly {
    readonly caseId: string;
    readonly stratumId: string;
    readonly evaluatorKind: string;
  }[];
  readonly stratumId: string;
  readonly requiredAbstention: boolean;
  readonly requiresDeterministicEvidence: boolean;
  readonly hasDeterministicEvidence: boolean;
  readonly judgeModel?: string;
  readonly judgeVersion?: string;
  readonly orderConsistent?: boolean;
}

export interface TrajectoryCluster {
  readonly trajectoryId: string;
  readonly passes: number;
  readonly trials: number;
}

export interface EvaluatorKindVerdict {
  readonly evaluatorKind: string;
  readonly conditionalExecutions: number;
  readonly passes: number;
  readonly trials: number;
  readonly passRate: number;
  readonly averageScore: number;
  readonly orderConsistencyRate?: number;
  readonly nTrajectories: number;
  readonly nDistinctSteps: number;
  readonly excludedExecutions: number;
  readonly excludedFraction: number;
  readonly worstCasePassRate: number;
  readonly worstCaseBound: number;
  readonly naiveInterval?: Interval;
  readonly clusterBootstrapLow?: number;
  readonly trajectoryClusters: readonly TrajectoryCluster[];
}

export interface AvailabilityVerdict {
  readonly availableExecutions: number;
  readonly executions: number;
  readonly rate: number;
  readonly lowerBound: number;
  readonly naiveInterval?: Interval;
  readonly clusterBootstrapLow?: number;
}

interface FamilyVerdictBase {
  readonly evidenceQuestionId: string;
  readonly corpusSplit: string;
  readonly familyId: string;
  readonly candidateId: string;
  readonly candidateFamily: string;
  readonly caseIds: readonly string[];
  readonly candidateCostUsd: number;
  readonly gatePolicyVersion: string;
  readonly referenceCeilingMultiplier: number;
  readonly evaluatorKinds: readonly EvaluatorKindVerdict[];
  readonly weakestEvaluatorKind: string;
  readonly nExecutions: number;
  readonly nReviewTrials: number;
  readonly nTrajectories: number;
  readonly nDistinctSteps: number;
  readonly excludedExecutions: number;
  readonly excludedFraction: number;
  readonly worstCaseBound: number;
  readonly naiveInterval?: Interval;
  readonly clusterBootstrapLow?: number;
  readonly availability: AvailabilityVerdict;
  readonly unsafeSubstitutions: number;
  readonly coveredEvidenceCases: number;
  readonly requiredAbstentions: number;
  readonly satisfiedRequiredAbstentions: number;
  readonly modeAOptimismDelta?: number;
}

export type FamilyVerdict = FamilyVerdictBase &
  (
    | {
        readonly decision: "abstain";
        readonly abstainReason: AbstainReasonDetails;
      }
    | {
        readonly decision: Exclude<FamilyDecision, "abstain">;
        readonly abstainReason?: never;
      }
  );

export interface AggregateOptions {
  readonly gatePolicyVersion: string;
  readonly qualityFloor: number;
  readonly availabilityFloor: number;
}

export function aggregate(
  facts: readonly AggregationFact[],
  { gatePolicyVersion, qualityFloor, availabilityFloor }: AggregateOptions,
): FamilyVerdict[] {
  if (gatePolicyVersion.length === 0) {
    throw new TypeError("gatePolicyVersion must not be empty");
  }
  validateFloor(qualityFloor, "qualityFloor");
  validateFloor(availabilityFloor, "availabilityFloor");

  const executionIds = new Set<string>();
  const groups = new Map<string, AggregationFact[]>();
  for (const fact of facts) {
    validateFact(fact);
    if (fact.gatePolicyVersion !== gatePolicyVersion) {
      throw new Error(
        `execution ${fact.execution.executionId} was produced under a different gate policy`,
      );
    }
    if (executionIds.has(fact.execution.executionId)) {
      throw new Error(`duplicate execution ${fact.execution.executionId}`);
    }
    executionIds.add(fact.execution.executionId);

    const key = JSON.stringify([
      fact.execution.evidenceQuestionId,
      fact.execution.candidateId,
      fact.execution.corpusSplit,
    ]);
    const group = groups.get(key);
    if (group) {
      group.push(fact);
    } else {
      groups.set(key, [fact]);
    }
  }

  return [...groups.values()]
    .map((group) =>
      aggregateGroup(group, gatePolicyVersion, qualityFloor, availabilityFloor),
    )
    .sort(compareVerdicts);
}

function aggregateGroup(
  facts: readonly AggregationFact[],
  gatePolicyVersion: string,
  qualityFloor: number,
  availabilityFloor: number,
): FamilyVerdict {
  const first = facts[0]!;
  assertConsistentGroup(facts, first);

  const included = facts.filter(
    (fact) => !fact.requiredAbstention && fact.execution.attribution === "ok",
  );
  const excludedExecutions = facts.filter(
    (fact) => fact.execution.attribution !== "ok",
  ).length;
  const excludedFraction = excludedExecutions / facts.length;
  const trajectories = new Set(
    included.map((fact) => fact.execution.trajectoryId),
  );
  const steps = new Set(included.map((fact) => fact.execution.stepId));
  const evaluatorKinds = [...new Set(facts.map((fact) => fact.evaluatorKind))]
    .sort(compareText)
    .map((evaluatorKind) =>
      aggregateEvaluatorKind(
        facts.filter((fact) => fact.evaluatorKind === evaluatorKind),
        evaluatorKind,
        first.execution.evidenceQuestionId,
      ),
    );
  const presentEvaluatorAssignments = new Set(
    facts.map((fact) =>
      assignmentKey(fact.execution.caseId, fact.stratumId, fact.evaluatorKind),
    ),
  );
  const hasDuplicateEvaluatorAssignments =
    presentEvaluatorAssignments.size !== facts.length;
  const expectedEvaluatorAssignments = new Set(
    first.expectedEvaluatorAssignments.map((assignment) =>
      assignmentKey(
        assignment.caseId,
        assignment.stratumId,
        assignment.evaluatorKind,
      ),
    ),
  );
  const hasCompleteEvaluatorCoverage =
    !hasDuplicateEvaluatorAssignments &&
    presentEvaluatorAssignments.size === expectedEvaluatorAssignments.size &&
    [...expectedEvaluatorAssignments].every((assignment) =>
      presentEvaluatorAssignments.has(assignment),
    );
  const assignmentCounts = new Map<string, number>();
  for (const fact of facts) {
    const key = assignmentKey(
      fact.execution.caseId,
      fact.stratumId,
      fact.evaluatorKind,
    );
    assignmentCounts.set(key, (assignmentCounts.get(key) ?? 0) + 1);
  }
  const completeEvaluatorAssignments = [...expectedEvaluatorAssignments].filter(
    (assignment) => assignmentCounts.get(assignment) === 1,
  ).length;
  const weakest = [...evaluatorKinds].sort(
    (left, right) =>
      left.worstCaseBound - right.worstCaseBound ||
      compareText(left.evaluatorKind, right.evaluatorKind),
  )[0]!;
  const hasClusteredQuality = evaluatorKinds.some(
    (kind) => kind.clusterBootstrapLow !== undefined,
  );
  const conditionalQualityLow = Math.min(
    ...evaluatorKinds.map(
      (kind) => kind.clusterBootstrapLow ?? kind.naiveInterval!.lower,
    ),
  );
  const availability = aggregateAvailability(
    facts,
    first.execution.evidenceQuestionId,
  );
  const unsafeSubstitutions = facts.filter(
    (fact) => fact.unsafeSubstitution,
  ).length;
  const coveredEvidenceCases = facts.filter(
    (fact) => fact.evidenceCovered,
  ).length;
  const requiredAbstentions = facts.filter(
    (fact) => fact.requiredAbstention,
  ).length;
  const satisfiedRequiredAbstentions = facts.filter(
    (fact) =>
      fact.requiredAbstention &&
      fact.execution.attribution === "ok" &&
      fact.execution.terminalOutcome === "abstain",
  ).length;
  const abstainReason = findAbstainReason({
    evaluatorKinds,
    availability,
    availabilityFloor,
    requiresDeterministicEvidence: facts.some(
      (fact) => fact.requiresDeterministicEvidence,
    ),
    hasDeterministicEvidence: facts.some(
      (fact) => fact.hasDeterministicEvidence,
    ),
    requiredAbstentions,
    satisfiedRequiredAbstentions,
    coveredEvidenceCases,
    nExecutions: facts.length,
    hasCompleteEvaluatorCoverage,
    completeEvaluatorAssignments,
    requiredEvaluatorAssignments: Math.max(
      expectedEvaluatorAssignments.size,
      facts.length,
    ),
  });
  const base: FamilyVerdictBase = {
    evidenceQuestionId: first.execution.evidenceQuestionId,
    corpusSplit: first.execution.corpusSplit,
    familyId: first.familyId,
    candidateId: first.execution.candidateId,
    candidateFamily: first.candidateFamily,
    caseIds: facts.map((fact) => fact.execution.caseId).sort(compareText),
    candidateCostUsd: first.candidateCostUsd,
    gatePolicyVersion,
    referenceCeilingMultiplier: first.referenceCeilingMultiplier,
    evaluatorKinds,
    weakestEvaluatorKind: weakest.evaluatorKind,
    nExecutions: facts.length,
    nReviewTrials: included.length,
    nTrajectories: trajectories.size,
    nDistinctSteps: steps.size,
    excludedExecutions,
    excludedFraction,
    worstCaseBound: weakest.worstCaseBound,
    ...(hasClusteredQuality
      ? { clusterBootstrapLow: conditionalQualityLow }
      : { naiveInterval: weakest.naiveInterval! }),
    availability,
    unsafeSubstitutions,
    coveredEvidenceCases,
    requiredAbstentions,
    satisfiedRequiredAbstentions,
  };
  return abstainReason === undefined
    ? {
        ...base,
        decision: decide({
          unsafeSubstitutions,
          weakestWorstCaseBound: weakest.worstCaseBound,
          qualityFloor,
          availabilityLowerBound: availability.lowerBound,
          availabilityFloor,
        }),
      }
    : { ...base, decision: "abstain", abstainReason };
}

function aggregateEvaluatorKind(
  facts: readonly AggregationFact[],
  evaluatorKind: string,
  evidenceQuestionId: string,
): EvaluatorKindVerdict {
  const conditionalFacts = facts.filter((fact) => !fact.requiredAbstention);
  const included = conditionalFacts.filter(
    (fact) => fact.execution.attribution === "ok",
  );
  const passes = included.filter(
    (fact) => fact.assessment!.passed && fact.orderConsistent !== false,
  ).length;
  const scoreTotal = included.reduce(
    (total, fact) =>
      total + (fact.orderConsistent === false ? 0 : fact.assessment!.score),
    0,
  );
  const judgeFacts = included.filter((fact) => fact.judgeModel !== undefined);
  const orderConsistency = judgeFacts.flatMap((fact) =>
    fact.orderConsistent === undefined ? [] : [fact.orderConsistent],
  );
  const excludedExecutions = conditionalFacts.length - included.length;
  const includedOutcomes = outcomesByTrajectory(included, (fact) =>
    Boolean(fact.assessment!.passed && fact.orderConsistent !== false),
  );
  const worstCaseOutcomes = outcomesByTrajectory(
    conditionalFacts,
    (fact) =>
      fact.execution.attribution === "ok" &&
      fact.orderConsistent !== false &&
      Boolean(fact.assessment!.passed),
  );
  const clustered = hasRepeatedTrajectory(worstCaseOutcomes);
  const nTrajectories = Object.keys(includedOutcomes).length;
  const nDistinctSteps = new Set(included.map((fact) => fact.execution.stepId))
    .size;
  const conditionalInterval = clustered
    ? included.length === 0
      ? { point: 0, lower: 0, upper: 1 }
      : clusterBootstrap(includedOutcomes, {
          resamples: AGGREGATION_BOOTSTRAP_RESAMPLES,
          seed: stableSeed(`${evidenceQuestionId}\0${evaluatorKind}\0quality`),
        })
    : wilson(passes, included.length);
  const worstCaseBound = lowerBound(
    worstCaseOutcomes,
    passes,
    conditionalFacts.length,
    stableSeed(`${evidenceQuestionId}\0${evaluatorKind}\0worst-case`),
  );

  return {
    evaluatorKind,
    conditionalExecutions: conditionalFacts.length,
    passes,
    trials: included.length,
    passRate: included.length === 0 ? 0 : passes / included.length,
    averageScore: included.length === 0 ? 0 : scoreTotal / included.length,
    ...(orderConsistency.length === 0
      ? {}
      : {
          orderConsistencyRate:
            orderConsistency.filter(Boolean).length / orderConsistency.length,
        }),
    nTrajectories,
    nDistinctSteps,
    excludedExecutions,
    excludedFraction:
      conditionalFacts.length === 0
        ? 0
        : excludedExecutions / conditionalFacts.length,
    worstCasePassRate:
      conditionalFacts.length === 0 ? 0 : passes / conditionalFacts.length,
    worstCaseBound,
    ...(clustered
      ? { clusterBootstrapLow: conditionalInterval.lower }
      : { naiveInterval: conditionalInterval }),
    trajectoryClusters: summarizeTrajectories(worstCaseOutcomes),
  };
}

function aggregateAvailability(
  facts: readonly AggregationFact[],
  evidenceQuestionId: string,
): AvailabilityVerdict {
  const availableExecutions = facts.filter(
    (fact) => fact.execution.attribution !== "silent-failure",
  ).length;
  const outcomes = outcomesByTrajectory(
    facts,
    (fact) => fact.execution.attribution !== "silent-failure",
  );
  const clustered = hasRepeatedTrajectory(outcomes);
  const interval = clustered
    ? clusterBootstrap(outcomes, {
        resamples: AGGREGATION_BOOTSTRAP_RESAMPLES,
        seed: stableSeed(`${evidenceQuestionId}\0availability`),
      })
    : wilson(availableExecutions, facts.length);

  return {
    availableExecutions,
    executions: facts.length,
    rate: availableExecutions / facts.length,
    lowerBound: interval.lower,
    ...(clustered
      ? { clusterBootstrapLow: interval.lower }
      : { naiveInterval: interval }),
  };
}

function findAbstainReason(input: {
  readonly evaluatorKinds: readonly EvaluatorKindVerdict[];
  readonly availability: AvailabilityVerdict;
  readonly availabilityFloor: number;
  readonly requiresDeterministicEvidence: boolean;
  readonly hasDeterministicEvidence: boolean;
  readonly requiredAbstentions: number;
  readonly satisfiedRequiredAbstentions: number;
  readonly coveredEvidenceCases: number;
  readonly nExecutions: number;
  readonly hasCompleteEvaluatorCoverage: boolean;
  readonly completeEvaluatorAssignments: number;
  readonly requiredEvaluatorAssignments: number;
}): AbstainReasonDetails | undefined {
  const reviewTrials = Math.min(
    ...input.evaluatorKinds.map((kind) => kind.trials),
  );
  if (reviewTrials < MIN_REVIEW_TRIALS) {
    return abstention(
      "insufficient_review_trials",
      reviewTrials,
      MIN_REVIEW_TRIALS,
    );
  }
  const distinctSteps = Math.min(
    ...input.evaluatorKinds.map((kind) => kind.nDistinctSteps),
  );
  if (distinctSteps < MIN_DISTINCT_STEPS) {
    return abstention(
      "insufficient_distinct_steps",
      distinctSteps,
      MIN_DISTINCT_STEPS,
    );
  }
  const distinctTrajectories = Math.min(
    ...input.evaluatorKinds.map((kind) => kind.nTrajectories),
  );
  if (distinctTrajectories < MIN_DISTINCT_TRAJECTORIES) {
    return abstention(
      "insufficient_distinct_trajectories",
      distinctTrajectories,
      MIN_DISTINCT_TRAJECTORIES,
    );
  }
  if (input.requiresDeterministicEvidence && !input.hasDeterministicEvidence) {
    return abstention("missing_deterministic_evidence", 0, 1);
  }
  if (input.satisfiedRequiredAbstentions < input.requiredAbstentions) {
    return abstention(
      "required_abstention",
      input.satisfiedRequiredAbstentions,
      input.requiredAbstentions,
    );
  }
  if (input.coveredEvidenceCases < input.nExecutions) {
    return abstention(
      "incomplete_evidence_coverage",
      input.coveredEvidenceCases,
      input.nExecutions,
    );
  }
  if (!input.hasCompleteEvaluatorCoverage) {
    return abstention(
      "incomplete_evaluator_coverage",
      input.completeEvaluatorAssignments,
      input.requiredEvaluatorAssignments,
    );
  }
  if (input.availability.lowerBound < input.availabilityFloor) {
    return abstention(
      "insufficient_availability",
      input.availability.lowerBound,
      input.availabilityFloor,
    );
  }
  const excludedFraction = Math.max(
    ...input.evaluatorKinds.map((kind) => kind.excludedFraction),
  );
  if (excludedFraction > EXCLUDED_FRACTION_MAX) {
    return abstention(
      "excluded_fraction_exceeded",
      excludedFraction,
      EXCLUDED_FRACTION_MAX,
    );
  }
  return undefined;
}

function abstention(
  reason: AbstainReason,
  observed: number,
  required: number,
): AbstainReasonDetails {
  return { reason, observed, required };
}

function decide(input: {
  readonly unsafeSubstitutions: number;
  readonly weakestWorstCaseBound: number;
  readonly qualityFloor: number;
  readonly availabilityLowerBound: number;
  readonly availabilityFloor: number;
}): Exclude<FamilyDecision, "abstain"> {
  if (input.unsafeSubstitutions > 0) {
    return "reject";
  }
  if (
    input.weakestWorstCaseBound >= input.qualityFloor &&
    input.availabilityLowerBound >= input.availabilityFloor
  ) {
    return "recommend";
  }
  return "inconclusive";
}

function validateFloor(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

function lowerBound(
  outcomes: Readonly<Record<string, readonly boolean[]>>,
  passes: number,
  trials: number,
  seed: number,
): number {
  return hasRepeatedTrajectory(outcomes)
    ? clusterBootstrap(outcomes, {
        resamples: AGGREGATION_BOOTSTRAP_RESAMPLES,
        seed,
      }).lower
    : wilson(passes, trials).lower;
}

function outcomesByTrajectory(
  facts: readonly AggregationFact[],
  outcome: (fact: AggregationFact) => boolean,
): Readonly<Record<string, readonly boolean[]>> {
  const trajectories = new Map<string, boolean[]>();
  for (const fact of facts) {
    const trajectoryId = fact.execution.trajectoryId;
    const outcomes = trajectories.get(trajectoryId);
    if (outcomes) {
      outcomes.push(outcome(fact));
    } else {
      trajectories.set(trajectoryId, [outcome(fact)]);
    }
  }
  return Object.fromEntries(
    [...trajectories.entries()].sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
}

function summarizeTrajectories(
  outcomes: Readonly<Record<string, readonly boolean[]>>,
): TrajectoryCluster[] {
  return Object.entries(outcomes).map(([trajectoryId, values]) => ({
    trajectoryId,
    passes: values.filter(Boolean).length,
    trials: values.length,
  }));
}

function hasRepeatedTrajectory(
  outcomes: Readonly<Record<string, readonly boolean[]>>,
): boolean {
  return Object.values(outcomes).some((values) => values.length > 1);
}

function validateFact(fact: AggregationFact): void {
  if (fact.evaluatorKind.length === 0) {
    throw new TypeError("evaluatorKind must not be empty");
  }
  if (fact.stratumId.length === 0) {
    throw new TypeError("stratumId must not be empty");
  }
  if (
    fact.expectedEvaluatorAssignments.some(
      (assignment) =>
        assignment.caseId.length === 0 ||
        assignment.stratumId.length === 0 ||
        assignment.evaluatorKind.length === 0,
    )
  ) {
    throw new TypeError(
      "expectedEvaluatorAssignments must contain named cases and kinds",
    );
  }
  const expectedAssignmentKeys = fact.expectedEvaluatorAssignments.map(
    (assignment) =>
      assignmentKey(
        assignment.caseId,
        assignment.stratumId,
        assignment.evaluatorKind,
      ),
  );
  if (new Set(expectedAssignmentKeys).size !== expectedAssignmentKeys.length) {
    throw new Error("expectedEvaluatorAssignments must not contain duplicates");
  }
  if (fact.gatePolicyVersion.length === 0) {
    throw new TypeError("fact gatePolicyVersion must not be empty");
  }
  if (!Number.isFinite(fact.candidateCostUsd) || fact.candidateCostUsd < 0) {
    throw new RangeError(
      "candidateCostUsd must be a finite non-negative number",
    );
  }
  if (
    !Number.isFinite(fact.referenceCeilingMultiplier) ||
    fact.referenceCeilingMultiplier < 0 ||
    fact.referenceCeilingMultiplier > 1
  ) {
    throw new RangeError(
      "referenceCeilingMultiplier must be a finite number in [0, 1]",
    );
  }
  if (fact.execution.attribution === "ok" && fact.assessment === undefined) {
    throw new Error(
      `execution ${fact.execution.executionId} has no assessment`,
    );
  }
  if (
    fact.assessment !== undefined &&
    fact.assessment.executionId !== fact.execution.executionId
  ) {
    throw new Error(
      `assessment ${fact.assessment.assessmentId} belongs to a different execution`,
    );
  }
  if (fact.judgeModel !== undefined && fact.orderConsistent === undefined) {
    throw new Error(
      `execution ${fact.execution.executionId} is missing judge order consistency`,
    );
  }
  if (fact.evaluatorKind === "judge" && fact.orderConsistent === undefined) {
    throw new Error(
      `execution ${fact.execution.executionId} is missing judge order consistency`,
    );
  }
}

function assertConsistentGroup(
  facts: readonly AggregationFact[],
  first: AggregationFact,
): void {
  if (first.expectedEvaluatorAssignments.length === 0) {
    throw new Error("expectedEvaluatorAssignments must be predeclared");
  }
  for (const fact of facts.slice(1)) {
    if (
      fact.familyId !== first.familyId ||
      fact.candidateFamily !== first.candidateFamily ||
      fact.candidateCostUsd !== first.candidateCostUsd ||
      fact.referenceCeilingMultiplier !== first.referenceCeilingMultiplier ||
      !sameStrings(
        fact.expectedEvaluatorAssignments
          .map((assignment) =>
            assignmentKey(
              assignment.caseId,
              assignment.stratumId,
              assignment.evaluatorKind,
            ),
          )
          .sort(compareText),
        first.expectedEvaluatorAssignments
          .map((assignment) =>
            assignmentKey(
              assignment.caseId,
              assignment.stratumId,
              assignment.evaluatorKind,
            ),
          )
          .sort(compareText),
      )
    ) {
      throw new Error(
        `inconsistent materialization for evidence question ${first.execution.evidenceQuestionId}`,
      );
    }
  }
}

function assignmentKey(
  caseId: string,
  stratumId: string,
  evaluatorKind: string,
): string {
  return JSON.stringify([caseId, stratumId, evaluatorKind]);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function compareVerdicts(left: FamilyVerdict, right: FamilyVerdict): number {
  return (
    compareText(left.evidenceQuestionId, right.evidenceQuestionId) ||
    compareText(left.candidateId, right.candidateId) ||
    compareText(left.corpusSplit, right.corpusSplit)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
