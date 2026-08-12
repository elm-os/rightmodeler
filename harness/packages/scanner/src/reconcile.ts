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

  const traceSteps = normalizedSteps.map((normalizedStep, traceIndex) => {
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

  const callSites = stepRecords.map((stepRecord) => {
    const traceIndexes =
      stepRecord.currentModel === null
        ? []
        : (tracesByModel.get(stepRecord.currentModel) ?? []);
    const modelSites =
      stepRecord.currentModel === null
        ? []
        : (sitesByModel.get(stepRecord.currentModel) ?? []);
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
