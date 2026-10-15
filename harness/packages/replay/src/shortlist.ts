import {
  blendedPrice,
  canonicalModelName,
  catalogFamily,
  compareText,
  withoutFastTiers,
} from "@rightmodeler/core";
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
  releasedWithin?: { readonly since: number; readonly before?: number };
  named?: readonly string[];
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
  droppedByReleaseWindow: number;
  resolvedCurrentModelId?: string;
  namedCandidatesLeftOut?: readonly { modelId: string; reason: string }[];
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
  const suffixMatches = catalog
    .filter(({ id }) => id.endsWith(`/${currentModel}`))
    .map(({ id }) => id);
  const key = canonicalModelName(currentModel);
  const vendor = currentModel.includes("/")
    ? catalogFamily(currentModel)
    : undefined;
  const matches =
    suffixMatches.length > 0
      ? suffixMatches
      : catalog
          .filter(
            ({ id, family }) =>
              canonicalModelName(id) === key &&
              (vendor === undefined || family === vendor),
          )
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
  const named =
    options.named === undefined || options.named.length === 0
      ? undefined
      : new Set(options.named);
  const top = named?.size ?? options.top ?? 8;
  if (!Number.isSafeInteger(top) || top < 1) {
    throw new Error("top must be a positive integer");
  }
  const allow =
    options.allow === undefined ? undefined : new Set(options.allow);
  const deny = new Set(options.deny ?? []);
  const window = named === undefined ? options.releasedWithin : undefined;
  const rankable = withoutBatchTiers(withoutFastTiers(catalog));
  const rankableIds = new Set(rankable.map(({ id }) => id));

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
        droppedByReleaseWindow: 0,
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
        droppedByReleaseWindow: 0,
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
        (named === undefined || named.has(candidate.id)) &&
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
    const qualified = qualifiedBeforeFreePolicy.filter(
      (candidate) => options.includeFreeModels || blendedPrice(candidate) !== 0,
    );
    if (
      qualified.length === 0 &&
      (currentPrice === null || (named === undefined && unpricedCandidates > 0))
    ) {
      return {
        stepId: step.stepId,
        candidates: [],
        droppedByTop: 0,
        droppedFreeModels,
        droppedByOutputCeiling,
        droppedByReleaseWindow: 0,
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
    const inWindow =
      window === undefined
        ? qualified
        : qualified.filter(
            ({ releasedAt }) =>
              typeof releasedAt === "number" &&
              releasedAt >= window.since &&
              (window.before === undefined || releasedAt < window.before),
          );
    const ranked =
      window === undefined
        ? inWindow.sort(
            (left, right) =>
              blendedPrice(left)! - blendedPrice(right)! ||
              compareText(left.id, right.id),
          )
        : cheaperAndNewerFirst(inWindow);
    const candidates = ranked.slice(0, top);
    const perMillion = (price: number): number =>
      Number((price * 1e6).toPrecision(4));
    const leftOutReason = (model: ModelCatalogEntry): string => {
      const price = blendedPrice(model);
      if (model.id === current.id) return "it is the current model";
      if (!rankableIds.has(model.id)) {
        const base = model.id.replace(/(?:-fast|[-:]batch)$/u, "");
        return `it is a service tier of ${base}; name ${base} instead`;
      }
      if ((allow !== undefined && !allow.has(model.id)) || deny.has(model.id)) {
        return "the release policy or the route's model list does not allow it";
      }
      if (step.needsTools && !model.supportsTools) {
        return "it does not support tool calls, which this call site needs";
      }
      if (step.needsStructuredOutput && !model.supportsStructuredOutput) {
        return "it does not support structured output, which this call site needs";
      }
      if (model.contextLength < step.observedContextTokens) {
        return `its context window is smaller than the ${step.observedContextTokens} tokens this call site sent`;
      }
      if (!fitsCeiling(model)) {
        return `its output limit is below the ${step.recordedMaxOutputTokens} tokens this call site needs`;
      }
      if (price === null) return "the catalog gives it no per-token price";
      if (price >= currentPrice!) {
        return `it is not cheaper than the current model ${current.id} (${perMillion(price)} vs ${perMillion(currentPrice!)} USD per million tokens)`;
      }
      return "it is zero-priced; pass --include-free to try it";
    };
    const namedCandidatesLeftOut = [...(named ?? [])]
      .filter((modelId) => !candidates.some(({ id }) => id === modelId))
      .map((modelId) => ({
        modelId,
        reason: leftOutReason(catalog.find(({ id }) => id === modelId)!),
      }));
    return {
      stepId: step.stepId,
      candidates,
      droppedByTop: Math.max(0, inWindow.length - top),
      droppedFreeModels,
      droppedByOutputCeiling,
      droppedByReleaseWindow: qualified.length - inWindow.length,
      ...(resolvedCurrentModelId === undefined
        ? {}
        : { resolvedCurrentModelId }),
      ...(namedCandidatesLeftOut.length === 0
        ? {}
        : { namedCandidatesLeftOut }),
    };
  });
}

export function releaseDateCount(
  catalog: readonly ModelCatalogEntry[],
): number | undefined {
  const priced = withoutBatchTiers(withoutFastTiers(catalog)).filter(
    ({ pricing }) => pricing !== null,
  );
  if (priced.length === 0) return undefined;
  return new Set(
    priced
      .map(({ releasedAt }) => releasedAt ?? 0)
      .filter((releasedAt) => releasedAt > 0),
  ).size;
}

function withoutBatchTiers(
  catalog: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const ids = new Set(catalog.map(({ id }) => id));
  return catalog.filter(
    ({ id }) =>
      !/[-:]batch$/u.test(id) || !ids.has(id.slice(0, -"-batch".length)),
  );
}

// Rounds rank a model behind every model that costs no more and is no older.
function cheaperAndNewerFirst(
  candidates: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  let remaining = [...candidates].sort(
    (left, right) =>
      blendedPrice(left)! - blendedPrice(right)! ||
      (right.releasedAt ?? 0) - (left.releasedAt ?? 0) ||
      compareText(left.id, right.id),
  );
  const ranked: ModelCatalogEntry[] = [];
  while (remaining.length > 0) {
    const later: ModelCatalogEntry[] = [];
    let latest = -Infinity;
    for (const candidate of remaining) {
      const releasedAt = candidate.releasedAt ?? 0;
      if (releasedAt > latest) {
        ranked.push(candidate);
        latest = releasedAt;
      } else {
        later.push(candidate);
      }
    }
    remaining = later;
  }
  return ranked;
}
