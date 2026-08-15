import type { StepRecord } from "@rightmodeler/core";

import type { NormalizedStepInput } from "./types.js";

export const AMBIGUOUS_MODEL_ID_REASON =
  "multiple_call_sites_share_model_id" as const;

export type ReconciliationStatus = "matched" | "ambiguous" | "unmatched";

export interface ReconciledTraceStep<T extends NormalizedStepInput> {
  readonly normalizedStep: T;
  readonly traceIndex: number;
  readonly status: ReconciliationStatus;
  readonly stepId?: string;
  readonly candidateStepIds?: readonly string[];
  readonly reason?: typeof AMBIGUOUS_MODEL_ID_REASON;
}

export interface ReconciledCallSite {
  readonly stepRecord: StepRecord;
  readonly status: ReconciliationStatus;
  readonly traceIndexes: readonly number[];
  readonly reason?: typeof AMBIGUOUS_MODEL_ID_REASON;
}

export interface CaseStepLink {
  readonly caseId: string;
  readonly stepId: string;
}

export interface ReconciliationResult<T extends NormalizedStepInput> {
  readonly traceSteps: readonly ReconciledTraceStep<T>[];
  readonly callSites: readonly ReconciledCallSite[];
  readonly caseStepLinks: readonly CaseStepLink[];
  readonly unmatchedTraceSteps: readonly ReconciledTraceStep<T>[];
  readonly unmatchedCallSites: readonly ReconciledCallSite[];
  readonly ambiguousTraceSteps: readonly ReconciledTraceStep<T>[];
  readonly ambiguousCallSites: readonly ReconciledCallSite[];
}

function canJoinByTrajectoryPosition<T extends NormalizedStepInput>(
  normalizedSteps: readonly T[],
  stepRecords: readonly StepRecord[],
): boolean {
  if (
    stepRecords.length === 0 ||
    !stepRecords.every(({ currentModel }) => currentModel === null)
  ) {
    return false;
  }

  const indexesByTrajectory = new Map<string, number[]>();
  for (const step of normalizedSteps) {
    if (
      step.trajectoryId === undefined ||
      step.stepIndex === undefined ||
      !Number.isInteger(step.stepIndex) ||
      step.stepIndex < 0
    ) {
      return false;
    }
    const indexes = indexesByTrajectory.get(step.trajectoryId) ?? [];
    indexes.push(step.stepIndex);
    indexesByTrajectory.set(step.trajectoryId, indexes);
  }

  return (
    indexesByTrajectory.size > 0 &&
    [...indexesByTrajectory.values()].every(
      (indexes) =>
        indexes.length === stepRecords.length &&
        [...indexes]
          .sort((left, right) => left - right)
          .every((stepIndex, expectedIndex) => stepIndex === expectedIndex),
    )
  );
}

function enrichCallSites<T extends NormalizedStepInput>(
  traceSteps: readonly ReconciledTraceStep<T>[],
  stepRecords: readonly StepRecord[],
): Map<string, StepRecord> {
  const modelsByStep = new Map<string, Set<string>>();
  const downstreamByStep = new Map<string, Set<string>>();
  const firstInEveryTrajectory = new Map<string, boolean>();
  const stepsByTrajectory = new Map<string, ReconciledTraceStep<T>[]>();

  for (const traceStep of traceSteps) {
    if (traceStep.status !== "matched" || traceStep.stepId === undefined) {
      continue;
    }
    const models = modelsByStep.get(traceStep.stepId) ?? new Set<string>();
    models.add(traceStep.normalizedStep.model);
    modelsByStep.set(traceStep.stepId, models);

    if (
      traceStep.normalizedStep.trajectoryId !== undefined &&
      traceStep.normalizedStep.stepIndex !== undefined
    ) {
      const trajectory =
        stepsByTrajectory.get(traceStep.normalizedStep.trajectoryId) ?? [];
      trajectory.push(traceStep);
      stepsByTrajectory.set(traceStep.normalizedStep.trajectoryId, trajectory);
    }
  }

  for (const trajectory of stepsByTrajectory.values()) {
    trajectory.sort(
      (left, right) =>
        left.normalizedStep.stepIndex! - right.normalizedStep.stepIndex! ||
        left.traceIndex - right.traceIndex,
    );
    for (const [index, traceStep] of trajectory.entries()) {
      const stepId = traceStep.stepId!;
      firstInEveryTrajectory.set(
        stepId,
        (firstInEveryTrajectory.get(stepId) ?? true) &&
          traceStep.normalizedStep.stepIndex === 0,
      );
      const downstream = downstreamByStep.get(stepId) ?? new Set<string>();
      for (const later of trajectory.slice(index + 1)) {
        if (
          later.stepId !== undefined &&
          later.stepId !== stepId &&
          later.normalizedStep.stepIndex! > traceStep.normalizedStep.stepIndex!
        ) {
          downstream.add(later.stepId);
        }
      }
      downstreamByStep.set(stepId, downstream);
    }
  }

  return new Map(
    stepRecords.map((record) => {
      const models = modelsByStep.get(record.stepId);
      const downstream = downstreamByStep.get(record.stepId);
      const alwaysFirst = firstInEveryTrajectory.get(record.stepId);
      return [
        record.stepId,
        {
          ...record,
          currentModel:
            record.currentModel === null && models?.size === 1
              ? [...models][0]!
              : record.currentModel,
          downstreamStepIds:
            downstream === undefined
              ? record.downstreamStepIds
              : [...downstream],
          prefixProvenance:
            alwaysFirst === undefined
              ? record.prefixProvenance
              : alwaysFirst
                ? "external"
                : "model_authored",
        },
      ];
    }),
  );
}

