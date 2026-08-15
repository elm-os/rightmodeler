import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  EvaluatorCase,
  EvaluatorCaseResult,
  EvaluatorMetric,
  EvaluatorProvider,
} from "./types.js";
import {
  apiRoot,
  environmentSecret,
  metadataBoolean,
  metadataSchema,
  metadataString,
  redactSecrets,
  requireText,
  resolveScoringConfig,
  responseJson,
  type ResolvedScoringConfig,
  type ScoringConfig,
} from "./shared.js";

export interface LangfuseEvaluatorConfig extends ScoringConfig {
  readonly baseUrl: string;
  readonly publicKeyEnv: string;
  readonly apiKeyEnv: string;
}

export interface ResolvedLangfuseEvaluatorConfig extends ResolvedScoringConfig {
  readonly baseUrl: string;
  readonly publicKeyEnv: string;
  readonly apiKeyEnv: string;
}

interface LangfuseRun {
  readonly cases: readonly EvaluatorCase[];
  readonly identities: ReadonlyMap<
    string,
    { readonly traceId: string; readonly observationId: string }
  >;
}

const healthSchema = z.object({ status: z.string().min(1) });
const otelResponseSchema = z.object({ partialSuccess: z.unknown().optional() });
const scoreSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  value: z.union([z.number(), z.boolean(), z.string()]),
  dataType: z.enum(["NUMERIC", "BOOLEAN", "CATEGORICAL", "TEXT", "CORRECTION"]),
  metadata: metadataSchema,
  subject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("trace"), id: z.string().min(1) }),
    z.object({
      kind: z.literal("observation"),
      id: z.string().min(1),
      traceId: z.string().min(1),
    }),
    z.object({ kind: z.literal("session"), id: z.string().min(1) }),
    z.object({ kind: z.literal("experiment"), id: z.string().min(1) }),
  ]),
});
const scoresSchema = z.object({
  data: z.array(scoreSchema),
  meta: z.object({ cursor: z.string().nullable().optional() }),
});

type LangfuseScore = z.infer<typeof scoreSchema>;

export function resolveLangfuseEvaluatorConfig(
  config: LangfuseEvaluatorConfig,
): ResolvedLangfuseEvaluatorConfig {
  return {
    baseUrl: requireText(config.baseUrl, "Evaluator baseUrl"),
    publicKeyEnv: requireText(config.publicKeyEnv, "Evaluator publicKeyEnv"),
    apiKeyEnv: requireText(config.apiKeyEnv, "Evaluator apiKeyEnv"),
    ...resolveScoringConfig(config),
  };
}

