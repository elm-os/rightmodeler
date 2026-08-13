import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  EvaluatorCaseResult,
  EvaluatorMetric,
  EvaluatorProvider,
} from "./types.js";
import {
  apiRoot,
  environmentSecret,
  metadataBoolean,
  metadataString,
  redactSecrets,
  requireText,
  resolveScoringConfig,
  responseJson,
  type ResolvedScoringConfig,
  type ScoringConfig,
} from "./shared.js";

export interface LangsmithEvaluatorConfig extends ScoringConfig {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly datasetId: string;
}

export interface ResolvedLangsmithEvaluatorConfig extends ResolvedScoringConfig {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly datasetId: string;
  readonly evaluatorRules: readonly {
    readonly metricName: string;
    readonly ruleId: string;
  }[];
}

const sessionSchema = z.object({ id: z.string().min(1) });
const feedbackEntrySchema = z.object({
  score: z.number().optional(),
  value: z.union([z.string(), z.boolean(), z.number()]).optional(),
  feedback_source: z
    .object({ metadata: z.record(z.string(), z.unknown()).nullish() })
    .optional(),
});
const feedbackSummarySchema = z.union([
  z.number(),
  z.object({
    avg: z.number(),
    pass: z.boolean().optional(),
    rubric_version: z.string().min(1).optional(),
  }),
  z.array(feedbackEntrySchema).min(1),
]);
const queriedRunSchema = z.object({
  id: z.string().min(1),
  reference_example_id: z.string().min(1).nullable().optional(),
  error: z.unknown().nullable().optional(),
  feedback_stats: z.record(z.string(), feedbackSummarySchema).default({}),
});
const runsSchema = z.object({ runs: z.array(queriedRunSchema) });

type QueriedRun = z.infer<typeof queriedRunSchema>;
type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;

export function resolveLangsmithEvaluatorConfig(
  config: LangsmithEvaluatorConfig,
): ResolvedLangsmithEvaluatorConfig {
  const scoring = resolveScoringConfig({
    ...config,
    scorers: config.scorers.map(scorerMetric),
    gateMetric:
      config.gateMetric === undefined
        ? undefined
        : scorerMetric(config.gateMetric),
  });
  return {
    baseUrl: requireText(config.baseUrl, "Evaluator baseUrl"),
    apiKeyEnv: requireText(config.apiKeyEnv, "Evaluator apiKeyEnv"),
    datasetId: requireText(config.datasetId, "Evaluator datasetId"),
    ...scoring,
    evaluatorRules: config.scorers.map((scorer) => ({
      metricName: scorerMetric(scorer),
      ruleId: scorerRule(scorer),
    })),
  };
}

