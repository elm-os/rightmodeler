import type { MatcherPlugin, StepIdentityInput } from "@rightmodeler/core";

export type NoiseTier = "precise" | "normal" | "noisy";

export interface CandidateMatch {
  slug: string;
  label: string;
  snippet: string;
  enclosingSymbolPath: string;
  normalizedCallShape: StepIdentityInput["normalizedCallShape"];
  needsTools: boolean;
  needsStructuredOutput: boolean;
  modelId?: string;
  /** Display metadata only. This value must never participate in identity. */
  line: number;
}

export interface Matcher extends MatcherPlugin {
  readonly slug: string;
  readonly description: string;
  readonly noiseTier: NoiseTier;
  readonly filePatterns: readonly string[];
  readonly examples: readonly string[];
  match(content: string, filePath: string): CandidateMatch[];
}

export interface NormalizedStepInput {
  readonly model: string;
  readonly trajectoryId?: string;
  readonly stepIndex?: number;
  readonly caseId?: string;
}
