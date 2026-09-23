import { blendedPrice, withoutFastTiers } from "@rightmodeler/core";
import type { ModelCatalogEntry } from "./provider.js";
import type { CorpusSplit } from "@rightmodeler/kernel";

export interface ReplayStep {
  stepId: string;
  evidenceQuestionId: string;
  currentModel: string | null;
  needsTools: boolean;
  needsStructuredOutput: boolean;
  observedContextTokens: number;
  recordedMaxOutputTokens?: number;
  corpusSplit: CorpusSplit;
  selectionStage?: string;
}

export interface ShortlistOptions {
  allow?: readonly string[];
  deny?: readonly string[];
  top?: number;
  includeFreeModels?: boolean;
}

export interface ShortlistAbstention {
  kind:
    "current-model-absent" | "current-model-ambiguous" | "no-priced-candidates";
  message: string;
}

export interface StepShortlist {
  stepId: string;
  candidates: ModelCatalogEntry[];
  droppedByTop: number;
  droppedFreeModels: number;
  droppedByOutputCeiling: number;
  resolvedCurrentModelId?: string;
  abstention?: ShortlistAbstention;
}

export type CurrentModelResolution =
  | { kind: "exact" | "resolved"; model: ModelCatalogEntry }
  | { kind: "ambiguous"; matches: readonly string[] }
  | { kind: "absent" };

export function resolveCurrentModel(
  catalog: readonly ModelCatalogEntry[],
  currentModel: string | null,
): CurrentModelResolution {
  const exact = catalog.find(({ id }) => id === currentModel);
  if (exact !== undefined) return { kind: "exact", model: exact };
  if (currentModel === null) return { kind: "absent" };
  const matches = catalog
    .filter(({ id }) => id.endsWith(`/${currentModel}`))
    .map(({ id }) => id);
  if (matches.length === 1) {
    return {
      kind: "resolved",
      model: catalog.find(({ id }) => id === matches[0])!,
    };
  }
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "absent" };
}

export function shortlist(
  stepRecords: readonly ReplayStep[],
  catalog: readonly ModelCatalogEntry[],
  options: ShortlistOptions = {},
): StepShortlist[] {
  const top = options.top ?? 8;
  if (!Number.isSafeInteger(top) || top < 1) {
    throw new Error("top must be a positive integer");
  }
  const allow =
    options.allow === undefined ? undefined : new Set(options.allow);
  const deny = new Set(options.deny ?? []);
  const rankable = withoutFastTiers(catalog);

  return stepRecords.map((step) => {
    if (
      !Number.isSafeInteger(step.observedContextTokens) ||
      step.observedContextTokens < 0
    ) {
      throw new Error("observedContextTokens must be a non-negative integer");
    }
    const resolution = resolveCurrentModel(catalog, step.currentModel);
    if (resolution.kind === "ambiguous") {
      return {
        stepId: step.stepId,
        candidates: [],
        droppedByTop: 0,
        droppedFreeModels: 0,
        droppedByOutputCeiling: 0,
        abstention: {
          kind: "current-model-ambiguous",
          message: `Recorded model ${step.currentModel} matches more than one catalog model: ${[...resolution.matches].sort().join(", ")}`,
        },
      };
    }
    if (resolution.kind === "absent") {
      return {
        stepId: step.stepId,
        candidates: [],
        droppedByTop: 0,
        droppedFreeModels: 0,
        droppedByOutputCeiling: 0,
        abstention: {
          kind: "current-model-absent",
          message: `Current model is absent from the provider catalog: ${step.currentModel ?? "unknown"}`,
        },
      };
    }
    const current = resolution.model;
    const resolvedCurrentModelId =
      resolution.kind === "resolved" ? current.id : undefined;
    const currentPrice = blendedPrice(current);
    const capable = rankable.filter(
      (candidate) =>
        candidate.id !== current.id &&
        (allow === undefined || allow.has(candidate.id)) &&
        !deny.has(candidate.id) &&
        (!step.needsTools || candidate.supportsTools) &&
        (!step.needsStructuredOutput || candidate.supportsStructuredOutput) &&
        candidate.contextLength >= step.observedContextTokens,
    );
    const fitsCeiling = (candidate: ModelCatalogEntry): boolean =>
      step.recordedMaxOutputTokens === undefined ||
      candidate.maxOutputTokens === undefined ||
      candidate.maxOutputTokens === null ||
      candidate.maxOutputTokens >= step.recordedMaxOutputTokens;
    const withinCeiling = capable.filter(fitsCeiling);
    const droppedByOutputCeiling = capable.length - withinCeiling.length;
    const unpricedCandidates = withinCeiling.filter(
      (candidate) => blendedPrice(candidate) === null,
    ).length;
    const qualifiedBeforeFreePolicy = withinCeiling.filter((candidate) => {
      const candidatePrice = blendedPrice(candidate);
      return (
        candidatePrice !== null &&
        currentPrice !== null &&
        candidatePrice < currentPrice
      );
    });
    const droppedFreeModels = options.includeFreeModels
      ? 0
      : qualifiedBeforeFreePolicy.filter(
          (candidate) => blendedPrice(candidate) === 0,
        ).length;
    const qualified = qualifiedBeforeFreePolicy
      .filter(
        (candidate) =>
          options.includeFreeModels || blendedPrice(candidate) !== 0,
      )
      .sort((left, right) => blendedPrice(left)! - blendedPrice(right)!);
    if (
      qualified.length === 0 &&
      (currentPrice === null || unpricedCandidates > 0)
    ) {
      return {
        stepId: step.stepId,
        candidates: [],
        droppedByTop: 0,
        droppedFreeModels,
        droppedByOutputCeiling,
        ...(resolvedCurrentModelId === undefined
          ? {}
          : { resolvedCurrentModelId }),
        abstention: {
          kind: "no-priced-candidates",
          message:
            "The provider catalog publishes no per-token pricing, so no candidate can be priced against the current model.",
        },
      };
    }
    return {
      stepId: step.stepId,
      candidates: qualified.slice(0, top),
      droppedByTop: Math.max(0, qualified.length - top),
      droppedFreeModels,
      droppedByOutputCeiling,
      ...(resolvedCurrentModelId === undefined
        ? {}
        : { resolvedCurrentModelId }),
    };
  });
}
