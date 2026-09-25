export interface ModelPricing {
  input: number;
  output: number;
}

export interface ModelCatalogEntry {
  id: string;
  family: string;
  contextLength: number;
  pricing: ModelPricing | null;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  releasedAt?: number | null;
  maxOutputTokens?: number | null;
  outputModalities?: readonly string[];
  requiresReasoning?: boolean;
}

export function blendedPrice(model: ModelCatalogEntry): number | null {
  if (model.pricing === null) return null;
  return (3 * model.pricing.input + model.pricing.output) / 4;
}

export function withoutFastTiers(
  catalog: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const ids = new Set(catalog.map(({ id }) => id));
  return catalog.filter(
    ({ id }) => !id.endsWith("-fast") || !ids.has(id.slice(0, -"-fast".length)),
  );
}

export function catalogFamily(modelId: string): string {
  const segments = modelId.split("/");
  return segments.length < 2 ? modelId : segments[segments.length - 2]!;
}

export function canonicalModelName(modelId: string): string {
  return modelId
    .split("/")
    .at(-1)!
    .toLowerCase()
    .replace(/-\d{8}$/u, "")
    .replaceAll(".", "-");
}
