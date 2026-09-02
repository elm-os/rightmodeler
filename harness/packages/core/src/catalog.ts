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