export function reconcile<T extends NormalizedStepInput>(
  normalizedSteps: readonly T[],
  stepRecords: readonly StepRecord[],
): ReconciliationResult<T> {
  const sitesByModel = new Map<string, StepRecord[]>();
  for (const record of stepRecords) {
    if (record.currentModel === null) continue;
    const records = sitesByModel.get(record.currentModel) ?? [];
    records.push(record);
    sitesByModel.set(record.currentModel, records);
  }

  const tracesByModel = new Map<string, number[]>();
  for (const [traceIndex, step] of normalizedSteps.entries()) {
    const indexes = tracesByModel.get(step.model) ?? [];
    indexes.push(traceIndex);
    tracesByModel.set(step.model, indexes);
  }

  const joinByTrajectoryPosition = canJoinByTrajectoryPosition(
    normalizedSteps,
    stepRecords,
  );

  const traceSteps = normalizedSteps.map((normalizedStep, traceIndex) => {
    if (joinByTrajectoryPosition) {
      return {
        normalizedStep,
        traceIndex,
        status: "matched" as const,
        stepId: stepRecords[normalizedStep.stepIndex!]!.stepId,
      };
    }
    const candidates = sitesByModel.get(normalizedStep.model) ?? [];
    if (candidates.length === 1) {
      return {
        normalizedStep,
        traceIndex,
        status: "matched" as const,
        stepId: candidates[0]!.stepId,
      };
    }
    if (candidates.length > 1) {
      return {
        normalizedStep,
        traceIndex,
        status: "ambiguous" as const,
        candidateStepIds: candidates.map(({ stepId }) => stepId).sort(),
        reason: AMBIGUOUS_MODEL_ID_REASON,
      };
    }
    return { normalizedStep, traceIndex, status: "unmatched" as const };
  });

  const enrichedByStepId = enrichCallSites(traceSteps, stepRecords);
  const callSites = stepRecords.map((original) => {
    const stepRecord = enrichedByStepId.get(original.stepId)!;
    if (joinByTrajectoryPosition) {
      return {
        stepRecord,
        status: "matched" as const,
        traceIndexes: traceSteps.flatMap((traceStep) =>
          traceStep.stepId === original.stepId ? [traceStep.traceIndex] : [],
        ),
      };
    }

    const traceIndexes =
      original.currentModel === null
        ? []
        : (tracesByModel.get(original.currentModel) ?? []);
    const modelSites =
      original.currentModel === null
        ? []
        : (sitesByModel.get(original.currentModel) ?? []);
    if (traceIndexes.length > 0 && modelSites.length > 1) {
      return {
        stepRecord,
        status: "ambiguous" as const,
        traceIndexes,
        reason: AMBIGUOUS_MODEL_ID_REASON,
      };
    }
    if (traceIndexes.length > 0) {
      return { stepRecord, status: "matched" as const, traceIndexes };
    }
    return { stepRecord, status: "unmatched" as const, traceIndexes: [] };
  });

  const caseStepLinks = traceSteps.flatMap((step) =>
    step.status === "matched" &&
    step.stepId !== undefined &&
    step.normalizedStep.caseId !== undefined
      ? [{ caseId: step.normalizedStep.caseId, stepId: step.stepId }]
      : [],
  );

  return {
    traceSteps,
    callSites,
    caseStepLinks,
    unmatchedTraceSteps: traceSteps.filter(
      ({ status }) => status === "unmatched",
    ),
    unmatchedCallSites: callSites.filter(
      ({ status }) => status === "unmatched",
    ),
    ambiguousTraceSteps: traceSteps.filter(
      ({ status }) => status === "ambiguous",
    ),
    ambiguousCallSites: callSites.filter(
      ({ status }) => status === "ambiguous",
    ),
  };
}
