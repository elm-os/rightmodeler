import type { JsonValue } from "@rightmodeler/core";

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

export type EvaluatorRunStatus = "pending" | "running" | "complete" | "failed";

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
  launch(input: EvaluatorLaunchInput): Promise<{ providerRunId: string }>;
  status(providerRunId: string): Promise<EvaluatorRunStatus>;
  collect(providerRunId: string): Promise<readonly EvaluatorCaseResult[]>;
}
