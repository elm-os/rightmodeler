import {
  createBraintrustEvaluator,
  resolveBraintrustEvaluatorConfig,
  type BraintrustEvaluatorConfig,
  type ResolvedBraintrustEvaluatorConfig,
} from "./braintrust.js";
import {
  createLangfuseEvaluator,
  resolveLangfuseEvaluatorConfig,
  type LangfuseEvaluatorConfig,
  type ResolvedLangfuseEvaluatorConfig,
} from "./langfuse.js";
import {
  createLangsmithEvaluator,
  resolveLangsmithEvaluatorConfig,
  type LangsmithEvaluatorConfig,
  type ResolvedLangsmithEvaluatorConfig,
} from "./langsmith.js";
import {
  createPromptfooEvaluator,
  resolvePromptfooEvaluatorConfig,
  type PromptfooEvaluatorConfig,
  type ResolvedPromptfooEvaluatorConfig,
} from "./promptfoo.js";
import type { EvaluatorProvider } from "./types.js";

export type EvaluatorProviderName =
  "braintrust" | "langfuse" | "langsmith" | "promptfoo";

export type EvaluatorConfig =
  | ({ readonly provider: "braintrust" } & BraintrustEvaluatorConfig)
  | ({ readonly provider: "langfuse" } & LangfuseEvaluatorConfig)
  | ({ readonly provider: "langsmith" } & LangsmithEvaluatorConfig)
  | ({ readonly provider: "promptfoo" } & PromptfooEvaluatorConfig);

export type ResolvedEvaluatorConfig =
  | ({ readonly provider: "braintrust" } & ResolvedBraintrustEvaluatorConfig)
  | ({ readonly provider: "langfuse" } & ResolvedLangfuseEvaluatorConfig)
  | ({ readonly provider: "langsmith" } & ResolvedLangsmithEvaluatorConfig)
  | ({ readonly provider: "promptfoo" } & ResolvedPromptfooEvaluatorConfig);

export function resolveEvaluatorConfig(
  config: EvaluatorConfig,
): ResolvedEvaluatorConfig {
  switch (config.provider) {
    case "braintrust":
      return {
        provider: config.provider,
        ...resolveBraintrustEvaluatorConfig(config),
      };
    case "langfuse":
      return {
        provider: config.provider,
        ...resolveLangfuseEvaluatorConfig(config),
      };
    case "langsmith":
      return {
        provider: config.provider,
        ...resolveLangsmithEvaluatorConfig(config),
      };
    case "promptfoo":
      return {
        provider: config.provider,
        ...resolvePromptfooEvaluatorConfig(config),
      };
  }
}

export function createEvaluator(
  config: ResolvedEvaluatorConfig,
): EvaluatorProvider {
  switch (config.provider) {
    case "braintrust":
      return createBraintrustEvaluator(config);
    case "langfuse":
      return createLangfuseEvaluator(config);
    case "langsmith":
      return createLangsmithEvaluator(config);
    case "promptfoo":
      return createPromptfooEvaluator(config);
  }
}