export function createLangsmithEvaluator(
  input: LangsmithEvaluatorConfig,
): EvaluatorProvider {
  const config = resolveLangsmithEvaluatorConfig(input);
  const expectedRuns = new Map<string, ReadonlyMap<string, string>>();
  const fetchedRuns = new Map<string, readonly QueriedRun[]>();

  const requestJson = async (
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const apiKey = environmentSecret(config.apiKeyEnv, "Evaluator API key");
    const response = await fetch(apiRoot(config.baseUrl, path), {
      ...init,
      headers: {
        "x-api-key": apiKey,
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    return responseJson(response, "LangSmith evaluator", [apiKey]);
  };

  const fetchRuns = async (providerRunId: string) => {
    const parsed = runsSchema.parse(
      await requestJson("/api/v1/runs/query", {
        method: "POST",
        body: JSON.stringify({
          session: [providerRunId],
          is_root: true,
          select: ["id", "reference_example_id", "error", "feedback_stats"],
        }),
      }),
    );
    fetchedRuns.set(providerRunId, parsed.runs);
    return parsed.runs;
  };

  return {
    id: "langsmith",
    async detectAvailability(): Promise<boolean> {
      const apiKey = process.env[config.apiKeyEnv];
      if (apiKey === undefined || apiKey.length === 0) return false;
      let response: Response;
      try {
        response = await fetch(
          apiRoot(config.baseUrl, "/api/v1/datasets?limit=1"),
          {
            headers: { "x-api-key": apiKey },
          },
        );
      } catch {
        return false;
      }
      if (!response.ok) return false;
      const text = await response.text();
      try {
        z.array(z.unknown()).parse(JSON.parse(text) as unknown);
      } catch (error) {
        throw new Error(
          `LangSmith evaluator availability response was invalid: ${redactSecrets(error instanceof Error ? error.message : text, [apiKey])}`,
        );
      }
      return true;
    },
    async launch(input) {
      const now = new Date().toISOString();
      const session = sessionSchema.parse(
        await requestJson("/api/v1/sessions", {
          method: "POST",
          body: JSON.stringify({
            start_time: now,
            reference_dataset_id: config.datasetId,
            name: input.experimentName,
          }),
        }),
      );
      const runIds = new Map<string, string>();
      for (const item of input.cases) {
        const runId = stableUuid({
          sessionId: session.id,
          caseId: item.caseId,
        });
        await requestJson("/api/v1/runs", {
          method: "POST",
          body: JSON.stringify({
            id: runId,
            name: "rightmodeler-evaluation-item",
            run_type: "chain",
            inputs: item.input,
            start_time: now,
            reference_example_id: item.caseId,
            session_id: session.id,
            extra: {
              metadata: {
                rightmodeler_expected: item.expected,
                rightmodeler_case_id: item.caseId,
              },
            },
          }),
        });
        await requestJson(`/api/v1/runs/${runId}`, {
          method: "PATCH",
          body: JSON.stringify({ outputs: item.output, end_time: now }),
        });
        runIds.set(runId, item.caseId);
      }
      await requestJson(`/api/v1/sessions/${session.id}`, {
        method: "PATCH",
        body: JSON.stringify({ end_time: now }),
      });
      for (const { ruleId } of config.evaluatorRules) {
        await requestJson(`/api/v1/runs/experiments/${session.id}/evaluate`, {
          method: "POST",
          body: JSON.stringify({ rule_id: ruleId }),
        });
      }
      expectedRuns.set(session.id, runIds);
      return { providerRunId: session.id };
    },
    async status(providerRunId) {
      const expected = expectedRuns.get(providerRunId);
      if (expected === undefined) {
        throw new Error(`Unknown LangSmith evaluator run: ${providerRunId}`);
      }
      const runs = await fetchRuns(providerRunId);
      if (runs.some((run) => run.error !== undefined && run.error !== null)) {
        return "failed";
      }
      const complete =
        runs.length === expected.size &&
        runs.every(
          (run) =>
            expected.has(run.id) &&
            config.scorers.every(
              (metricName) => run.feedback_stats[metricName] !== undefined,
            ),
        );
      return complete ? "complete" : "pending";
    },
    async collect(providerRunId): Promise<readonly EvaluatorCaseResult[]> {
      const expected = expectedRuns.get(providerRunId);
      if (expected === undefined) {
        throw new Error(`Unknown LangSmith evaluator run: ${providerRunId}`);
      }
      const runs =
        fetchedRuns.get(providerRunId) ?? (await fetchRuns(providerRunId));
      return runs.flatMap((run) => {
        const caseId = expected.get(run.id);
        if (
          caseId === undefined ||
          (run.error !== undefined && run.error !== null)
        ) {
          return [];
        }
        const metrics = config.scorers.flatMap((metricName) => {
          const summary = run.feedback_stats[metricName];
          return summary === undefined
            ? []
            : [langsmithMetric(metricName, summary)];
        });
        return metrics.length === 0
          ? []
          : [
              {
                caseId,
                metrics,
                artifactRef: { providerRunId, runId: run.id },
              },
            ];
      });
    },
  };
}

function langsmithMetric(
  metricName: string,
  summary: FeedbackSummary,
): EvaluatorMetric {
  if (typeof summary === "number") {
    return { metricName, score: summary, passed: null };
  }
  if (!Array.isArray(summary)) {
    return {
      metricName,
      score: summary.avg,
      passed: summary.pass ?? null,
      ...(summary.rubric_version === undefined
        ? {}
        : { rubricVersion: summary.rubric_version }),
    };
  }
  const latest = summary.at(-1)!;
  const score =
    latest.score ??
    (typeof latest.value === "boolean"
      ? latest.value
        ? 1
        : 0
      : typeof latest.value === "number"
        ? latest.value
        : undefined);
  if (score === undefined) {
    throw new Error(`LangSmith evaluator metric ${metricName} has no score`);
  }
  const metadata = latest.feedback_source?.metadata ?? undefined;
  const valuePass =
    typeof latest.value === "boolean"
      ? latest.value
      : typeof latest.value === "string"
        ? categoricalPass(latest.value)
        : null;
  const rubricVersion = metadataString(
    metadata ?? undefined,
    "rubricVersion",
    "rubric_version",
  );
  return {
    metricName,
    score,
    passed:
      valuePass ?? metadataBoolean(metadata ?? undefined, "passed", "pass"),
    ...(rubricVersion === undefined ? {} : { rubricVersion }),
  };
}

function categoricalPass(value: string): boolean | null {
  const normalized = value.toLowerCase();
  if (["pass", "passed", "true"].includes(normalized)) return true;
  if (["fail", "failed", "false"].includes(normalized)) return false;
  return null;
}

function scorerMetric(value: string): string {
  return value.split("=", 1)[0]!;
}

function scorerRule(value: string): string {
  const separator = value.indexOf("=");
  return separator === -1 ? value : value.slice(separator + 1);
}

function stableUuid(value: unknown): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}
