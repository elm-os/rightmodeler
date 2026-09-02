import type { JsonValue } from "./facts.js";

export interface MatcherPlugin {
  readonly examples: readonly string[];
  match(content: string, path: string): readonly unknown[];
}

export interface EvaluatorCase {
  readonly caseId: string;
  readonly input: JsonValue;
  readonly expected: JsonValue;
  readonly output: JsonValue;
}

export interface EvaluatorLaunchInput {
  readonly experimentName: string;
  readonly cases: readonly EvaluatorCase[];
}

export type EvaluatorRunStatus = "pending" | "complete" | "failed";

export interface EvaluatorMetric {
  readonly metricName: string;
  readonly score: number;
  readonly passed: boolean | null;
  readonly rubricVersion?: string;
}

export interface EvaluatorCaseResult {
  readonly caseId: string;
  readonly metrics: readonly EvaluatorMetric[];
  readonly artifactRef?: JsonValue;
}

export interface EvaluatorProvider {
  readonly id: string;
  detectAvailability(): Promise<boolean>;
  launch(params: EvaluatorLaunchInput): Promise<{ providerRunId: string }>;
  status(runId: string): Promise<EvaluatorRunStatus>;
  collect(runId: string): Promise<readonly EvaluatorCaseResult[]>;
}

export interface ExecutorProvider {
  launch(params: unknown): Promise<string>;
  collect(runId: string, request: unknown): Promise<unknown>;
  status(runId: string): Promise<unknown>;
  destroy(runId: string): Promise<void>;
}
