import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPromptfooEvaluator,
  parsePromptfooResults,
  type PromptfooParsedRun,
  type PromptfooSentCase,
} from "./promptfoo.js";

interface CapturedComponent {
  pass: boolean;
  score: number;
  reason: string;
  assertion?: { type?: string; value?: unknown; metric?: string };
  metadata?: Record<string, unknown>;
}

interface CapturedRow {
  testIdx: number;
  promptIdx: number;
  success: boolean;
  score: number;
  failureReason: number;
  error?: string;
  namedScores?: Record<string, number>;
  vars: { output?: string; tags?: string };
  response?: { output?: unknown } | null;
  gradingResult: {
    pass?: boolean;
    score?: number;
    reason?: string;
    namedScores?: Record<string, number>;
    componentResults?: CapturedComponent[];
  } | null;
}

interface CapturedFile {
  metadata: { promptfooVersion: string };
  results: { version: number; results: CapturedRow[] };
}

function readCaptured(file: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../fixtures/promptfoo-stub/captured/${file}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
}

const captured = readCaptured("results.json") as CapturedFile;
const modelOutputs = readCaptured("model-outputs.json") as Array<{
  output: string;
  tags: string[];
}>;
const sent: readonly PromptfooSentCase[] = modelOutputs.map(
  ({ output, tags }) => ({ caseId: tags[0]!, output }),
);
const scorers = ["output_similarity", "secondary_similarity"];
const stubPath = fileURLToPath(
  new URL("../../../../fixtures/promptfoo-stub/run.mjs", import.meta.url),
);
const fixtureAssertionsPath = fileURLToPath(
  new URL(
    "../../../../fixtures/promptfoo-stub/assertions.yaml",
    import.meta.url,
  ),
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "rightmodeler-promptfoo-test-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function copy(): CapturedFile {
  return structuredClone(captured);
}

function row(file: CapturedFile, testIdx: number): CapturedRow {
  return file.results.results.find((item) => item.testIdx === testIdx)!;
}

function parse(
  value: unknown,
  options: {
    readonly sent?: readonly PromptfooSentCase[];
    readonly scorers?: readonly string[];
  } = {},
): PromptfooParsedRun {
  return parsePromptfooResults({
    text: JSON.stringify(value),
    sent: options.sent ?? sent,
    scorers: options.scorers ?? scorers,
  });
}

function entry(run: PromptfooParsedRun, caseId: string) {
  return run.cases.find((item) => item.caseId === caseId);
}

function metric(run: PromptfooParsedRun, caseId: string, metricName: string) {
  return entry(run, caseId)?.metrics.find(
    (item) => item.metricName === metricName,
  );
}

