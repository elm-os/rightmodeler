import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsStore, readLedger, type Assessment } from "@rightmodeler/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  runPipeline,
  runResultExport,
  type PipelineOptions,
} from "./pipeline.js";
import { Reporter } from "./protocol.js";
import { readSetupState, writeCheckpoint } from "./state.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

type EvaluatorConfig = NonNullable<PipelineOptions["evaluator"]>;

const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const traceFixturePath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const promptfooCommandPath = fileURLToPath(
  new URL("../../../fixtures/promptfoo-stub/run.mjs", import.meta.url),
);
const promptfooAssertionsPath = fileURLToPath(
  new URL("../../../fixtures/promptfoo-stub/assertions.yaml", import.meta.url),
);
const stubProviderUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const evalStubUrl = new URL(
  "../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const langfuseStubUrl = new URL(
  "../../../fixtures/langfuse-eval-stub/server.mjs",
  import.meta.url,
).href;
const langsmithStubUrl = new URL(
  "../../../fixtures/langsmith-eval-stub/server.mjs",
  import.meta.url,
).href;

const API_KEY = "RIGHTMODELER_REGRADE_TEST_API_KEY";
const EVALUATOR_KEY = "RIGHTMODELER_REGRADE_TEST_EVALUATOR_KEY";
const PUBLIC_KEY_A = "RIGHTMODELER_REGRADE_TEST_PUBLIC_KEY_A";
const PUBLIC_KEY_B = "RIGHTMODELER_REGRADE_TEST_PUBLIC_KEY_B";
const REGRADE_WARNING =
  /^Re-grading (\d+) (shortlist|holdout) candidate outputs with ([a-z]+): (\d+) were graded under a different evaluator configuration /u;

interface Stub {
  readonly port: number;
  close(): Promise<void>;
}

interface ProviderStub extends Stub {
  getHitCount(): number;
}

interface EvalStub extends Stub {
  getExperimentEvents(): readonly {
    readonly metadata: {
      readonly kind?: string;
      readonly assessments?: readonly {
        readonly evaluatorId: string;
        readonly evaluatorIdentity?: string;
      }[];
    };
  }[];
}

interface Workspace {
  readonly root: string;
  readonly repo: string;
  readonly store: string;
  readonly traces: string;
  readonly rubric: string;
}

interface RegradeKind {
  readonly evaluatorId: string;
  readonly change: string;
  configs(workspace: Workspace): {
    readonly before: EvaluatorConfig;
    after(): Promise<EvaluatorConfig>;
  };
}

const temporaryDirectories: string[] = [];
let providerStub: ProviderStub;
let evalStub: EvalStub;
let langfuseStub: Stub;
let langsmithStub: Stub;

function promptfooConfig(workspace: Workspace): EvaluatorConfig {
  return {
    provider: "promptfoo",
    command: promptfooCommandPath,
    assertionsPath: join(workspace.rubric, "assertions.yaml"),
    scorers: ["output_similarity"],
  };
}

function braintrustConfig(projectId: string): EvaluatorConfig {
  return {
    provider: "braintrust",
    apiKeyEnv: EVALUATOR_KEY,
    baseUrl: `http://127.0.0.1:${evalStub.port}`,
    projectId,
    scorers: ["output_similarity"],
    gateThreshold: 0.8,
  };
}

async function editAssertions(workspace: Workspace): Promise<void> {
  const path = join(workspace.rubric, "assertions.yaml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace("value: Paris", "value: Lyon"),
  );
}

