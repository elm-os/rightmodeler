import { pipelineArgv, type PipelineCommandOptions } from "@rightmodeler/cli";

import type { ReplayStartInput } from "./schemas.js";

export function replayCliArguments(input: ReplayStartInput): string[] {
  const options: PipelineCommandOptions = {
    traces: input.traces,
    matchers: input.matchers,
    modebConfig: input.modeBConfig,
    baseUrl: input.baseUrl,
    apiKeyEnv: input.apiKeyEnv,
    maxCostUsd:
      input.maxCostUsd === undefined ? undefined : String(input.maxCostUsd),
    maxConcurrency:
      input.maxConcurrency === undefined
        ? undefined
        : String(input.maxConcurrency),
    pricingFile: input.pricingFile,
    policy: input.policy,
    includeFree: input.includeFree,
    approvedRun: input.approvedRun,
    evaluator: input.evaluator?.provider,
    evaluatorBaseUrl: input.evaluator?.baseUrl,
    evaluatorApiKeyEnv: input.evaluator?.apiKeyEnv,
    evaluatorPublicKeyEnv: input.evaluator?.publicKeyEnv,
    evaluatorProjectId: input.evaluator?.projectId,
    evaluatorCommand: input.evaluator?.command,
    evaluatorConfig: input.evaluator?.config,
    evaluatorScorer: input.evaluator?.scorers,
    evaluatorGateMetric: input.evaluator?.gateMetric,
    evaluatorGateThreshold:
      input.evaluator?.gateThreshold === undefined
        ? undefined
        : String(input.evaluator.gateThreshold),
  };
  return pipelineArgv(options);
}