describe("parsePromptfooResults on the captured promptfoo 0.123.1 file", () => {
  it("maps rows to cases by testIdx even when promptfoo reorders them", () => {
    const reversed = copy();
    reversed.results.results.reverse();
    expect(reversed.results.results[0]?.testIdx).toBe(4);

    const parsed = parse(reversed);

    expect(parsed.cases.map(({ caseId }) => caseId)).toEqual([
      "case-1",
      "case-2",
      "case-3",
      "case-4",
      "case-5",
    ]);
    expect(parsed.cases).toEqual(parse(captured).cases);
  });

  it("keeps an assertion failure as a graded failure although promptfoo sets error on it", () => {
    expect(row(captured, 1)).toMatchObject({
      failureReason: 1,
      error: expect.any(String),
    });

    const parsed = entry(parse(captured), "case-2");

    expect(parsed?.absentReason).toBeUndefined();
    expect(parsed?.metrics).toEqual([
      expect.objectContaining({
        metricName: "output_similarity",
        score: 0,
        passed: false,
      }),
      expect.objectContaining({
        metricName: "secondary_similarity",
        score: 1,
        passed: true,
      }),
    ]);
  });

  it("passes a metric only when every assertion carrying it passes", () => {
    expect(metric(parse(captured), "case-1", "output_similarity")?.passed).toBe(
      true,
    );
    const failing = copy();
    const components = row(failing, 0).gradingResult!.componentResults!;
    const carrying = components.find(
      ({ assertion }) => assertion?.metric === "output_similarity",
    )!;
    components.push({ ...structuredClone(carrying), pass: false });

    expect(metric(parse(failing), "case-1", "output_similarity")?.passed).toBe(
      false,
    );
  });

  it("derives the rubric version from the promptfoo version and the assertions carrying the metric", () => {
    const base = parse(captured);
    const output = metric(base, "case-1", "output_similarity")!.rubricVersion;
    const secondary = metric(
      base,
      "case-1",
      "secondary_similarity",
    )!.rubricVersion;
    expect(output).toMatch(
      /^promptfoo@0\.123\.1\/output_similarity\/[0-9a-f]{16}$/u,
    );
    expect(metric(base, "case-2", "output_similarity")!.rubricVersion).toBe(
      output,
    );
    expect(secondary).toMatch(
      /^promptfoo@0\.123\.1\/secondary_similarity\/[0-9a-f]{16}$/u,
    );
    expect(secondary).not.toBe(output);

    const edited = copy();
    for (const item of edited.results.results) {
      for (const component of item.gradingResult?.componentResults ?? []) {
        if (component.assertion?.type === "equals") {
          component.assertion.value = "Lyon";
        }
      }
    }
    const editedRun = parse(edited);
    expect(
      metric(editedRun, "case-1", "output_similarity")!.rubricVersion,
    ).not.toBe(output);
    expect(
      metric(editedRun, "case-1", "secondary_similarity")!.rubricVersion,
    ).toBe(secondary);

    const declared = copy();
    for (const item of declared.results.results) {
      for (const component of item.gradingResult?.componentResults ?? []) {
        component.metadata = { rubricVersion: "declared" };
      }
    }
    const declaredRun = parse(declared);
    expect(
      metric(declaredRun, "case-1", "output_similarity")!.rubricVersion,
    ).toBe(output);
    expect(
      metric(declaredRun, "case-1", "secondary_similarity")!.rubricVersion,
    ).toBe(secondary);

    const upgraded = copy();
    upgraded.metadata.promptfooVersion = "0.124.0";
    const upgradedRun = parse(upgraded);
    expect(
      metric(upgradedRun, "case-1", "output_similarity")!.rubricVersion,
    ).toBe(output!.replace("promptfoo@0.123.1/", "promptfoo@0.124.0/"));
    expect(
      metric(upgradedRun, "case-1", "secondary_similarity")!.rubricVersion,
    ).toBe(secondary!.replace("promptfoo@0.123.1/", "promptfoo@0.124.0/"));
  });

  it("rejects any other layout with one error naming the promptfoo version and the layout expected", () => {
    const docsLayout = {
      ...copy(),
      metadata: { ...captured.metadata, promptfooVersion: "0.200.0" },
      results: { outputs: captured.results.results },
    };
    expect(() => parse(docsLayout)).toThrow(/promptfoo 0\.200\.0/u);
    expect(() => parse(docsLayout)).toThrow(/results\.version 3/u);

    const version2 = copy();
    version2.results.version = 2;
    expect(() => parse(version2)).toThrow(/results\.version 3/u);

    expect(() => parsePromptfooResults({ text: "{", sent, scorers })).toThrow(
      /version not stated/u,
    );
  });

  it("names an error row external_evaluator_error for its own case only and records rows without named scores as absent", () => {
    const base = parse(captured);
    expect(entry(base, "case-5")).toEqual({
      caseId: "case-5",
      testIdx: 4,
      metrics: [],
      absentReason: "external_evaluator_error",
    });

    const withoutError = copy();
    withoutError.results.results = withoutError.results.results.filter(
      ({ testIdx }) => testIdx !== 4,
    );
    expect(parse(withoutError, { sent: sent.slice(0, 4) }).cases).toEqual(
      base.cases.slice(0, 4),
    );

    const firstErrored = copy();
    row(firstErrored, 0).failureReason = 2;
    const firstErroredRun = parse(firstErrored);
    expect(entry(firstErroredRun, "case-1")).toEqual({
      caseId: "case-1",
      testIdx: 0,
      metrics: [],
      absentReason: "external_evaluator_error",
    });
    expect(firstErroredRun.cases.slice(1)).toEqual(base.cases.slice(1));

    const ungraded = copy();
    row(ungraded, 0).gradingResult = null;
    expect(entry(parse(ungraded), "case-1")).toBeUndefined();

    const noAssertions = copy();
    row(noAssertions, 0).gradingResult = {
      pass: true,
      score: 1,
      reason: "No assertions",
    };
    expect(entry(parse(noAssertions), "case-1")).toBeUndefined();
  });

  it("never falls back to the row score for a metric no assertion carries", () => {
    const stripped = copy();
    const first = row(stripped, 0);
    delete first.namedScores!.output_similarity;
    delete first.gradingResult!.namedScores!.output_similarity;
    first.gradingResult!.componentResults =
      first.gradingResult!.componentResults!.filter(
        ({ assertion }) => assertion?.metric !== "output_similarity",
      );
    expect(
      entry(parse(stripped, { scorers: ["output_similarity"] }), "case-1"),
    ).toEqual({ caseId: "case-1", testIdx: 0, metrics: [] });

    const withoutComponent = copy();
    const second = row(withoutComponent, 1);
    second.gradingResult!.componentResults =
      second.gradingResult!.componentResults!.filter(
        ({ assertion }) => assertion?.metric !== "output_similarity",
      );
    expect(
      entry(parse(withoutComponent), "case-2")?.metrics.map(
        ({ metricName }) => metricName,
      ),
    ).toEqual(["secondary_similarity"]);
  });

  it("names an output promptfoo graded in rewritten form and allows the one trailing newline it strips", () => {
    const base = parse(captured);
    expect(entry(base, "case-4")).toEqual({
      caseId: "case-4",
      testIdx: 3,
      metrics: [],
      absentReason: "external_output_mismatch",
    });
    expect(entry(base, "case-3")?.absentReason).toBeUndefined();
    expect(
      entry(base, "case-3")?.metrics.map(({ metricName, passed }) => [
        metricName,
        passed,
      ]),
    ).toEqual([
      ["output_similarity", true],
      ["secondary_similarity", true],
    ]);

    const twoNewlines = sent.map((item) =>
      item.caseId === "case-3" ? { ...item, output: "Paris\n\n" } : item,
    );
    expect(entry(parse(captured, { sent: twoNewlines }), "case-3")).toEqual({
      caseId: "case-3",
      testIdx: 2,
      metrics: [],
      absentReason: "external_output_mismatch",
    });
  });

  it("throws when rows do not correspond one to one with the outputs sent", () => {
    const retagged = copy();
    row(retagged, 0).vars.tags = "case-9";
    expect(() => parse(retagged)).toThrow(/one to one/u);

    const duplicated = copy();
    duplicated.results.results.push(structuredClone(row(duplicated, 0)));
    expect(() => parse(duplicated)).toThrow(/one to one/u);

    expect(() => parse(captured, { sent: sent.slice(0, 4) })).toThrow(
      /one to one/u,
    );
  });

  it("names a scorer that no graded case carries", () => {
    expect(() =>
      parse(captured, { scorers: ["output_similarity", "missing_metric"] }),
    ).toThrow(/missing_metric/u);
  });

  it("leaves out a metric whose grader failed and names the case external_evaluator_error", () => {
    const base = parse(captured);
    const graderFailed = copy();
    const first = row(graderFailed, 0);
    first.failureReason = 1;
    for (const component of first.gradingResult!.componentResults!) {
      if (component.assertion?.metric === "output_similarity") {
        Object.assign(component, {
          pass: false,
          score: 0,
          metadata: { graderError: true },
        });
      }
    }
    first.gradingResult!.namedScores!.output_similarity = 0;

    const run = parse(graderFailed);

    expect(entry(run, "case-1")).toEqual({
      caseId: "case-1",
      testIdx: 0,
      metrics: [metric(base, "case-1", "secondary_similarity")],
      absentReason: "external_evaluator_error",
    });
    expect(run.cases.slice(1)).toEqual(base.cases.slice(1));
  });
});

