import { z } from "zod";

import type {
  EvaluatorCaseResult,
  EvaluatorProvider,
  EvaluatorRunStatus,
} from "./types.js";

export interface BraintrustEvaluatorConfig {
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly projectId: string;
  readonly scorers: readonly string[];
  readonly gateMetric?: string;
  readonly gateThreshold?: number;
}

export interface ResolvedBraintrustEvaluatorConfig {
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly projectId: string;
  readonly scorers: readonly string[];
  readonly gateMetric: string;
  readonly gateThreshold?: number;
}

export type EvaluatorPollingResult =
  "complete" | "failed" | "polling_exhausted";

const experimentSchema = z.object({ id: z.string().min(1) });
const insertSchema = z.object({ row_ids: z.array(z.string()) });
const projectListSchema = z.object({ objects: z.array(z.unknown()) });
const eventSchema = z.object({
  id: z.string().min(1),
  scores: z.record(z.string(), z.number()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
});
const fetchSchema = z.object({
  events: z.array(eventSchema),
  cursor: z.string().nullable().optional(),
});

type EvaluatorEvent = z.infer<typeof eventSchema>;

export function resolveBraintrustEvaluatorConfig(
  config: BraintrustEvaluatorConfig,
): ResolvedBraintrustEvaluatorConfig {
  if (config.apiKeyEnv.length === 0) {
    throw new Error("Evaluator apiKeyEnv must not be empty");
  }
  if (config.baseUrl.length === 0) {
    throw new Error("Evaluator baseUrl must not be empty");
  }
  if (config.projectId.length === 0) {
    throw new Error("Evaluator projectId must not be empty");
  }
  if (config.scorers.length === 0) {
    throw new Error("At least one evaluator scorer must be configured");
  }
  if (config.scorers.some((scorer) => scorer.length === 0)) {
    throw new Error("Evaluator scorer names must not be empty");
  }
  if (new Set(config.scorers).size !== config.scorers.length) {
    throw new Error("Evaluator scorer names must not contain duplicates");
  }
  if (
    config.gateThreshold !== undefined &&
    !Number.isFinite(config.gateThreshold)
  ) {
    throw new Error("Evaluator gateThreshold must be a finite number");
  }
  const gateMetric =
    config.gateMetric ??
    (config.scorers.length === 1 ? config.scorers[0] : undefined);
  if (gateMetric === undefined) {
    throw new Error(
      `Multiple evaluator scorers are configured; choose --evaluator-gate-metric from: ${config.scorers.join(", ")}`,
    );
  }
  if (!config.scorers.includes(gateMetric)) {
    throw new Error(
      `Evaluator gate metric ${gateMetric} is not a configured scorer; choose from: ${config.scorers.join(", ")}`,
    );
  }
  return {
    apiKeyEnv: config.apiKeyEnv,
    baseUrl: config.baseUrl,
    projectId: config.projectId,
    scorers: [...config.scorers],
    gateMetric,
    ...(config.gateThreshold === undefined
      ? {}
      : { gateThreshold: config.gateThreshold }),
  };
}

export function createBraintrustEvaluator(
  input: BraintrustEvaluatorConfig,
): EvaluatorProvider {
  const config = resolveBraintrustEvaluatorConfig(input);
  const expectedCases = new Map<string, Set<string>>();
  const fetchedEvents = new Map<string, readonly EvaluatorEvent[]>();

  const requestJson = async (
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const apiKey = process.env[config.apiKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        `Evaluator API key environment variable is not set: ${config.apiKeyEnv}`,
      );
    }
    const response = await fetch(apiUrl(config.baseUrl, path), {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Evaluator request failed with ${response.status}: ${redact(text, apiKey)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Evaluator returned invalid JSON: ${redact(text, apiKey)}`,
      );
    }
  };

  const fetchEvents = async (
    providerRunId: string,
  ): Promise<readonly EvaluatorEvent[]> => {
    const parsed = fetchSchema.parse(
      await requestJson(`experiment/${providerRunId}/fetch`),
    );
    const latest = new Map<string, EvaluatorEvent>();
    for (const event of parsed.events) latest.set(event.id, event);
    const events = [...latest.values()];
    fetchedEvents.set(providerRunId, events);
    return events;
  };

  return {
    id: "braintrust",
    async detectAvailability(): Promise<boolean> {
      const apiKey = process.env[config.apiKeyEnv];
      if (apiKey === undefined || apiKey.length === 0) return false;
      let response: Response;
      try {
        response = await fetch(apiUrl(config.baseUrl, "project"), {
          headers: { authorization: `Bearer ${apiKey}` },
        });
      } catch {
        return false;
      }
      if (!response.ok) return false;
      const text = await response.text();
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error(
          `Evaluator availability response was invalid JSON: ${redact(text, apiKey)}`,
        );
      }
      projectListSchema.parse(value);
      return true;
    },
    async launch(input) {
      const experiment = experimentSchema.parse(
        await requestJson("experiment", {
          method: "POST",
          body: JSON.stringify({
            project_id: config.projectId,
            name: input.experimentName,
          }),
        }),
      );
      const inserted = insertSchema.parse(
        await requestJson(`experiment/${experiment.id}/insert`, {
          method: "POST",
          body: JSON.stringify({
            events: input.cases.map((item) => ({
              id: item.caseId,
              input: item.input,
              output: item.output,
              expected: item.expected,
              metadata: {
                case_id: item.caseId,
                scorers: config.scorers,
              },
            })),
          }),
        }),
      );
      if (inserted.row_ids.length !== input.cases.length) {
        throw new Error(
          `Evaluator inserted ${inserted.row_ids.length} of ${input.cases.length} events`,
        );
      }
      expectedCases.set(
        experiment.id,
        new Set(input.cases.map(({ caseId }) => caseId)),
      );
      return { providerRunId: experiment.id };
    },
    async status(providerRunId): Promise<EvaluatorRunStatus> {
      const events = await fetchEvents(providerRunId);
      if (events.some((event) => event.error !== undefined)) return "failed";
      const expected = expectedCases.get(providerRunId);
      const complete =
        events.length > 0 &&
        (expected === undefined ||
          (events.length === expected.size &&
            events.every((event) => expected.has(event.id)))) &&
        events.every((event) =>
          config.scorers.every(
            (scorer) => typeof event.scores?.[scorer] === "number",
          ),
        );
      return complete ? "complete" : "pending";
    },
    async collect(providerRunId): Promise<readonly EvaluatorCaseResult[]> {
      const events =
        fetchedEvents.get(providerRunId) ?? (await fetchEvents(providerRunId));
      return events.flatMap((event): EvaluatorCaseResult[] => {
        if (event.scores === undefined) return [];
        const metrics = Object.entries(event.scores)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([metricName, score]) => {
            const passed = passDecision(
              event.metadata,
              metricName,
              Object.keys(event.scores!).length,
            );
            const rubricVersion = rubric(
              event.metadata,
              metricName,
              Object.keys(event.scores!).length,
            );
            return {
              metricName,
              score,
              passed,
              ...(rubricVersion === undefined ? {} : { rubricVersion }),
            };
          });
        return metrics.length === 0
          ? []
          : [
              {
                caseId: event.id,
                metrics,
                artifactRef: {
                  providerRunId,
                  eventId: event.id,
                },
              },
            ];
      });
    },
  };
}

export async function pollEvaluator(
  evaluator: EvaluatorProvider,
  providerRunId: string,
): Promise<EvaluatorPollingResult> {
  const delays = [0, 25, 50, 100, 200, 400] as const;
  for (const delay of delays) {
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    const status = await evaluator.status(providerRunId);
    if (status === "complete" || status === "failed") return status;
  }
  return "polling_exhausted";
}

export async function preferEvaluatorWhenReachable(
  evaluator: EvaluatorProvider,
  warn: (code: string, message: string) => void,
): Promise<EvaluatorProvider | undefined> {
  if (await evaluator.detectAvailability()) return evaluator;
  warn(
    "external_evaluator_unreachable",
    "The configured external evaluator is unreachable; falling back to the built-in judge.",
  );
  return undefined;
}

function apiUrl(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  const versioned = root.endsWith("/v1") ? root : `${root}/v1`;
  return `${versioned}/${path}`;
}

function redact(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, "[redacted]");
}

function passDecision(
  metadata: Readonly<Record<string, unknown>> | undefined,
  metricName: string,
  metricCount: number,
): boolean | null {
  const decisions = objectValue(metadata?.pass_decisions);
  const perMetric = decisions?.[metricName];
  if (typeof perMetric === "boolean") return perMetric;
  return metricCount === 1 && typeof metadata?.passed === "boolean"
    ? metadata.passed
    : null;
}

function rubric(
  metadata: Readonly<Record<string, unknown>> | undefined,
  metricName: string,
  metricCount: number,
): string | undefined {
  const versions = objectValue(metadata?.rubric_versions);
  const perMetric = versions?.[metricName];
  if (typeof perMetric === "string" && perMetric.length > 0) return perMetric;
  return metricCount === 1 &&
    typeof metadata?.rubric_version === "string" &&
    metadata.rubric_version.length > 0
    ? metadata.rubric_version
    : undefined;
}

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
