import type { ModelCatalogEntry } from "./provider.js";

export interface ReplayStep {
  stepId: string;
  evidenceQuestionId: string;
  currentModel: string | null;
  needsTools: boolean;
  needsStructuredOutput: boolean;
  observedContextTokens: number;
  selectionStage?: string;
}

export interface ShortlistOptions {
  allow?: readonly string[];
  deny?: readonly string[];
  top?: number;
}

export interface ShortlistAbstention {
  kind: "current-model-absent";
  message: string;
}

export interface StepShortlist {
  stepId: string;
  candidates: ModelCatalogEntry[];
  abstention?: ShortlistAbstention;
}

function blendedPrice(model: ModelCatalogEntry): number {
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
        abstention: {
          kind: "current-model-absent",
          message: `Current model is absent from the provider catalog: ${step.currentModel ?? "unknown"}`,
        },
      };
    }
    const currentPrice = blendedPrice(current);
    const candidates = catalog
      .filter((candidate) => {
        const candidatePrice = blendedPrice(candidate);
        return (
          candidate.id !== current.id &&
          (allow === undefined || allow.has(candidate.id)) &&
          !deny.has(candidate.id) &&
          (!step.needsTools || candidate.supportsTools) &&
          (!step.needsStructuredOutput || candidate.supportsStructuredOutput) &&
          candidate.contextLength >= step.observedContextTokens &&
          candidatePrice > 0 &&
          candidatePrice < currentPrice
        );
      })
      .sort((left, right) => blendedPrice(left) - blendedPrice(right))
      .slice(0, top);
    return { stepId: step.stepId, candidates };
  });
}