function projectRow(item: CapturedRow) {
  return {
    testIdx: item.testIdx,
    promptIdx: item.promptIdx,
    success: item.success,
    score: item.score,
    failureReason: item.failureReason,
    error: item.error,
    namedScores: item.namedScores,
    vars: item.vars,
    output: item.response?.output,
    grading: {
      pass: item.gradingResult?.pass,
      score: item.gradingResult?.score,
      reason: item.gradingResult?.reason,
      namedScores: item.gradingResult?.namedScores,
      components: item.gradingResult?.componentResults?.map(
        ({ pass, score, reason, assertion }) => ({
          pass,
          score,
          reason,
          assertion,
        }),
      ),
    },
  };
}

describe("promptfoo stub parity", () => {
  it("writes the captured file's shape", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "model-outputs.json"),
      JSON.stringify(modelOutputs.slice(0, 3)),
    );

    const result = spawnSync(
      process.execPath,
      [
        stubPath,
        "eval",
        "--assertions",
        fixtureAssertionsPath,
        "--model-outputs",
        "model-outputs.json",
        "--output",
        join(directory, "results.json"),
        "--no-write",
        "--no-share",
        "--no-table",
        "--no-progress-bar",
      ],
      { cwd: directory, encoding: "utf8" },
    );

    expect(result.status).toBe(100);
    const written = JSON.parse(
      await readFile(join(directory, "results.json"), "utf8"),
    ) as CapturedFile;
    expect(
      [...written.results.results]
        .sort((left, right) => left.testIdx - right.testIdx)
        .map(projectRow),
    ).toEqual([0, 1, 2].map((testIdx) => projectRow(row(captured, testIdx))));
    expect(Object.keys(written).sort()).toEqual(Object.keys(captured).sort());
    expect(Object.keys(written.results).sort()).toEqual(
      Object.keys(captured.results).sort(),
    );
  });
});