export function createLangfuseEvaluator(
  input: LangfuseEvaluatorConfig,
): EvaluatorProvider {
  const config = resolveLangfuseEvaluatorConfig(input);
  const runs = new Map<string, LangfuseRun>();
  const fetchedScores = new Map<string, readonly LangfuseScore[]>();

  const credentials = (): {
    readonly authorization: string;
    readonly secrets: readonly string[];
  } => {
    const publicKey = environmentSecret(
      config.publicKeyEnv,
      "Evaluator public key",
    );
    const secretKey = environmentSecret(config.apiKeyEnv, "Evaluator API key");
    const encoded = Buffer.from(`${publicKey}:${secretKey}`, "utf8").toString(
      "base64",
    );
    return {
      authorization: `Basic ${encoded}`,
      secrets: [publicKey, secretKey, encoded, `Basic ${encoded}`],
    };
  };

  const requestJson = async (
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const auth = credentials();
    const response = await fetch(apiRoot(config.baseUrl, path), {
      ...init,
      headers: {
        authorization: auth.authorization,
        ...(init?.body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-langfuse-ingestion-version": "4",
            }),
      },
    });
    return responseJson(response, "Langfuse evaluator", auth.secrets);
  };

  const fetchScores = async (
    providerRunId: string,
  ): Promise<readonly LangfuseScore[]> => {
    const run = runs.get(providerRunId);
    if (run === undefined) {
      throw new Error(`Unknown Langfuse evaluator run: ${providerRunId}`);
    }
    const traceIds = [...run.identities.values()].map(({ traceId }) => traceId);
    const scores: LangfuseScore[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        traceId: traceIds.join(","),
        name: config.scorers.join(","),
        fields: "details,subject",
        limit: "100",
      });
      if (cursor !== undefined) query.set("cursor", cursor);
      const parsed = scoresSchema.parse(
        await requestJson(`/api/public/v3/scores?${query.toString()}`),
      );
      scores.push(...parsed.data);
      cursor = parsed.meta.cursor ?? undefined;
    } while (cursor !== undefined);
    fetchedScores.set(providerRunId, scores);
    return scores;
  };

  return {
    id: "langfuse",
    async detectAvailability(): Promise<boolean> {
      let auth: ReturnType<typeof credentials>;
      try {
        auth = credentials();
      } catch {
        return false;
      }
      let response: Response;
      try {
        response = await fetch(apiRoot(config.baseUrl, "/api/public/health"), {
          headers: { authorization: auth.authorization },
        });
      } catch {
        return false;
      }
      if (!response.ok) return false;
      const text = await response.text();
      try {
        healthSchema.parse(JSON.parse(text) as unknown);
      } catch (error) {
        throw new Error(
          `Langfuse evaluator availability response was invalid: ${redactSecrets(error instanceof Error ? error.message : text, auth.secrets)}`,
        );
      }
      return true;
    },
    async launch(input) {
      const providerRunId = hashHex({
        experimentName: input.experimentName,
        caseIds: input.cases.map(({ caseId }) => caseId),
      });
      const identities = new Map(
        input.cases.map((item) => {
          const traceId = hashHex({ providerRunId, caseId: item.caseId }).slice(
            0,
            32,
          );
          return [
            item.caseId,
            {
              traceId,
              observationId: hashHex({ traceId, root: true }).slice(0, 16),
            },
          ] as const;
        }),
      );
      otelResponseSchema.parse(
        await requestJson("/api/public/otel/v1/traces", {
          method: "POST",
          body: JSON.stringify(
            langfuseExperimentPayload({
              providerRunId,
              experimentName: input.experimentName,
              cases: input.cases,
              identities,
              scorerNames: config.scorers,
            }),
          ),
        }),
      );
      runs.set(providerRunId, { cases: [...input.cases], identities });
      return { providerRunId };
    },
    async status(providerRunId) {
      const run = runs.get(providerRunId);
      if (run === undefined) {
        throw new Error(`Unknown Langfuse evaluator run: ${providerRunId}`);
      }
      const scores = await fetchScores(providerRunId);
      const available = new Set(
        scores.flatMap((score) => {
          const traceId = scoreTraceId(score);
          return traceId === undefined ? [] : [`${traceId}\0${score.name}`];
        }),
      );
      const complete = [...run.identities.values()].every(({ traceId }) =>
        config.scorers.every((name) => available.has(`${traceId}\0${name}`)),
      );
      return complete ? "complete" : "pending";
    },
    async collect(providerRunId): Promise<readonly EvaluatorCaseResult[]> {
      const run = runs.get(providerRunId);
      if (run === undefined) {
        throw new Error(`Unknown Langfuse evaluator run: ${providerRunId}`);
      }
      const scores =
        fetchedScores.get(providerRunId) ?? (await fetchScores(providerRunId));
      const caseByTrace = new Map(
        [...run.identities.entries()].map(([caseId, { traceId }]) => [
          traceId,
          caseId,
        ]),
      );
      const byCase = new Map<
        string,
        { metrics: EvaluatorMetric[]; scoreIds: string[] }
      >();
      for (const score of scores) {
        if (!config.scorers.includes(score.name)) continue;
        const traceId = scoreTraceId(score);
        const caseId =
          traceId === undefined ? undefined : caseByTrace.get(traceId);
        if (caseId === undefined) continue;
        const item = byCase.get(caseId) ?? { metrics: [], scoreIds: [] };
        item.metrics.push(scoreMetric(score));
        item.scoreIds.push(score.id);
        byCase.set(caseId, item);
      }
      return [...byCase.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([caseId, item]) => ({
          caseId,
          metrics: item.metrics.sort((left, right) =>
            left.metricName.localeCompare(right.metricName),
          ),
          artifactRef: {
            providerRunId,
            scoreIds: item.scoreIds.sort(),
          },
        }));
    },
  };
}