const kinds: readonly RegradeKind[] = [
  {
    evaluatorId: "promptfoo",
    change: "its assertions file is edited",
    configs: (workspace) => ({
      before: promptfooConfig(workspace),
      after: async () => {
        await editAssertions(workspace);
        return promptfooConfig(workspace);
      },
    }),
  },
  {
    evaluatorId: "promptfoo",
    change: "a promptfooconfig appears beside its assertions file",
    configs: (workspace) => ({
      before: promptfooConfig(workspace),
      after: async () => {
        await writeFile(
          join(workspace.rubric, "promptfooconfig.yaml"),
          "description: regrade\n",
        );
        return promptfooConfig(workspace);
      },
    }),
  },
  {
    evaluatorId: "braintrust",
    change: "its project changes",
    configs: () => ({
      before: braintrustConfig("00000000-0000-4000-8000-000000000001"),
      after: async () =>
        braintrustConfig("00000000-0000-4000-8000-000000000002"),
    }),
  },
  {
    evaluatorId: "langfuse",
    change: "its key pair changes",
    configs: () => {
      const config = (publicKeyEnv: string): EvaluatorConfig => ({
        provider: "langfuse",
        baseUrl: `http://127.0.0.1:${langfuseStub.port}`,
        publicKeyEnv,
        apiKeyEnv: EVALUATOR_KEY,
        scorers: ["output_similarity"],
      });
      return {
        before: config(PUBLIC_KEY_A),
        after: async () => config(PUBLIC_KEY_B),
      };
    },
  },
  {
    evaluatorId: "langsmith",
    change: "its dataset changes",
    configs: () => {
      const config = (datasetId: string): EvaluatorConfig => ({
        provider: "langsmith",
        baseUrl: `http://127.0.0.1:${langsmithStub.port}`,
        apiKeyEnv: EVALUATOR_KEY,
        datasetId,
        scorers: ["output_similarity"],
      });
      return {
        before: config("langsmith-dataset-1"),
        after: async () => config("langsmith-dataset-2"),
      };
    },
  },
];

async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-regrade-"));
  temporaryDirectories.push(root);
  const repo = await makeGitFixture(root, demoAppPath, "demo-app");
  const traces = join(root, "traces.json");
  await writeFile(traces, await readFile(traceFixturePath));
  const rubric = join(root, "rubric");
  await mkdir(rubric);
  await copyFile(promptfooAssertionsPath, join(rubric, "assertions.yaml"));
  return { root, repo, store: join(root, "store"), traces, rubric };
}

async function run(
  workspace: Workspace,
  evaluator: EvaluatorConfig,
  store = workspace.store,
  through: PipelineOptions["through"] = "aggregate",
) {
  const lines: string[] = [];
  const result = await runPipeline({
    repo: workspace.repo,
    store,
    traces: workspace.traces,
    baseUrl: `http://127.0.0.1:${providerStub.port}/v1`,
    apiKeyEnv: API_KEY,
    evaluator,
    through,
    reporter: new Reporter("json", {
      stdout: () => undefined,
      stderr: (text) => lines.push(text),
    }),
  });
  const warnings = lines
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(({ event }) => event === "warning")
    .map((warning) => warning as { code: string; message: string });
  return {
    result,
    warnings,
    regrades: warnings.filter(({ code }) => code === "evaluator_regrade"),
  };
}

async function gateGrades(
  store: string,
  evaluatorId: string,
): Promise<Assessment[]> {
  return (await readLedger(new FsStore(store), "project")).assessments.filter(
    (assessment) =>
      assessment.evaluatorId === evaluatorId &&
      assessment.metricName === "output_similarity",
  );
}

function providerRunId(grade: Assessment): string {
  return (grade.artifactRef as { providerRunId: string }).providerRunId;
}

function projectedVerdicts(
  verdicts: Awaited<ReturnType<typeof runPipeline>>["verdicts"],
) {
  return verdicts
    .map(({ familyId, candidateId, corpusSplit, evaluatorKinds }) =>
      JSON.stringify({
        familyId,
        candidateId,
        corpusSplit,
        evaluatorKinds: evaluatorKinds.map(
          ({ evaluatorKind, passes, trials }) => ({
            evaluatorKind,
            passes,
            trials,
          }),
        ),
      }),
    )
    .sort();
}

async function replayEvaluation(store: string) {
  const fsStore = new FsStore(store);
  const { stages } = await readSetupState(fsStore, "project");
  const entry = await fsStore.get(stages.replay!.outputKey);
  return (
    JSON.parse(Buffer.from(entry!.body).toString("utf8")) as {
      evaluation: {
        evaluatorIdentity?: string;
        assessmentAbsences: readonly unknown[];
      };
    }
  ).evaluation;
}

function regradeCounts(regrades: readonly { message: string }[]): number {
  return regrades.reduce(
    (total, { message }) =>
      total + Number(/^Re-grading (\d+) /u.exec(message)?.[1] ?? Number.NaN),
    0,
  );
}