async function assertionsCopy(): Promise<string> {
  const assertionsPath = join(await temporaryDirectory(), "assertions.yaml");
  await copyFile(fixtureAssertionsPath, assertionsPath);
  return assertionsPath;
}

function stubEvaluator(assertionsPath: string, command = stubPath) {
  return createPromptfooEvaluator({
    command,
    assertionsPath,
    scorers: ["output_similarity"],
  });
}

function launchInput(...outputs: string[]) {
  return {
    experimentName: "invocation",
    cases: outputs.map((output, index) => ({
      caseId: `execution-${index + 1}`,
      input: { prompt: "capital" },
      expected: "Paris",
      output,
    })),
  };
}

describe("promptfoo invocation", () => {
  it("runs in the assertions directory with a relative model-outputs path and the pinned flags and environment", async () => {
    const assertionsPath = await assertionsCopy();
    const recordPath = join(await temporaryDirectory(), "record.json");
    vi.stubEnv("PROMPTFOO_STUB_RECORD", recordPath);
    vi.stubEnv("PROMPTFOO_STRIP_TEST_VARS", "true");
    vi.stubEnv("PROMPTFOO_DISABLE_VAR_EXPANSION", "false");
    vi.stubEnv("PROMPTFOO_DISABLE_TELEMETRY", "false");

    await stubEvaluator(assertionsPath).launch(launchInput("Paris", "Parish"));

    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    expect(record.argv).toEqual([
      "eval",
      "--assertions",
      assertionsPath,
      "--model-outputs",
      record.argv[4],
      "--output",
      record.argv[6],
      "--no-write",
      "--no-share",
      "--no-table",
      "--no-progress-bar",
    ]);
    expect(isAbsolute(record.argv[4]!)).toBe(false);
    expect(resolve(record.cwd, record.argv[4]!)).toMatch(
      /model-outputs\.json$/u,
    );
    expect(record.cwd).toBe(await realpath(dirname(assertionsPath)));
    expect(record.env).toMatchObject({
      PROMPTFOO_DISABLE_TELEMETRY: "false",
      PROMPTFOO_DISABLE_UPDATE: "true",
      PROMPTFOO_DISABLE_VAR_EXPANSION: "true",
      PROMPTFOO_FAILED_TEST_EXIT_CODE: "100",
      PROMPTFOO_SHORT_CIRCUIT_TEST_FAILURES: "false",
      PROMPTFOO_STRIP_GRADING_RESULT: "false",
      PROMPTFOO_STRIP_RESPONSE_OUTPUT: "false",
      PROMPTFOO_STRIP_TEST_VARS: "false",
    });
  });

  it("accepts exit 100 when the caller's own promptfoo settings would change the exit code", async () => {
    vi.stubEnv("PROMPTFOO_FAILED_TEST_EXIT_CODE", "1");
    const provider = stubEvaluator(await assertionsCopy());

    const { providerRunId } = await provider.launch(
      launchInput("Paris", "Parish"),
    );

    expect(await provider.status(providerRunId)).toBe("complete");
    const results = await provider.collect(providerRunId);
    expect(
      results.find(({ caseId }) => caseId === "execution-2")?.metrics,
    ).toEqual([
      expect.objectContaining({
        metricName: "output_similarity",
        passed: false,
      }),
    ]);
  });

  it("fails with promptfoo's output when it exits 1 or writes no results file", async () => {
    const provider = stubEvaluator(await assertionsCopy());

    vi.stubEnv("PROMPTFOO_STUB_FAULT", "exit-1");
    await expect(provider.launch(launchInput("Paris"))).rejects.toThrow(
      /exited 1: stub fault\nstub trace$/u,
    );

    vi.stubEnv("PROMPTFOO_STUB_FAULT", "no-results");
    await expect(provider.launch(launchInput("Paris"))).rejects.toThrow(
      /without writing its results file/u,
    );
  });

  it("closes standard input so promptfoo cannot wait on a prompt", async () => {
    vi.stubEnv("PROMPTFOO_STUB_FAULT", "read-stdin");
    const provider = stubEvaluator(await assertionsCopy());

    await expect(provider.launch(launchInput("Paris"))).resolves.toEqual({
      providerRunId: expect.any(String),
    });
  }, 10_000);

  it("returns an output promptfoo rewrote as external_output_mismatch", async () => {
    vi.stubEnv("PROMPTFOO_STUB_FAULT", "rewrite-output");
    const provider = stubEvaluator(await assertionsCopy());

    const { providerRunId } = await provider.launch(
      launchInput("Paris", "Parish"),
    );

    expect(await provider.status(providerRunId)).toBe("complete");
    const results = await provider.collect(providerRunId);
    expect(results).toEqual([
      expect.objectContaining({
        caseId: "execution-1",
        metrics: [],
        absentReason: "external_output_mismatch",
      }),
      expect.objectContaining({
        caseId: "execution-2",
        metrics: [],
        absentReason: "external_output_mismatch",
      }),
    ]);
  });

  it("names an error row external_evaluator_error for its own case and keeps the batch complete", async () => {
    const provider = stubEvaluator(await assertionsCopy());

    const { providerRunId } = await provider.launch(
      launchInput("Paris", "Parish", "file://rightmodeler-missing.txt"),
    );

    expect(await provider.status(providerRunId)).toBe("complete");
    const results = await provider.collect(providerRunId);
    expect(results.map(({ caseId }) => caseId)).toEqual([
      "execution-1",
      "execution-2",
      "execution-3",
    ]);
    expect(results[0]).not.toHaveProperty("absentReason");
    expect(results[0]?.metrics).toEqual([
      expect.objectContaining({
        metricName: "output_similarity",
        passed: true,
      }),
    ]);
    expect(results[1]).not.toHaveProperty("absentReason");
    expect(results[1]?.metrics).toEqual([
      expect.objectContaining({
        metricName: "output_similarity",
        passed: false,
      }),
    ]);
    expect(results[2]).toMatchObject({
      metrics: [],
      absentReason: "external_evaluator_error",
    });
  });

  it("treats a missing executable as unreachable and any runnable one as reachable", async () => {
    const assertionsPath = await assertionsCopy();

    expect(
      await stubEvaluator(
        assertionsPath,
        join(tmpdir(), "rightmodeler-missing-promptfoo"),
      ).detectAvailability(),
    ).toBe(false);
    expect(await stubEvaluator(assertionsPath).detectAvailability()).toBe(true);
    expect(
      await stubEvaluator(
        assertionsPath,
        process.execPath,
      ).detectAvailability(),
    ).toBe(true);
    expect(
      await stubEvaluator(
        join(tmpdir(), "rightmodeler-missing-assertions", "assertions.yaml"),
      ).detectAvailability(),
    ).toBe(true);
  });
});
