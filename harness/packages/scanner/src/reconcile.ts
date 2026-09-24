import type { StepRecord } from "@rightmodeler/core";

import type { NormalizedStepInput } from "./types.js";

export const AMBIGUOUS_MODEL_ID_REASON =
  "multiple_call_sites_share_model_id" as const;
export const AMBIGUOUS_TRACE_KEY_REASON =
  "multiple_call_sites_share_trace_key" as const;

export type ReconciliationStatus = "matched" | "ambiguous" | "unmatched";
export type TraceBindingVia = "trajectory_position" | "trace_key" | "model";

export interface ReconciledTraceStep<T extends NormalizedStepInput> {
  readonly normalizedStep: T;
  readonly traceIndex: number;
  readonly status: ReconciliationStatus;
  readonly stepId?: string;
  readonly candidateStepIds?: readonly string[];
  readonly reason?:
    typeof AMBIGUOUS_MODEL_ID_REASON | typeof AMBIGUOUS_TRACE_KEY_REASON;
  readonly via?: TraceBindingVia;
}

export interface ReconciledCallSite {
  readonly stepRecord: StepRecord;
  readonly status: ReconciliationStatus;
  readonly traceIndexes: readonly number[];
  readonly reason?:
    typeof AMBIGUOUS_MODEL_ID_REASON | typeof AMBIGUOUS_TRACE_KEY_REASON;
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

function append<V>(groups: Map<string, V[]>, key: string, value: V): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [value]);
  else group.push(value);
}

function groupBy(
  records: readonly StepRecord[],
  key: (record: StepRecord) => string | null | undefined,
): Map<string, StepRecord[]> {
  const groups = new Map<string, StepRecord[]>();
  for (const record of records) {
    const value = key(record);
    if (value !== null && value !== undefined) append(groups, value, record);
  }
  return groups;
}

function joinCandidates<T extends NormalizedStepInput>(
  normalizedStep: T,
  traceIndex: number,
  candidates: readonly StepRecord[],
  reason: typeof AMBIGUOUS_MODEL_ID_REASON | typeof AMBIGUOUS_TRACE_KEY_REASON,
  via: TraceBindingVia,
): ReconciledTraceStep<T> {
  if (candidates.length === 1) {
    return {
      normalizedStep,
      traceIndex,
      status: "matched",
      stepId: candidates[0]!.stepId,
      via,
    };
  }
  return {
    normalizedStep,
    traceIndex,
    status: "ambiguous",
    candidateStepIds: candidates.map(({ stepId }) => stepId).sort(),
    reason,
    via,
  };
}

export function reconcile<T extends NormalizedStepInput>(
  normalizedSteps: readonly T[],
  stepRecords: readonly StepRecord[],
): ReconciliationResult<T> {
  const sitesByModel = groupBy(stepRecords, (record) => record.currentModel);
  const sitesByTraceKey = groupBy(stepRecords, (record) => record.traceKey);

  const joinByTrajectoryPosition = canJoinByTrajectoryPosition(
    normalizedSteps,
    stepRecords,
  );

  const traceSteps = normalizedSteps.map(
    (normalizedStep, traceIndex): ReconciledTraceStep<T> => {
      if (joinByTrajectoryPosition) {
        return {
          normalizedStep,
          traceIndex,
          status: "matched",
          stepId: stepRecords[normalizedStep.stepIndex!]!.stepId,
          via: "trajectory_position",
        };
      }
      const keyed =
        normalizedStep.family === undefined
          ? []
          : (sitesByTraceKey.get(normalizedStep.family) ?? []);
      if (keyed.length > 0) {
        const sameModel = keyed.filter(
          ({ currentModel }) => currentModel === normalizedStep.model,
        );
        return joinCandidates(
          normalizedStep,
          traceIndex,
          sameModel.length > 0 ? sameModel : keyed,
          AMBIGUOUS_TRACE_KEY_REASON,
          "trace_key",
        );
      }
      const candidates = sitesByModel.get(normalizedStep.model) ?? [];
      if (candidates.length === 0) {
        return { normalizedStep, traceIndex, status: "unmatched" };
      }
      return joinCandidates(
        normalizedStep,
        traceIndex,
        candidates,
        AMBIGUOUS_MODEL_ID_REASON,
        "model",
      );
    },
  );

  const matchedIndexes = new Map<string, number[]>();
  const ambiguousSteps = new Map<string, ReconciledTraceStep<T>[]>();
  for (const traceStep of traceSteps) {
    if (traceStep.status === "matched") {
      append(matchedIndexes, traceStep.stepId!, traceStep.traceIndex);
    } else if (traceStep.status === "ambiguous") {
      for (const stepId of traceStep.candidateStepIds!) {
        append(ambiguousSteps, stepId, traceStep);
      }
    }
  }

  const enrichedByStepId = enrichCallSites(traceSteps, stepRecords);
  const callSites = stepRecords.map((original): ReconciledCallSite => {
    const stepRecord = enrichedByStepId.get(original.stepId)!;
    const matched = matchedIndexes.get(original.stepId);
    if (matched !== undefined) {
      return { stepRecord, status: "matched", traceIndexes: matched };
    }
    const ambiguous = ambiguousSteps.get(original.stepId);
    if (ambiguous !== undefined) {
      return {
        stepRecord,
        status: "ambiguous",
        traceIndexes: ambiguous.map(({ traceIndex }) => traceIndex),
        reason: ambiguous[0]!.reason!,
      };
    }
    return { stepRecord, status: "unmatched", traceIndexes: [] };
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