export function langfuseExperimentPayload(input: {
  readonly providerRunId: string;
  readonly experimentName: string;
  readonly datasetId?: string;
  readonly cases: readonly EvaluatorCase[];
  readonly identities: ReadonlyMap<
    string,
    { readonly traceId: string; readonly observationId: string }
  >;
  readonly scorerNames?: readonly string[];
}): unknown {
  const now = BigInt(Date.now()) * 1_000_000n;
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [attribute("service.name", "rightmodeler")],
        },
        scopeSpans: [
          {
            scope: { name: "rightmodeler", version: "1" },
            spans: input.cases.map((item, index) => {
              const identity = input.identities.get(item.caseId)!;
              return {
                traceId: identity.traceId,
                spanId: identity.observationId,
                name: "rightmodeler-evaluation-item",
                kind: 1,
                startTimeUnixNano: String(now + BigInt(index)),
                endTimeUnixNano: String(now + BigInt(index + 1)),
                attributes: [
                  attribute("langfuse.experiment.id", input.providerRunId),
                  attribute("langfuse.experiment.name", input.experimentName),
                  attribute(
                    "langfuse.experiment.dataset.id",
                    input.datasetId ?? `rightmodeler-${input.providerRunId}`,
                  ),
                  attribute("langfuse.experiment.item.id", item.caseId),
                  attribute(
                    "langfuse.experiment.item.root_observation_id",
                    identity.observationId,
                  ),
                  attribute(
                    "langfuse.experiment.item.expected_output",
                    JSON.stringify(item.expected),
                  ),
                  attribute(
                    "langfuse.observation.input",
                    JSON.stringify(item.input),
                  ),
                  attribute(
                    "langfuse.observation.output",
                    JSON.stringify(item.output),
                  ),
                  ...(input.scorerNames === undefined
                    ? []
                    : [
                        attribute(
                          "langfuse.experiment.item.metadata.scorers",
                          input.scorerNames.join(","),
                        ),
                      ]),
                ],
                status: { code: 1 },
              };
            }),
          },
        ],
      },
    ],
  };
}

export function stableLangfuseIdentity(value: unknown): {
  readonly traceId: string;
  readonly observationId: string;
} {
  const traceId = hashHex(value).slice(0, 32);
  return {
    traceId,
    observationId: hashHex({ traceId, root: true }).slice(0, 16),
  };
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function scoreTraceId(score: LangfuseScore): string | undefined {
  if (score.subject.kind === "trace") return score.subject.id;
  if (score.subject.kind === "observation") return score.subject.traceId;
  return undefined;
}

function scoreMetric(score: LangfuseScore): EvaluatorMetric {
  if (score.dataType === "NUMERIC" && typeof score.value === "number") {
    return {
      metricName: score.name,
      score: score.value,
      passed: metadataBoolean(score.metadata, "passed", "pass"),
      ...rubric(score),
    };
  }
  if (score.dataType === "BOOLEAN" && typeof score.value === "boolean") {
    return {
      metricName: score.name,
      score: score.value ? 1 : 0,
      passed: score.value,
      ...rubric(score),
    };
  }
  if (score.dataType === "CATEGORICAL" && typeof score.value === "string") {
    const normalized = score.value.toLowerCase();
    if (["pass", "passed", "true"].includes(normalized)) {
      return {
        metricName: score.name,
        score: 1,
        passed: true,
        ...rubric(score),
      };
    }
    if (["fail", "failed", "false"].includes(normalized)) {
      return {
        metricName: score.name,
        score: 0,
        passed: false,
        ...rubric(score),
      };
    }
  }
  throw new Error(
    `Langfuse evaluator score ${score.id} has unsupported ${score.dataType} value`,
  );
}

function rubric(score: LangfuseScore): { rubricVersion?: string } {
  const rubricVersion = metadataString(
    score.metadata,
    "rubricVersion",
    "rubric_version",
  );
  return rubricVersion === undefined ? {} : { rubricVersion };
}

function hashHex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
