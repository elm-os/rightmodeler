export {
  compileDeclarativeMatchers,
  declarativeMatcherSpecsSchema,
  declarativeMatcherSpecSchema,
  DeclarativeMatcherError,
} from "./declarative-matcher.js";
export type {
  DeclarativeMatcher,
  DeclarativeMatcherErrorCode,
  DeclarativeMatcherSpec,
} from "./declarative-matcher.js";
export { coveragePolicy, evaluateCoverage } from "./coverage.js";
export type {
  CoverageFailure,
  CoverageFailureCode,
  CoverageResult,
} from "./coverage.js";
export { detectTech } from "./detect-tech.js";
export type {
  DetectedAiDependency,
  DetectedLanguage,
  DetectedTech,
} from "./detect-tech.js";
export { MatcherRegistry } from "./matcher-registry.js";
export { builtinMatchers } from "./matchers/builtins.js";
export { AMBIGUOUS_MODEL_ID_REASON, reconcile } from "./reconcile.js";
export type {
  CaseStepLink,
  ReconciledCallSite,
  ReconciledTraceStep,
  ReconciliationResult,
  ReconciliationStatus,
} from "./reconcile.js";
export { scan } from "./scan.js";
export type {
  CandidateMatch,
  Matcher,
  NoiseTier,
  NormalizedStepInput,
} from "./types.js";

import { MatcherRegistry } from "./matcher-registry.js";
import { builtinMatchers } from "./matchers/builtins.js";
import type { Matcher } from "./types.js";

export function createMatcherRegistry(
  pluginMatchers: readonly Matcher[] = [],
): MatcherRegistry {
  return new MatcherRegistry([...builtinMatchers, ...pluginMatchers]);
}