describe("evaluator re-grading", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    providerStub = await (
      (await import(stubProviderUrl)) as {
        startStubProvider(input: { port: number }): Promise<ProviderStub>;
      }
    ).startStubProvider({ port: 0 });
    evalStub = await (
      (await import(evalStubUrl)) as {
        startEvalStub(input: {
          port: number;
          pendingPolls: number;
          platformPassDecisions: boolean;
        }): Promise<EvalStub>;
      }
    ).startEvalStub({ port: 0, pendingPolls: 1, platformPassDecisions: false });
    langfuseStub = await (
      (await import(langfuseStubUrl)) as {
        startLangfuseEvalStub(input: {
          port: number;
          pendingPolls: number;
        }): Promise<Stub>;
      }
    ).startLangfuseEvalStub({ port: 0, pendingPolls: 1 });
    langsmithStub = await (
      (await import(langsmithStubUrl)) as {
        startLangsmithEvalStub(input: {
          port: number;
          pendingPolls: number;
        }): Promise<Stub>;
      }
    ).startLangsmithEvalStub({ port: 0, pendingPolls: 1 });
    process.env[API_KEY] = "fixture-key";
    process.env[EVALUATOR_KEY] = "regrade-evaluator-key";
    process.env[PUBLIC_KEY_A] = "regrade-public-key";
    process.env[PUBLIC_KEY_B] = "regrade-public-key";
  });

  afterAll(async () => {
    for (const name of [API_KEY, EVALUATOR_KEY, PUBLIC_KEY_A, PUBLIC_KEY_B]) {
      delete process.env[name];
    }
    await Promise.all(
      [providerStub, evalStub, langfuseStub, langsmithStub].map((stub) =>
        stub.close(),
      ),
    );
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it.each(kinds)(
    "re-grades $evaluatorId candidate outputs without a model call when $change",
    async (kind) => {
      const work = await workspace();
      const { before, after } = kind.configs(work);

      const firstRun = await run(work, before);
      const chat = providerStub.getHitCount();
      const first = await gateGrades(work.store, kind.evaluatorId);
      expect(first.length).toBeGreaterThan(0);
      const firstRunIds = new Set(first.map(providerRunId));
      // A1
      for (const grade of first) {
        expect(grade.evaluatorIdentity).toMatch(/^[0-9a-f]{64}$/u);
      }
      const identities = new Set(first.map((grade) => grade.evaluatorIdentity));
      expect(identities.size).toBe(1);
      const identityBefore = [...identities][0]!;
      // A2
      expect(
        firstRun.result.verdicts.some((verdict) =>
          verdict.evaluatorKinds.some(
            ({ evaluatorKind, trials }) =>
              evaluatorKind === kind.evaluatorId && trials > 0,
          ),
        ),
      ).toBe(true);

      const unchanged = await run(work, before);
      // A3
      expect(unchanged.result.executedStages).toEqual([]);
      expect(providerStub.getHitCount()).toBe(chat);
      expect(await gateGrades(work.store, kind.evaluatorId)).toEqual(first);
      expect(unchanged.regrades).toEqual([]);

      const changed = await run(work, await after());
      // A4
      expect(changed.result.executedStages).toEqual(["replay", "aggregate"]);
      // A5
      expect(providerStub.getHitCount()).toBe(chat);
      // A6
      const regraded = await gateGrades(work.store, kind.evaluatorId);
      expect(regraded).toHaveLength(2 * first.length);
      const regradedIds = new Set(regraded.map((grade) => grade.assessmentId));
      for (const grade of first) {
        expect(regradedIds.has(grade.assessmentId)).toBe(true);
      }
      const firstIds = new Set(first.map((grade) => grade.assessmentId));
      const added = regraded.filter(
        (grade) => !firstIds.has(grade.assessmentId),
      );
      const addedIdentities = new Set(
        added.map((grade) => grade.evaluatorIdentity),
      );
      expect(addedIdentities.size).toBe(1);
      const identityAfter = [...addedIdentities][0]!;
      expect(identityAfter).toMatch(/^[0-9a-f]{64}$/u);
      expect(identityAfter).not.toBe(identityBefore);
      for (const grade of first) {
        expect(
          added.filter(
            (candidate) => candidate.executionId === grade.executionId,
          ),
        ).toHaveLength(1);
      }
      // A7
      for (const grade of added) {
        expect(firstRunIds.has(providerRunId(grade))).toBe(false);
      }
      // A8
      expect(changed.regrades.length).toBeGreaterThan(0);
      for (const { message } of changed.regrades) {
        const match = REGRADE_WARNING.exec(message);
        expect(match, message).not.toBeNull();
        expect(match![3]).toBe(kind.evaluatorId);
        expect(message).toContain("no model call is repeated");
        expect(message).not.toContain("before rightmodeler recorded");
      }
      expect(regradeCounts(changed.regrades)).toBe(first.length);
      // A9
      expect((await replayEvaluation(work.store)).evaluatorIdentity).toBe(
        identityAfter,
      );
      // A10
      expect(projectedVerdicts(changed.result.verdicts)).toEqual(
        projectedVerdicts(firstRun.result.verdicts),
      );

      const again = await run(work, await after());
      // A11
      expect(again.result.executedStages).toEqual([]);
      expect(await gateGrades(work.store, kind.evaluatorId)).toHaveLength(
        regraded.length,
      );
    },
  );

  it("re-grades grades recorded before evaluator tracking once and says so", async () => {
    const work = await workspace();
    const config = promptfooConfig(work);
    await run(work, config);
    const chat = providerStub.getHitCount();
    const first = await gateGrades(work.store, "promptfoo");
    expect(first.length).toBeGreaterThan(0);

    const a = new FsStore(work.store);
    const storeB = join(work.root, "store-b");
    const b = new FsStore(storeB);
    for (const key of await a.list("")) {
      const entry = (await a.get(key))!;
      let bytes: Uint8Array = entry.body;
      try {
        const value = JSON.parse(Buffer.from(entry.body).toString("utf8")) as
          Record<string, unknown> | undefined;
        if (
          typeof value === "object" &&
          value !== null &&
          "assessmentId" in value &&
          value.evaluatorId === "promptfoo"
        ) {
          delete value.evaluatorIdentity;
          bytes = Buffer.from(JSON.stringify(value), "utf8");
        }
      } catch {
        // Not a JSON entry; copied as it is.
      }
      expect(await b.compareAndSwap(key, 0, bytes, entry.fenceToken)).toBe(
        true,
      );
    }
    const { stages } = await readSetupState(b, "project");
    for (const stage of ["replay", "aggregate"] as const) {
      await writeCheckpoint(b, "project", stage, {
        ...stages[stage]!,
        inputDigest: `pre-evaluator-identity-${stage}`,
      });
    }

    const legacy = await run(work, config, storeB);
    // L1
    expect(legacy.result.executedStages).toEqual(["replay", "aggregate"]);
    expect(providerStub.getHitCount()).toBe(chat);
    // L2
    expect(regradeCounts(legacy.regrades)).toBe(first.length);
    for (const { message } of legacy.regrades) {
      expect(message).toContain(
        "were graded before rightmodeler recorded evaluator configurations",
      );
      expect(message).not.toContain(
        "under a different evaluator configuration",
      );
    }
    // L3
    const grades = await gateGrades(storeB, "promptfoo");
    expect(
      grades.filter((grade) => grade.evaluatorIdentity === undefined),
    ).toHaveLength(first.length);
    expect(
      grades.filter((grade) => grade.evaluatorIdentity !== undefined),
    ).toHaveLength(first.length);
  });

  it("exports only the current grade of a re-graded output", async () => {
    const work = await workspace();
    const { before, after } = kinds
      .find(({ evaluatorId }) => evaluatorId === "braintrust")!
      .configs(work);
    await run(work, before);
    const first = await gateGrades(work.store, "braintrust");
    expect(first.length).toBeGreaterThan(0);
    await run(work, await after());
    const identityAfter = (await replayEvaluation(work.store))
      .evaluatorIdentity;
    expect(identityAfter).toMatch(/^[0-9a-f]{64}$/u);

    await runResultExport({
      repo: work.repo,
      store: work.store,
      config: {
        provider: "braintrust",
        baseUrl: `http://127.0.0.1:${evalStub.port}`,
        apiKeyEnv: EVALUATOR_KEY,
        projectId: "00000000-0000-4000-8000-000000000001",
      },
    });

    // X1
    const trials = evalStub
      .getExperimentEvents()
      .filter(({ metadata }) => metadata.kind === "rightmodeler_trial");
    expect(trials.length).toBeGreaterThan(0);
    const exported = trials.map(({ metadata }) =>
      (metadata.assessments ?? []).filter(
        ({ evaluatorId }) => evaluatorId === "braintrust",
      ),
    );
    for (const entries of exported) {
      expect(entries.length).toBeLessThanOrEqual(1);
      for (const entry of entries) {
        expect(entry.evaluatorIdentity).toBe(identityAfter);
      }
    }
    expect(exported.filter((entries) => entries.length === 1)).toHaveLength(
      first.length,
    );
  });

  it("grades only outputs of the current evidence question", async () => {
    const work = await workspace();
    const config = promptfooConfig(work);
    await run(work, config);
    const firstExecutions = new Set(
      (await readLedger(new FsStore(work.store), "project")).executions.map(
        ({ executionId }) => executionId,
      ),
    );
    const firstGrades = new Set(
      (await gateGrades(work.store, "promptfoo")).map(
        ({ assessmentId }) => assessmentId,
      ),
    );

    const widened = await run(work, {
      ...config,
      scorers: ["output_similarity", "secondary_similarity"],
      gateMetric: "output_similarity",
    });
    // Q1
    expect(widened.result.executedStages).toContain("shortlist");
    expect(widened.result.executedStages).toContain("replay");
    expect(widened.regrades).toEqual([]);
    // Q2
    const created = (
      await readLedger(new FsStore(work.store), "project")
    ).executions.filter(({ executionId }) => !firstExecutions.has(executionId));
    const createdIds = new Set(created.map(({ executionId }) => executionId));
    const added = (await gateGrades(work.store, "promptfoo")).filter(
      ({ assessmentId }) => !firstGrades.has(assessmentId),
    );
    for (const grade of added) {
      expect(createdIds.has(grade.executionId)).toBe(true);
    }
    expect(added).toHaveLength(created.length);
  });

  it("returns to an earlier evaluator configuration without re-grading", async () => {
    const work = await workspace();
    const config = promptfooConfig(work);
    const assertions = join(work.rubric, "assertions.yaml");
    const original = await readFile(assertions);
    const firstRun = await run(work, config);
    const chat = providerStub.getHitCount();
    const first = await gateGrades(work.store, "promptfoo");
    const identityBefore = first[0]?.evaluatorIdentity;
    expect(identityBefore).toMatch(/^[0-9a-f]{64}$/u);

    await editAssertions(work);
    await run(work, config);
    await writeFile(assertions, original);
    const reverted = await run(work, config);

    // R1
    expect(reverted.result.executedStages).toEqual(["replay", "aggregate"]);
    expect(providerStub.getHitCount()).toBe(chat);
    // R2
    expect(reverted.regrades).toEqual([]);
    expect(await gateGrades(work.store, "promptfoo")).toHaveLength(
      2 * first.length,
    );
    // R3
    expect((await replayEvaluation(work.store)).evaluatorIdentity).toBe(
      identityBefore,
    );
    expect(projectedVerdicts(reverted.result.verdicts)).toEqual(
      projectedVerdicts(firstRun.result.verdicts),
    );
  });

  it("returns to an earlier evaluator configuration whose grading left outputs absent", async () => {
    const work = await workspace();
    const config = promptfooConfig(work);
    const assertions = join(work.rubric, "assertions.yaml");
    const original = await readFile(assertions);
    vi.stubEnv("PROMPTFOO_STUB_FAULT", "rewrite-output");
    try {
      await run(work, config, work.store, "confirm");
    } finally {
      vi.unstubAllEnvs();
    }
    const chat = providerStub.getHitCount();
    const absent = await replayEvaluation(work.store);
    expect(absent.assessmentAbsences.length).toBeGreaterThan(0);
    expect(await gateGrades(work.store, "promptfoo")).toEqual([]);

    await editAssertions(work);
    await run(work, config, work.store, "confirm");
    await writeFile(assertions, original);
    const reverted = await run(work, config, work.store, "confirm");

    expect(reverted.result.executedStages).toEqual([
      "replay",
      "aggregate",
      "confirm",
    ]);
    expect(providerStub.getHitCount()).toBe(chat);
    const evaluation = await replayEvaluation(work.store);
    expect(evaluation.evaluatorIdentity).toBe(absent.evaluatorIdentity);
    expect(evaluation.assessmentAbsences).toEqual([]);
  });
});
