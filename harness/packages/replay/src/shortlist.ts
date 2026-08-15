import type { ModelCatalogEntry } from "./provider.js";
import type { CorpusSplit } from "@rightmodeler/kernel";

export interface ReplayStep {
  stepId: string;
  evidenceQuestionId: string;
  currentModel: string | null;
  needsTools: boolean;
  needsStructuredOutput: boolean;
  observedContextTokens: number;
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
  kind: "current-model-absent";
  message: string;
}

export interface StepShortlist {
  stepId: string;
  candidates: ModelCatalogEntry[];
  droppedByTop: number;
  droppedFreeModels: number;
  abstention?: ShortlistAbstention;
}

function blendedPrice(model: ModelCatalogEntry): number | null {
  if (model.pricing === null) return null;
  return (3 * model.pricing.input + model.pricing.output) / 4;
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

  return stepRecords.map((step) => {
    if (
      !Number.isSafeInteger(step.observedContextTokens) ||
      step.observedContextTokens < 0
    ) {
      throw new Error("observedContextTokens must be a non-negative integer");
    }
    const current = catalog.find((model) => model.id === step.currentModel);
    if (current === undefined) {
      return {
        stepId: step.stepId,
        candidates: [],
        droppedByTop: 0,
        droppedFreeModels: 0,
        abstention: {
          kind: "current-model-absent",
          message: `Current model is absent from the provider catalog: ${step.currentModel ?? "unknown"}`,
        },
      };
    }
    const currentPrice = blendedPrice(current);
    const qualifiedBeforeFreePolicy = catalog.filter((candidate) => {
      const candidatePrice = blendedPrice(candidate);
      return (
        candidate.id !== current.id &&
        (allow === undefined || allow.has(candidate.id)) &&
        !deny.has(candidate.id) &&
        (!step.needsTools || candidate.supportsTools) &&
        (!step.needsStructuredOutput || candidate.supportsStructuredOutput) &&
        candidate.contextLength >= step.observedContextTokens &&
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
    return {
      stepId: step.stepId,
      candidates: qualified.slice(0, top),
      droppedByTop: Math.max(0, qualified.length - top),
      droppedFreeModels,
    };
  });
}
