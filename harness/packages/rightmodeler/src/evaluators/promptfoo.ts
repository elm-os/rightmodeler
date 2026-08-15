import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import type {
  EvaluatorCaseResult,
  EvaluatorMetric,
  EvaluatorProvider,
} from "./types.js";
import {
  metadataBoolean,
  metadataString,
  requireText,
  resolveScoringConfig,
  type ResolvedScoringConfig,
  type ScoringConfig,
} from "./shared.js";

export interface PromptfooEvaluatorConfig extends ScoringConfig {
  readonly command: string;
  readonly assertionsPath: string;
}

export interface ResolvedPromptfooEvaluatorConfig extends ResolvedScoringConfig {
  readonly command: string;
  readonly assertionsPath: string;
}

const execFileAsync = promisify(execFile);

const gradingResultSchema: z.ZodType<{
  pass: boolean;
  score: number;
  namedScores?: Record<string, number>;
  metadata?: Record<string, unknown>;
  componentResults?: Array<{
    pass: boolean;
    score: number;
    metadata?: Record<string, unknown>;
    assertion?: { metric?: string; type?: string };
  }>;
}> = z.object({
  pass: z.boolean(),
  score: z.number(),
  namedScores: z.record(z.string(), z.number()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  componentResults: z
    .array(
      z.object({
        pass: z.boolean(),
        score: z.number(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        assertion: z
          .object({
            metric: z.string().min(1).optional(),
            type: z.string().min(1).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
const rowSchema = z.object({
  testIdx: z.number().int().nonnegative(),
  success: z.boolean(),
  score: z.number(),
  error: z.string().optional(),
  gradingResult: gradingResultSchema.nullable().optional(),
});
const outputSchema = z.object({
  version: z.literal(3),
  evalId: z.string().nullable().optional(),
  results: z.object({
    outputs: z.array(rowSchema),
  }),
});

type PromptfooRow = z.infer<typeof rowSchema>;

export function resolvePromptfooEvaluatorConfig(
  config: PromptfooEvaluatorConfig,
): ResolvedPromptfooEvaluatorConfig {
  return {
    command: requireText(config.command, "Promptfoo evaluator command"),
    assertionsPath: requireText(
      config.assertionsPath,
      "Promptfoo evaluator assertionsPath",
    ),
    ...resolveScoringConfig(config),
  };
}

export function createPromptfooEvaluator(
  input: PromptfooEvaluatorConfig,
): EvaluatorProvider {
  const config = resolvePromptfooEvaluatorConfig(input);
  const results = new Map<
    string,
    {
      readonly evalId: string | null;
      readonly rows: readonly PromptfooRow[];
      readonly caseIds: readonly string[];
    }
  >();

  return {
    id: "promptfoo",
    async detectAvailability(): Promise<boolean> {
      try {
        await execFileAsync(config.command, ["--version"], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });
        return true;
      } catch {
        return false;
      }
    },
    async launch(input) {
      const providerRunId = createHash("sha256")
        .update(
          JSON.stringify({
            experimentName: input.experimentName,
            caseIds: input.cases.map(({ caseId }) => caseId),
          }),
        )
        .digest("hex");
      const directory = await mkdtemp(
        join(tmpdir(), "rightmodeler-promptfoo-"),
      );
      const modelOutputsPath = join(directory, "model-outputs.json");
      const resultsPath = join(directory, "results.json");
      try {
        await writeFile(
          modelOutputsPath,
          JSON.stringify(
            input.cases.map((item) => ({
              output:
                typeof item.output === "string"
                  ? item.output
                  : JSON.stringify(item.output),
              tags: [item.caseId],
            })),
          ),
          "utf8",
        );
        await execFileAsync(
          config.command,
          [
            "eval",
            "--assertions",
            config.assertionsPath,
            "--model-outputs",
            modelOutputsPath,
            "--output",
            resultsPath,
          ],
          { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = outputSchema.parse(
          JSON.parse(await readFile(resultsPath, "utf8")) as unknown,
        );
        const rows = parsed.results.outputs;
        if (rows.some(({ testIdx }) => testIdx >= input.cases.length)) {
          throw new Error(
            "Promptfoo evaluator output contains an unknown test index",
          );
        }
        results.set(providerRunId, {
          evalId: parsed.evalId ?? null,
          rows,
          caseIds: input.cases.map(({ caseId }) => caseId),
        });
        return { providerRunId };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async status(providerRunId) {
      const run = results.get(providerRunId);
      if (run === undefined) {
        throw new Error(`Unknown Promptfoo evaluator run: ${providerRunId}`);
      }
      return run.rows.some(({ error }) => error !== undefined)
        ? "failed"
        : "complete";
    },
    async collect(providerRunId): Promise<readonly EvaluatorCaseResult[]> {
      const run = results.get(providerRunId);
      if (run === undefined) {
        throw new Error(`Unknown Promptfoo evaluator run: ${providerRunId}`);
      }
      return run.rows.flatMap((row) => {
        if (row.error !== undefined || row.gradingResult === null) return [];
        const metrics = promptfooMetrics(row, config.scorers);
        return metrics.length === 0
          ? []
          : [
              {
                caseId: run.caseIds[row.testIdx]!,
                metrics,
                artifactRef: {
                  providerRunId,
                  evalId: run.evalId,
                  testIdx: row.testIdx,
                },
              },
            ];
      });
    },
  };
}

function promptfooMetrics(
  row: PromptfooRow,
  scorers: readonly string[],
): EvaluatorMetric[] {
  const grading = row.gradingResult;
  if (grading === undefined || grading === null) return [];
  if (grading.namedScores !== undefined) {
    return scorers.flatMap((metricName) => {
      const score = grading.namedScores?.[metricName];
      if (score === undefined) return [];
      const component = grading.componentResults?.find(
        (item) => item.assertion?.metric === metricName,
      );
      const rubricVersion = metadataString(
        component?.metadata ?? grading.metadata,
        "rubricVersion",
        "rubric_version",
      );
      return [
        {
          metricName,
          score,
          passed:
            component?.pass ??
            metadataBoolean(grading.metadata, `${metricName}_passed`),
          ...(rubricVersion === undefined ? {} : { rubricVersion }),
        },
      ];
    });
  }
  if (scorers.length !== 1) {
    throw new Error("Promptfoo evaluator output omits configured named scores");
  }
  const rubricVersion = metadataString(
    grading.metadata,
    "rubricVersion",
    "rubric_version",
  );
  return [
    {
      metricName: scorers[0]!,
      score: grading.score,
      passed: grading.pass,
      ...(rubricVersion === undefined ? {} : { rubricVersion }),
    },
  ];
}
