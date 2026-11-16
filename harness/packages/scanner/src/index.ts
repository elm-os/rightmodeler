export {
  compileDeclarativeMatchers,
  declarativeMatcherSpecSchema,
  loadDeclarativeMatchers,
} from "./declarative-matcher.js";
export type {
  DeclarativeMatcher,
  DeclarativeMatcherErrorCode,
} from "./declarative-matcher.js";
export { coveragePolicy, evaluateCoverage } from "./coverage.js";
export { detectTech } from "./detect-tech.js";
export type { DetectedTech } from "./detect-tech.js";
export { IGNORED_DIRECTORIES } from "./ignored-directories.js";
export { MatcherRegistry } from "./matcher-registry.js";
export { builtinMatchers } from "./matchers/builtins.js";
export {
  AMBIGUOUS_MODEL_ID_REASON,
  AMBIGUOUS_TRACE_KEY_REASON,
  reconcile,
} from "./reconcile.js";
export { scan, scanRepository } from "./scan.js";
export type { CandidateMatch, Matcher } from "./types.js";

import { MatcherRegistry } from "./matcher-registry.js";
import { builtinMatchers } from "./matchers/builtins.js";
import type { Matcher } from "./types.js";

export function createMatcherRegistry(
  pluginMatchers: readonly Matcher[] = [],
): MatcherRegistry {
  return new MatcherRegistry([...builtinMatchers, ...pluginMatchers]);
}
