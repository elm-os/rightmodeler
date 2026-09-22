import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { computeRunSpecDigest, jsonValueSchema } from "@rightmodeler/core";
import { z } from "zod";

import type {
  EvaluatorCaseResult,
  EvaluatorMetric,
  EvaluatorProvider,
} from "./types.js";
import {
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

export const PROMPTFOO_VERIFIED_VERSION = "0.123.1";

export const PROMPTFOO_EVAL_FLAGS = [
  "--no-write",
  "--no-share",
  "--no-table",
  "--no-progress-bar",
] as const;

export const PROMPTFOO_ENV = {
  PROMPTFOO_DISABLE_UPDATE: "true",
  PROMPTFOO_DISABLE_VAR_EXPANSION: "true",
  PROMPTFOO_FAILED_TEST_EXIT_CODE: "100",
  PROMPTFOO_SHORT_CIRCUIT_TEST_FAILURES: "false",
  PROMPTFOO_STRIP_GRADING_RESULT: "false",
  PROMPTFOO_STRIP_RESPONSE_OUTPUT: "false",
  PROMPTFOO_STRIP_TEST_VARS: "false",
} as const;

export interface PromptfooSentCase {
  readonly caseId: string;
  readonly output: string;
}

export interface PromptfooParsedCase {
  readonly caseId: string;
  readonly testIdx: number;
  readonly metrics: readonly EvaluatorMetric[];
  readonly absentReason?:
    "external_output_mismatch" | "external_evaluator_error";
}

export interface PromptfooParsedRun {
  readonly evalId: string | null;
  readonly promptfooVersion: string;
  readonly cases: readonly PromptfooParsedCase[];
}

const execFileAsync = promisify(execFile);

const promptfooMetadataSchema = z.object({
  promptfooVersion: z.string().min(1),
});
const promptfooResultsFileSchema = z.object({
  evalId: z.string().nullable(),
  metadata: promptfooMetadataSchema,
  results: z.object({
    version: z.literal(3),
    results: z.array(
      z.object({
        testIdx: z.number().int().nonnegative(),
        failureReason: z.number().int(),
        vars: z.object({ tags: z.string().optional() }),
        response: z.object({ output: z.unknown() }).nullable().optional(),
        gradingResult: z
          .object({
            namedScores: z.record(z.string(), z.number()).optional(),
            componentResults: z
              .array(
                z.object({
                  pass: z.boolean(),
                  assertion: z
                    .record(z.string(), jsonValueSchema)
                    .nullable()
                    .optional(),
                }),
              )
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    ),
  }),
});

export function parsePromptfooResults(input: {
  readonly text: string;
  readonly sent: readonly PromptfooSentCase[];
  readonly scorers: readonly string[];
}): PromptfooParsedRun {
  const file = parsePromptfooResultsFile(input.text);
  const promptfooVersion = file.metadata.promptfooVersion;
  const rows = [...file.results.results].sort(
    (left, right) => left.testIdx - right.testIdx,
  );
  const seen = new Set<number>();
  for (const row of rows) {
    if (
      row.testIdx >= input.sent.length ||
      seen.has(row.testIdx) ||
      row.vars.tags !== input.sent[row.testIdx]!.caseId
    ) {
      throw new Error(
        `promptfoo's rows do not correspond one to one with the outputs sent (row testIdx ${row.testIdx}); a repeat setting in a promptfooconfig next to the assertions file is the usual cause.`,
      );
    }
    seen.add(row.testIdx);
  }
  const graded: Array<Record<string, number>> = [];
  const cases = rows.flatMap((row): PromptfooParsedCase[] => {
    const { caseId, output } = input.sent[row.testIdx]!;
    const testIdx = row.testIdx;
    if (row.failureReason !== 0 && row.failureReason !== 1) {
      return [
        {
          caseId,
          testIdx,
          metrics: [],
          absentReason: "external_evaluator_error",
        },
      ];
    }
    if (row.response?.output !== output.replace(/\n$/u, "")) {
      return [
        {
          caseId,
          testIdx,
          metrics: [],
          absentReason: "external_output_mismatch",
        },
      ];
    }
    const grading = row.gradingResult;
    const namedScores = grading?.namedScores;
    if (namedScores === undefined) return [];
    graded.push(namedScores);
    const metrics = input.scorers.flatMap((scorer): EvaluatorMetric[] => {
      const score = namedScores[scorer];
      const components = (grading?.componentResults ?? []).filter(
        ({ assertion }) => assertion?.metric === scorer,
      );
      if (score === undefined || components.length === 0) return [];
      const digest = computeRunSpecDigest(
        components.map(({ assertion }) => assertion!),
      ).slice(0, 16);
      return [
        {
          metricName: scorer,
          score,
          passed: components.every(({ pass }) => pass),
          rubricVersion: `promptfoo@${promptfooVersion}/${scorer}/${digest}`,
        },
      ];
    });
    return [{ caseId, testIdx, metrics }];
  });
  const missing =
    graded.length === 0
      ? undefined
      : input.scorers.find((scorer) =>
          graded.every((namedScores) => namedScores[scorer] === undefined),
        );
  if (missing !== undefined) {
    throw new Error(
      `promptfoo assertions produce no "${missing}" metric; add metric: ${missing} to an assertion in the --evaluator-config file, or drop --evaluator-scorer ${missing}, then rerun.`,
    );
  }
  return { evalId: file.evalId, promptfooVersion, cases };
}

function parsePromptfooResultsFile(
  text: string,
): z.infer<typeof promptfooResultsFileSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  const parsed = promptfooResultsFileSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const stated = z
    .object({ metadata: promptfooMetadataSchema })
    .safeParse(json);
  const found = stated.success
    ? stated.data.metadata.promptfooVersion
    : "(version not stated in the file)";
  throw new Error(
    `promptfoo ${found} wrote a results file rightmodeler cannot read: expected the promptfoo ${PROMPTFOO_VERIFIED_VERSION} layout, results.version 3 with one row per model output in results.results and the version in metadata.promptfooVersion. Install promptfoo ${PROMPTFOO_VERIFIED_VERSION} (npm install -g promptfoo@${PROMPTFOO_VERIFIED_VERSION}) or pass its executable with --evaluator-command, then rerun.`,
  );
}

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
  const command = /[\\/]/u.test(config.command)
    ? resolve(config.command)
    : config.command;
  const assertionsPath = resolve(config.assertionsPath);
  const results = new Map<string, PromptfooParsedRun>();

  return {
    id: "promptfoo",
    async detectAvailability(): Promise<boolean> {
      return (
        (await runPromptfoo(command, ["--version"], dirname(assertionsPath)))
          .code === 0
      );
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
      const sent = input.cases.map(({ caseId, output }) => ({
        caseId,
        output: typeof output === "string" ? output : JSON.stringify(output),
      }));
      const cwd = await realpath(dirname(assertionsPath));
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "rightmodeler-promptfoo-")),
      );
      const modelOutputsPath = join(directory, "model-outputs.json");
      const resultsPath = join(directory, "results.json");
      try {
        await writeFile(
          modelOutputsPath,
          JSON.stringify(
            sent.map(({ caseId, output }) => ({ output, tags: [caseId] })),
          ),
          "utf8",
        );
        const { code, stderr } = await runPromptfoo(
          command,
          [
            "eval",
            "--assertions",
            assertionsPath,
            "--model-outputs",
            relative(cwd, modelOutputsPath),
            "--output",
            resultsPath,
            ...PROMPTFOO_EVAL_FLAGS,
          ],
          cwd,
        );
        const stderrTail = stderr.slice(-2048);
        if (code !== 0 && code !== 100) {
          throw new Error(
            `promptfoo eval exited ${String(code)}: ${stderrTail}`,
          );
        }
        let text: string;
        try {
          text = await readFile(resultsPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          throw new Error(
            `promptfoo eval exited ${String(code)} without writing its results file: ${stderrTail}`,
          );
        }
        results.set(
          providerRunId,
          parsePromptfooResults({ text, sent, scorers: config.scorers }),
        );
        return { providerRunId };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async status(providerRunId) {
      if (!results.has(providerRunId)) {
        throw new Error(`Unknown Promptfoo evaluator run: ${providerRunId}`);
      }
      return "complete";
    },
    async collect(providerRunId): Promise<readonly EvaluatorCaseResult[]> {
      const run = results.get(providerRunId);
      if (run === undefined) {
        throw new Error(`Unknown Promptfoo evaluator run: ${providerRunId}`);
      }
      return run.cases.map(({ caseId, testIdx, metrics, absentReason }) => ({
        caseId,
        metrics,
        ...(absentReason === undefined ? {} : { absentReason }),
        artifactRef: {
          providerRunId,
          evalId: run.evalId,
          testIdx,
          promptfooVersion: run.promptfooVersion,
        },
      }));
    },
  };
}

export async function readPromptfooConfigs(
  assertionsPath: string,
): Promise<readonly { readonly file: string; readonly bytes: Buffer }[]> {
  const directory = dirname(resolve(assertionsPath));
  const configs = await Promise.all(
    ["yaml", "yml", "json", "cjs", "cts", "js", "mjs", "mts", "ts"].map(
      async (extension) => {
        const file = `promptfooconfig.${extension}`;
        try {
          return [{ file, bytes: await readFile(join(directory, file)) }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
    ),
  );
  return configs.flat();
}

async function runPromptfoo(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: unknown; stderr: string }> {
  const running = execFileAsync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...PROMPTFOO_ENV },
    maxBuffer: 10 * 1024 * 1024,
  });
  running.child.stdin?.end();
  try {
    const { stderr } = await running;
    return { code: 0, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stderr?: string };
    return { code: failed.code, stderr: failed.stderr ?? "" };
  }
}
