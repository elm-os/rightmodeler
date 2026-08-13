import { resolve } from "node:path";

import type { ReplayStartInput } from "./schemas.js";

export function replayCliArguments(input: ReplayStartInput): string[] {
  const args = ["--traces", resolve(input.traces), "--base-url", input.baseUrl];
  if (input.modeBConfig !== undefined) {
    args.push("--modeb-config", resolve(input.modeBConfig));
  }
  if (input.apiKeyEnv !== undefined) {
    args.push("--api-key-env", input.apiKeyEnv);
  }
  if (input.maxCostUsd !== undefined) {
    args.push("--max-cost-usd", String(input.maxCostUsd));
  }
  if (input.evaluator !== undefined) {
    args.push("--evaluator", input.evaluator.provider);
    if (input.evaluator.baseUrl !== undefined) {
      args.push("--evaluator-base-url", input.evaluator.baseUrl);
    }
    if (input.evaluator.apiKeyEnv !== undefined) {
      args.push("--evaluator-api-key-env", input.evaluator.apiKeyEnv);
    }
    if (input.evaluator.projectId !== undefined) {
      args.push("--evaluator-project-id", input.evaluator.projectId);
    }
    for (const scorer of input.evaluator.scorers ?? []) {
      args.push("--evaluator-scorer", scorer);
    }
    if (input.evaluator.gateMetric !== undefined) {
      args.push("--evaluator-gate-metric", input.evaluator.gateMetric);
    }
    if (input.evaluator.gateThreshold !== undefined) {
      args.push(
        "--evaluator-gate-threshold",
        String(input.evaluator.gateThreshold),
      );
    }
  }
  return args;
}
