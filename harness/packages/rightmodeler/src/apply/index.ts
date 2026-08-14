import { basename, resolve } from "node:path";

import { createGithubClient } from "../github/index.js";
import { runApply, type RunApplyResult } from "../pipeline.js";

export * from "./diff.js";
export * from "./difflint.js";
export * from "./format.js";
export * from "./remediation.js";
export { applySwaps as applyPreparedSwaps } from "./orchestrator.js";
export type {
  ApplyCap,
  ApplyCascadeStatus,
  ApplyRefusal,
  ApplyRefusalCode,
  ApplyResult,
  ApplyVerdict,
} from "./orchestrator.js";

export interface ApplySwapsOptions {
  readonly repo: string;
  readonly store?: string;
  readonly owner: string;
  readonly githubBaseUrl: string;
  readonly githubTokenEnv: string;
  readonly dryRun?: boolean;
}

export type ApplySwapsResult = RunApplyResult;

export function applySwaps(
  options: ApplySwapsOptions,
): Promise<ApplySwapsResult> {
  return runApply({
    repo: options.repo,
    store: options.store,
    githubClient: createGithubClient({
      baseUrl: options.githubBaseUrl,
      tokenEnv: options.githubTokenEnv,
    }),
    owner: options.owner,
    githubRepo: basename(resolve(options.repo)),
    dryRun: options.dryRun ?? false,
  });
}
