import { compareText } from "@rightmodeler/core";
import type {
  ModelCatalogEntry,
  ModelPricing,
  StepShortlist,
} from "@rightmodeler/replay";

export interface ReplayCostStep {
  readonly family: string;
  readonly stepId: string;
}

export interface ReplayCostCase {
  readonly corpusSplit: "shortlist" | "holdout";
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly stepId: string;
}

export interface ReplayCostEstimate {
  readonly projectedCostUsd: number;
  readonly shortlistCostUsd: number;
  readonly holdoutCostUsd: number;
  readonly judgeCostUsd: number;
  readonly judgeCalls: number;
  readonly candidateExecutions: number;
  readonly corpusCases: number;
  readonly shortlistCases: number;
  readonly holdoutCases: number;
  readonly basis: string;
  readonly exclusions: readonly string[];
  readonly shortlist: readonly {
    readonly stepId: string;
    readonly candidateIds: readonly string[];
    readonly resolvedCurrentModelId?: string;
  }[];
}

export interface ReplayCostJudge {
  readonly modelId: string;
  readonly pricing: ModelPricing;
  readonly maxOutputTokens: number;
}

export function estimateReplayCost(input: {
  readonly steps: readonly ReplayCostStep[];
  readonly cases: readonly ReplayCostCase[];
  readonly candidates: readonly StepShortlist[];
  readonly judge:
    | ((stepId: string, candidate: ModelCatalogEntry) => ReplayCostJudge)
    | undefined;
}): ReplayCostEstimate {
  const stepsById = new Map(input.steps.map((step) => [step.stepId, step]));
  const candidatesByStep = new Map(
    input.candidates.map((assignment) => [
      assignment.stepId,
      assignment.candidates,
    ]),
  );
  let shortlistCostUsd = 0;
  let shortlistExecutions = 0;
  let judgeCostUsd = 0;

  for (const replayCase of input.cases) {
    requireStep(stepsById, replayCase.stepId);
    if (replayCase.corpusSplit !== "shortlist") continue;
    for (const candidate of candidatesByStep.get(replayCase.stepId) ?? []) {
      shortlistCostUsd += reservationCost(replayCase, candidate);
      shortlistExecutions += 1;
      if (input.judge !== undefined) {
        judgeCostUsd +=
          2 *
          judgeCallCost(replayCase, input.judge(replayCase.stepId, candidate));
      }
    }
  }

  let holdoutCostUsd = 0;
  let holdoutExecutions = 0;
  const families = [...new Set(input.steps.map(({ family }) => family))].sort(
    compareText,
  );
  for (const family of families) {
    const familyStepIds = new Set(
      input.steps
        .filter((step) => step.family === family)
        .map(({ stepId }) => stepId),
    );
    const candidateIds = [
      ...new Set(
        input.candidates
          .filter(({ stepId }) => familyStepIds.has(stepId))
          .flatMap(({ candidates }) => candidates.map(({ id }) => id)),
      ),
    ].sort(compareText);
    let maximumFamily:
      | {
          readonly cost: number;
          readonly executions: number;
          readonly judgeCost: number;
        }
      | undefined;
    for (const candidateId of candidateIds) {
      let candidateCost = 0;
      let candidateExecutions = 0;
      let candidateJudgeCost = 0;
      for (const replayCase of input.cases) {
        if (
          replayCase.corpusSplit !== "holdout" ||
          !familyStepIds.has(replayCase.stepId)
        ) {
          continue;
        }
        const candidate = (candidatesByStep.get(replayCase.stepId) ?? []).find(
          ({ id }) => id === candidateId,
        );
        if (candidate === undefined) continue;
        candidateCost += reservationCost(replayCase, candidate);
        candidateExecutions += 1;
        if (input.judge !== undefined) {
          candidateJudgeCost +=
            2 *
            judgeCallCost(
              replayCase,
              input.judge(replayCase.stepId, candidate),
            );
        }
      }
      if (maximumFamily === undefined || candidateCost > maximumFamily.cost) {
        maximumFamily = {
          cost: candidateCost,
          executions: candidateExecutions,
          judgeCost: candidateJudgeCost,
        };
      }
    }
    holdoutCostUsd += maximumFamily?.cost ?? 0;
    holdoutExecutions += maximumFamily?.executions ?? 0;
    judgeCostUsd += maximumFamily?.judgeCost ?? 0;
  }

  const judgeCalls =
    input.judge === undefined
      ? 0
      : 2 * (shortlistExecutions + holdoutExecutions);

  return {
    projectedCostUsd: shortlistCostUsd + holdoutCostUsd + judgeCostUsd,
    shortlistCostUsd,
    holdoutCostUsd,
    judgeCostUsd,
    judgeCalls,
    candidateExecutions: shortlistExecutions + holdoutExecutions,
    corpusCases: input.cases.length,
    shortlistCases: input.cases.filter(
      ({ corpusSplit }) => corpusSplit === "shortlist",
    ).length,
    holdoutCases: input.cases.filter(
      ({ corpusSplit }) => corpusSplit === "holdout",
    ).length,
    basis:
      "Worst-case candidate reservation from corpus token bounds and current provider catalog pricing; holdout uses the most expensive possible family winner. Judge calls are priced at two calls per replayed cell.",
    exclusions: [
      "External evaluator charges, which are not present in the provider catalog.",
    ],
    shortlist: input.candidates.map(
      ({ stepId, candidates, resolvedCurrentModelId }) => ({
        stepId,
        candidateIds: candidates.map(({ id }) => id),
        ...(resolvedCurrentModelId === undefined
          ? {}
          : { resolvedCurrentModelId }),
      }),
    ),
  };
}

function judgeCallCost(
  replayCase: ReplayCostCase,
  judge: {
    readonly pricing: ModelPricing;
    readonly maxOutputTokens: number;
  },
): number {
  return (
    replayCase.contextTokens * judge.pricing.input +
    judge.maxOutputTokens * judge.pricing.output
  );
}

function reservationCost(
  replayCase: ReplayCostCase,
  candidate: ModelCatalogEntry,
): number {
  if (candidate.pricing === null) {
    throw new Error(`Shortlisted candidate has no pricing: ${candidate.id}`);
  }
  return (
    replayCase.contextTokens * candidate.pricing.input +
    replayCase.maxOutputTokens * candidate.pricing.output
  );
}

function requireStep(
  stepsById: ReadonlyMap<string, ReplayCostStep>,
  stepId: string,
): ReplayCostStep {
  const step = stepsById.get(stepId);
  if (step === undefined) {
    throw new Error(`Replay cost case references an unknown step: ${stepId}`);
  }
  return step;
}
