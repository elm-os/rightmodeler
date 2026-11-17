import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FsStore,
  factsPrefix,
  readLedger,
  reportKey,
} from "@rightmodeler/core";
import { afterAll, describe, expect, it } from "vitest";

import { resolveCheckpointedPipelineCorpus } from "./pipeline.js";
import {
  allFileText,
  execFileAsync,
  fixtureCopy,
  fixtureHome,
  initializeFixtureRepository,
  jsonOutput,
  langgraphFixtureCopy,
  lastStderrEvent,
  livePromptfoo,
  promptfooAssertionsPath,
  promptfooCommandPath,
  readStageArtifact,
  regradeAfterAssertionsEdit,
  removeTemporaryDirectories,
  rewriteStageArtifact,
  runCli,
  secret,
  startCatalogDriftStub,
  startStub,
  startUnpricedCatalogStub,
  storeText,
  temporaryDirectories,
  tracesPath,
  warningMessages,
  writeModeBConfig,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

describe("built CLI pipeline", () => {
  it("prices an id-only gateway catalog from a catalog reference", async () => {
    const { root, repo } = await fixtureCopy("catalog-reference");
    const fresh = await fixtureCopy("catalog-reference-missing");
    const plain = await startStub();
    const reference = join(root, "reference.json");
    try {
      await writeFile(
        reference,
        await (await fetch(`http://127.0.0.1:${plain.port}/v1/models`)).text(),
      );
    } finally {
      await plain.close();
    }
    const stub = await startUnpricedCatalogStub([
      "pricing",
      "context_length",
      "top_provider",
      "supported_parameters",
    ]);
    const apiKeyEnv = "RIGHTMODELER_CATALOG_REFERENCE_API_KEY";
    const replay = ["init", "--through", "replay"];
    const args = (command: readonly string[], target: string) => [
      ...command,
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      "--repo",
      target,
    ];
    try {
      const priced = await runCli(
        [
          ...args(replay, repo),
          "--catalog-reference",
          reference,
          "--output",
          "json",
        ],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(priced.code, priced.stderr).toBe(0);
      expect(
        warningMessages(priced.stderr, "catalog_reference_unmatched"),
      ).toEqual([]);
      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      expect(
        facts.filter(
          ({ executionId, caseId }) =>
            typeof executionId === "string" && typeof caseId === "string",
        ).length,
      ).toBeGreaterThan(0);

      const moved = join(root, "reference-moved.json");
      await writeFile(moved, await readFile(reference, "utf8"));
      const rerun = await runCli(
        [
          ...args(replay, repo),
          "--catalog-reference",
          moved,
          "--output",
          "json",
        ],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(rerun.code, rerun.stderr).toBe(0);
      expect(
        (JSON.parse(rerun.stdout) as { executedStages: string[] })
          .executedStages,
      ).toEqual(["replay"]);

      const unpriced = await runCli(
        [...args(replay, fresh.repo), "--output", "jsonl"],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(unpriced.code).toBe(2);
      expect(JSON.parse(unpriced.stderr)).toMatchObject({
        code: "no_priced_candidates",
        remedy: expect.stringContaining("--catalog-reference"),
      });

      const missing = join(root, "missing.json");
      for (const command of [replay, ["estimate"]]) {
        const unreadable = await runCli(
          [
            ...args(command, fresh.repo),
            "--catalog-reference",
            missing,
            "--output",
            "jsonl",
          ],
          { env: { [apiKeyEnv]: secret } },
        );

        expect(unreadable.code, command[0]).toBe(2);
        expect(JSON.parse(unreadable.stderr)).toMatchObject({
          code: "invalid_catalog_reference",
          message: expect.stringContaining(missing),
        });
      }
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("warns and uses the built-in judge when the external evaluator is unreachable", async () => {
    const { repo } = await fixtureCopy("external-evaluator-unreachable");
    const modelStub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "aggregate",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${modelStub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--evaluator",
          "braintrust",
          "--evaluator-base-url",
          "http://127.0.0.1:1",
          "--evaluator-api-key-env",
          "RIGHTMODELER_MISSING_EVALUATOR_KEY",
          "--evaluator-project-id",
          "00000000-0000-4000-8000-000000000001",
          "--evaluator-scorer",
          "output_similarity",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        '"code":"external_evaluator_unreachable"',
      );
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const verdicts = output.verdicts as Array<{
        evaluatorKinds: Array<{ evaluatorKind: string }>;
      }>;
      expect(
        verdicts.flatMap(({ evaluatorKinds }) =>
          evaluatorKinds.map(({ evaluatorKind }) => evaluatorKind),
        ),
      ).toEqual(expect.arrayContaining(["judge"]));

      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      );
      expect(
        facts.some(
          (fact) =>
            typeof fact === "object" &&
            fact !== null &&
            "actor" in fact &&
            fact.actor === "judge",
        ),
      ).toBe(true);
    } finally {
      await modelStub.close();
    }
  }, 60_000);

  it("records promptfoo grades of rewritten output as external_output_mismatch without an Assessment fact", async () => {
    const { repo } = await fixtureCopy("promptfoo-output-mismatch");
    const modelStub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "aggregate",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${modelStub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--evaluator",
          "promptfoo",
          "--evaluator-command",
          promptfooCommandPath,
          "--evaluator-config",
          promptfooAssertionsPath,
          "--evaluator-scorer",
          "output_similarity",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        {
          env: {
            RIGHTMODELER_E2E_API_KEY: secret,
            PROMPTFOO_STUB_FAULT: "rewrite-output",
          },
        },
      );
      expect(result.code, result.stderr).toBe(0);
      const verdicts = jsonOutput(result).verdicts as Array<{
        familyId: string;
        assessmentAbsent: number;
        assessmentAbsentReasons: Array<{ reason: string; count: number }>;
      }>;
      const summarizeVerdicts = verdicts.filter(
        ({ familyId }) => familyId === "summarize",
      );
      expect(summarizeVerdicts.length).toBeGreaterThan(0);
      expect(
        summarizeVerdicts.every(({ assessmentAbsent }) => assessmentAbsent > 0),
      ).toBe(true);
      expect(
        summarizeVerdicts.flatMap(({ assessmentAbsentReasons }) =>
          assessmentAbsentReasons.map(({ reason }) => reason),
        ),
      ).toEqual(expect.arrayContaining(["external_output_mismatch"]));

      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      );
      expect(
        facts.some(
          (fact) =>
            typeof fact === "object" && fact !== null && "assessmentId" in fact,
        ),
      ).toBe(false);
    } finally {
      await modelStub.close();
    }
  }, 60_000);

  it("re-grades promptfoo candidate outputs after an assertions edit without a model call", async () => {
    await regradeAfterAssertionsEdit({
      label: "promptfoo-regrade",
      command: promptfooCommandPath,
      env: () => ({}),
    });
  }, 90_000);

  it.skipIf(livePromptfoo === undefined)(
    "grades replays with the real promptfoo CLI against the stub provider",
    async () => {
      const { root, repo } = await fixtureCopy("promptfoo-live");
      const promptfooConfigDir = join(root, "promptfoo-config");
      const version = (
        await execFileAsync(livePromptfoo!, ["--version"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PROMPTFOO_CONFIG_DIR: promptfooConfigDir,
            PROMPTFOO_DISABLE_UPDATE: "true",
          },
        })
      ).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1)!;
      const modelStub = await startStub();
      try {
        const result = await runCli(
          [
            "init",
            "--through",
            "aggregate",
            "--traces",
            tracesPath,
            "--base-url",
            `http://127.0.0.1:${modelStub.port}/v1`,
            "--api-key-env",
            "RIGHTMODELER_E2E_API_KEY",
            "--evaluator",
            "promptfoo",
            "--evaluator-command",
            livePromptfoo!,
            "--evaluator-config",
            promptfooAssertionsPath,
            "--evaluator-scorer",
            "output_similarity",
            "--output",
            "json",
            "--repo",
            repo,
          ],
          {
            env: {
              RIGHTMODELER_E2E_API_KEY: secret,
              PROMPTFOO_CONFIG_DIR: promptfooConfigDir,
              PROMPTFOO_FAILED_TEST_EXIT_CODE: "1",
              PROMPTFOO_STRIP_RESPONSE_OUTPUT: "true",
            },
          },
        );
        expect(result.code, result.stderr).toBe(0);
        const verdicts = jsonOutput(result).verdicts as Array<{
          evaluatorKinds: Array<{ evaluatorKind: string }>;
        }>;
        expect(
          verdicts.flatMap(({ evaluatorKinds }) =>
            evaluatorKinds.map(({ evaluatorKind }) => evaluatorKind),
          ),
        ).toEqual(expect.arrayContaining(["promptfoo"]));

        const store = new FsStore(join(repo, ".rightmodeler"));
        const facts = (await Promise.all(
          (await store.list(factsPrefix("project"))).map(async (key) =>
            JSON.parse(await storeText(store, key)),
          ),
        )) as Array<Record<string, unknown>>;
        const assessments = facts.filter(
          (fact) =>
            typeof fact.assessmentId === "string" &&
            fact.evaluatorId === "promptfoo",
        );
        expect(assessments.length).toBeGreaterThan(0);
        const rubricVersion = new RegExp(
          `^promptfoo@${version.replaceAll(".", "\\.")}/output_similarity/[0-9a-f]{16}$`,
          "u",
        );
        for (const assessment of assessments) {
          expect(assessment.passed).toBe(false);
          expect(assessment.rubricVersion).toMatch(rubricVersion);
        }
        expect(
          facts.some((fact) => "actor" in fact && fact.actor === "judge"),
        ).toBe(false);
      } finally {
        await modelStub.close();
      }
    },
    120_000,
  );

  it.skipIf(livePromptfoo === undefined)(
    "re-grades with the real promptfoo CLI after an assertions edit without a model call",
    async () => {
      const run = await regradeAfterAssertionsEdit({
        label: "promptfoo-live-regrade",
        command: livePromptfoo!,
        env: (root) => ({
          PROMPTFOO_CONFIG_DIR: join(root, "promptfoo-config"),
          PROMPTFOO_FAILED_TEST_EXIT_CODE: "1",
          PROMPTFOO_STRIP_RESPONSE_OUTPUT: "true",
        }),
      });
      const version = (
        await execFileAsync(livePromptfoo!, ["--version"], {
          encoding: "utf8",
          env: {
            ...process.env,
            PROMPTFOO_CONFIG_DIR: join(run.root, "promptfoo-config"),
            PROMPTFOO_DISABLE_UPDATE: "true",
          },
        })
      ).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1)!;

      for (const grade of run.gradesAfterEdited) {
        expect(grade.passed).toBe(false);
      }
      const firstIds = new Set(
        run.gradesAfterFirst.map(({ assessmentId }) => assessmentId),
      );
      const firstVersions = new Set(
        run.gradesAfterFirst.map(({ rubricVersion }) => rubricVersion),
      );
      const newVersions = new Set(
        run.gradesAfterEdited
          .filter(({ assessmentId }) => !firstIds.has(assessmentId))
          .map(({ rubricVersion }) => rubricVersion),
      );
      expect(newVersions.size).toBe(1);
      const [newVersion] = [...newVersions];
      expect(newVersion).toMatch(
        new RegExp(
          `^promptfoo@${version.replaceAll(".", "\\.")}/output_similarity/[0-9a-f]{16}$`,
          "u",
        ),
      );
      expect(firstVersions.has(newVersion!)).toBe(false);
    },
    180_000,
  );

  it("plans a LangGraph family on each step's own node by trajectory position", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy("position");
    const modeBConfig = await writeModeBConfig(root, repo, "unused-image");
    const stepMap = Object.keys(
      (
        JSON.parse(await readFile(modeBConfig, "utf8")) as {
          stepMap: Record<string, string>;
        }
      ).stepMap,
    );

    const result = await runCli([
      "init",
      "--through",
      "shortlist",
      "--traces",
      traces,
      "--modeb-config",
      modeBConfig,
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code, result.stderr).toBe(0);
    const storeRoot = join(repo, ".rightmodeler");
    const shortlist = (await readStageArtifact(storeRoot, "shortlist")) as {
      familyPlans: Array<{
        familyId: string;
        binding?: string;
        stepIds: string[];
        leftOutCases?: number;
        abstainReason?: unknown;
      }>;
      cases: Array<{ family: string; caseId: string; stepId: string }>;
    };
    const plan = shortlist.familyPlans.find(
      ({ familyId }) => familyId === "langgraph_order_lookup",
    );
    expect(plan).toMatchObject({ binding: "trace_match" });
    expect(plan).not.toHaveProperty("leftOutCases");
    expect(plan).not.toHaveProperty("abstainReason");
    expect([...plan!.stepIds].sort()).toEqual([...stepMap].sort());
    const corpus = await resolveCheckpointedPipelineCorpus({
      repo,
      store: new FsStore(storeRoot),
      storeRoot,
      projectId: "project",
    });
    const stepIndexByCase = new Map(
      corpus.cases.map(({ caseId, content }) => [caseId, content.stepIndex]),
    );
    const planCases = shortlist.cases.filter(
      ({ family }) => family === "langgraph_order_lookup",
    );
    expect(planCases).toHaveLength(
      corpus.cases.filter(
        ({ content }) => content.family === "langgraph_order_lookup",
      ).length,
    );
    for (const { caseId, stepId } of planCases) {
      expect(stepId).toBe(stepMap[stepIndexByCase.get(caseId)!]);
    }
  }, 120_000);

  it("abstains an affected family when the provider catalog drifts before confirmation", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy("catalog-drift");
    const modeBConfig = await writeModeBConfig(root, repo, "unused-image");
    const stub = await startCatalogDriftStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_CATALOG_DRIFT_API_KEY",
          "--modeb-config",
          modeBConfig,
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_CATALOG_DRIFT_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      expect(jsonOutput(result).familyOutcomes).toContainEqual(
        expect.objectContaining({
          familyId: "langgraph_order_lookup",
          decisionDisplay: "abstain",
          effectiveRecommendation: false,
          verdict: expect.objectContaining({
            abstainReason: {
              reason: "provider_catalog_drift",
              observed: 0,
              required: 1,
            },
          }),
          confirmation: expect.objectContaining({
            status: "blocked",
            blocker: expect.stringContaining("absent from the catalog"),
          }),
        }),
      );
      const report = await storeText(
        new FsStore(join(repo, ".rightmodeler")),
        reportKey("project", "report.md"),
      );
      expect(report).toContain("provider_catalog_drift");
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("names the missing neutral judge at confirmation instead of a runtime error", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy(
      "confirm-no-neutral-judge",
    );
    const modeBConfig = await writeModeBConfig(root, repo, "unused-image");
    const stub = await startCatalogDriftStub((id) => id.startsWith("acme/"));
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_CONFIRM_JUDGE_API_KEY",
          "--modeb-config",
          modeBConfig,
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_CONFIRM_JUDGE_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(2);
      expect(lastStderrEvent(result).code).toBe("no_neutral_judge");
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("refuses the cloud Mode B backend before confirmation when it is unavailable", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy("catalog-drift");
    const modeBConfig = await writeModeBConfig(root, repo, "unused-image");
    const parsed = JSON.parse(await readFile(modeBConfig, "utf8"));
    await writeFile(
      modeBConfig,
      JSON.stringify({ ...parsed, backend: "cloud" }),
    );
    const stub = await startCatalogDriftStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_CATALOG_DRIFT_API_KEY",
          "--modeb-config",
          modeBConfig,
          "--output",
          "json",
          "--repo",
          repo,
        ],
        {
          env: {
            RIGHTMODELER_CATALOG_DRIFT_API_KEY: secret,
            VERCEL_OIDC_TOKEN: "",
            VERCEL_TOKEN: "",
            VERCEL_TEAM_ID: "",
            VERCEL_PROJECT_ID: "",
          },
        },
      );

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "modeb_cloud_unavailable",
        remedy: expect.stringContaining("backend"),
        message: expect.stringMatching(/@vercel\/sandbox|VERCEL_OIDC_TOKEN/),
      });
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("abstains an affected family when confirmation model metadata is missing", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy(
      "confirmation-model-metadata",
    );
    const modeBConfig = await writeModeBConfig(root, repo, "unused-image");
    const stub = await startStub();
    const baseArgs = [
      "init",
      "--traces",
      traces,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_CONFIRMATION_METADATA_API_KEY",
      "--modeb-config",
      modeBConfig,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const aggregate = await runCli([...baseArgs, "--through", "aggregate"], {
        env: { RIGHTMODELER_CONFIRMATION_METADATA_API_KEY: secret },
      });
      expect(aggregate.code, aggregate.stderr).toBe(0);
      const storeRoot = join(repo, ".rightmodeler");
      await rewriteStageArtifact(storeRoot, "reconcile", (artifact) => ({
        ...artifact,
        records: Array.isArray(artifact.records)
          ? artifact.records.map((record) =>
              typeof record === "object" && record !== null
                ? { ...record, currentModel: null }
                : record,
            )
          : artifact.records,
      }));

      const result = await runCli(baseArgs, {
        env: { RIGHTMODELER_CONFIRMATION_METADATA_API_KEY: secret },
      });

      expect(result.code, result.stderr).toBe(0);
      expect(jsonOutput(result).familyOutcomes).toContainEqual(
        expect.objectContaining({
          decisionDisplay: "abstain",
          effectiveRecommendation: false,
          verdict: expect.objectContaining({
            abstainReason: expect.objectContaining({
              reason: "confirmation_model_metadata_missing",
            }),
          }),
          confirmation: expect.objectContaining({
            status: "blocked",
            blocker: expect.stringContaining("has no current model"),
          }),
        }),
      );
      const report = await storeText(
        new FsStore(storeRoot),
        reportKey("project", "report.md"),
      );
      expect(report).toContain("confirmation_model_metadata_missing");
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("abstains an affected family when recorded confirmation text is missing", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy(
      "confirmation-recorded-content",
    );
    const modeBConfig = await writeModeBConfig(root, repo, "unused-image");
    const stub = await startStub();
    const baseArgs = [
      "init",
      "--traces",
      traces,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_CONFIRMATION_CONTENT_API_KEY",
      "--modeb-config",
      modeBConfig,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const aggregate = await runCli([...baseArgs, "--through", "aggregate"], {
        env: { RIGHTMODELER_CONFIRMATION_CONTENT_API_KEY: secret },
      });
      expect(aggregate.code, aggregate.stderr).toBe(0);
      const storeRoot = join(repo, ".rightmodeler");
      await rewriteStageArtifact(storeRoot, "scrub", (artifact) => ({
        ...artifact,
        runs: Array.isArray(artifact.runs)
          ? artifact.runs.map((run) => {
              if (
                typeof run !== "object" ||
                run === null ||
                !("steps" in run) ||
                !Array.isArray(run.steps)
              ) {
                return run;
              }
              return {
                ...run,
                steps: run.steps.map((step: unknown, index: number) =>
                  typeof step === "object" &&
                  step !== null &&
                  index === run.steps.length - 1
                    ? { ...step, output: {} }
                    : step,
                ),
              };
            })
          : artifact.runs,
      }));

      const result = await runCli(baseArgs, {
        env: { RIGHTMODELER_CONFIRMATION_CONTENT_API_KEY: secret },
      });

      expect(result.code, result.stderr).toBe(0);
      expect(jsonOutput(result).familyOutcomes).toContainEqual(
        expect.objectContaining({
          decisionDisplay: "abstain",
          effectiveRecommendation: false,
          verdict: expect.objectContaining({
            abstainReason: {
              reason: "confirmation_recorded_content_missing",
              observed: 0,
              required: 1,
            },
          }),
          confirmation: expect.objectContaining({
            status: "blocked",
            blocker: expect.stringContaining("no text content"),
          }),
        }),
      );
      const report = await storeText(
        new FsStore(storeRoot),
        reportKey("project", "report.md"),
      );
      expect(report).toContain("confirmation_recorded_content_missing");
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("marks a confirmation-needing recommendation unconfirmed when Mode B config is absent", async () => {
    const { repo, traces } = await langgraphFixtureCopy("unconfirmed");
    const stub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_UNCONFIRMED_E2E_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_UNCONFIRMED_E2E_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      expect(jsonOutput(result).familyOutcomes).toContainEqual(
        expect.objectContaining({
          familyId: "langgraph_order_lookup",
          decisionDisplay: "recommend (unconfirmed)",
          effectiveRecommendation: false,
          confirmation: expect.objectContaining({
            status: "blocked",
            blocker: "Missing --modeb-config for cascade confirmation.",
          }),
        }),
      );
      const reportMarkdown = await storeText(
        new FsStore(join(repo, ".rightmodeler")),
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("recommend (unconfirmed)");
      expect(reportMarkdown).toContain(
        "Missing --modeb-config for cascade confirmation.",
      );
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("names an invalid Mode B config field", async () => {
    const { root, repo } = await fixtureCopy("bad-modeb-config");
    const config = join(root, "modeb.json");
    await writeFile(
      config,
      JSON.stringify({
        version: "1",
        image: "python:3.12-slim",
        appSpec: { mountPath: repo, command: [] },
        stepMap: { canonical: "runtime" },
      }),
    );
    const result = await runCli([
      "init",
      "--plan",
      "--modeb-config",
      config,
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "invalid_modeb_config",
      message: expect.stringContaining("appSpec.command"),
      remedy: expect.stringContaining("--modeb-config"),
    });
  });

  it("reports a candidate whose provider calls all errored with one redacted sample", async () => {
    const { repo } = await fixtureCopy("provider-errors");
    const stub = await startStub({ errorModels: ["acme/lite-1"] });
    const apiKeyEnv = "RIGHTMODELER_PROVIDER_ERROR_E2E_API_KEY";
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { [apiKeyEnv]: secret } },
      );
      expect([0, 1], result.stderr).toContain(result.code);

      const store = new FsStore(join(repo, ".rightmodeler"));
      const reportJson = JSON.parse(
        await storeText(store, reportKey("project", "report.json")),
      ) as {
        candidateErrors: Array<{
          candidateId: string;
          calls: number;
          sampleExcerpt: string;
        }>;
      };
      expect(reportJson.candidateErrors).toEqual([
        {
          candidateId: "acme/lite-1",
          calls: expect.any(Number),
          sampleExcerpt: expect.stringContaining("[redacted]"),
        },
      ]);
      expect(reportJson.candidateErrors[0]?.calls).toBeGreaterThan(0);

      const markdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(markdown).toContain("[warn] acme/lite-1 errored on ALL");
      expect(markdown).toContain("[redacted]");
      expect(await allFileText(join(repo, ".rightmodeler"))).not.toContain(
        secret,
      );

      const human = await runCli([
        "report",
        "--output",
        "human",
        "--repo",
        repo,
      ]);
      expect(human.stdout).toContain("[warn] acme/lite-1 errored on ALL");
    } finally {
      await stub.close();
    }
  });

  it("returns a machine-readable needs-input error when replay has no provider", async () => {
    const { repo } = await fixtureCopy("no-provider");
    const result = await runCli([
      "init",
      "--traces",
      tracesPath,
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      code: "missing_provider_configuration",
      message: "Provider configuration is required when replay is reached.",
      remedy:
        "Pass --base-url <url> and, if needed, --api-key-env <environment-variable-name>.",
    });
  });

  it("reports report before aggregate as a needs-input error", async () => {
    const { repo } = await fixtureCopy("report-before-aggregate");
    const result = await runCli(["report", "--output", "json", "--repo", repo]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "stage_not_completed",
      message: "aggregate has not completed",
    });
  });

  it("names a repository with no replayable text call sites", async () => {
    const { repo } = await fixtureCopy("no-replayable-call-sites");
    await Promise.all([
      rm(join(repo, "src", "summarize.ts"), { force: true }),
      rm(join(repo, "src", "summarize-stream.ts"), { force: true }),
      rm(join(repo, "src", "support.py"), { force: true }),
      rm(join(repo, "src", "triage.py"), { force: true }),
      rm(join(repo, "src", "model-notes.ts"), { force: true }),
      rm(join(repo, "config"), { recursive: true, force: true }),
      rm(join(repo, "requirements.txt"), { force: true }),
    ]);
    await writeFile(
      join(repo, "package.json"),
      `${JSON.stringify({ dependencies: { ai: "*" } }, null, 2)}\n`,
    );
    await execFileAsync("git", ["-C", repo, "add", "--all"]);
    await execFileAsync("git", [
      "-C",
      repo,
      "commit",
      "--message",
      "Narrow replayable fixture",
    ]);

    const result = await runCli([
      "init",
      "--through",
      "shortlist",
      "--traces",
      tracesPath,
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "no_replayable_call_sites",
    });
  });

  it("stops at scan when an AI dependency has no matched call site", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-coverage-"));
    temporaryDirectories.push(root);
    const repo = join(root, "app");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ dependencies: { ai: "1" } }),
    );
    await writeFile(
      join(repo, "src", "index.ts"),
      "export const message = 'no model call here';\n",
    );
    await initializeFixtureRepository(repo);

    const result = await runCli([
      "init",
      "--through",
      "scan",
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "coverage_gate_failed",
      message: expect.stringContaining("AI_DEPENDENCY_ZERO_MATCH"),
    });
    expect(result.stderr).toContain("javascript");
    expect(result.stderr).toContain("ai");
  });

  it("surfaces missing traces and budget refusals at resumable boundaries", async () => {
    const missing = await fixtureCopy("missing-traces");
    const missingResult = await runCli(
      [
        "init",
        "--through",
        "ingest",
        "--output",
        "json",
        "--repo",
        missing.repo,
      ],
      { env: { HOME: await fixtureHome(missing.root) } },
    );
    expect(missingResult.code).toBe(2);
    expect(JSON.parse(missingResult.stderr)).toMatchObject({
      code: "missing_traces_path",
      remedy: expect.stringContaining("--traces"),
    });

    const missingPath = join(missing.repo, "missing.json");
    const missingFileResult = await runCli([
      "init",
      "--through",
      "ingest",
      "--traces",
      missingPath,
      "--output",
      "json",
      "--repo",
      missing.repo,
    ]);
    expect(missingFileResult.code).toBe(2);
    expect(JSON.parse(missingFileResult.stderr)).toMatchObject({
      code: "missing_traces_path",
      message: `Trace input does not exist: ${missingPath}`,
    });

    const missingDetachedResult = await runCli([
      "replay",
      "--detach",
      "--traces",
      missingPath,
      "--base-url",
      "http://127.0.0.1:9/v1",
      "--output",
      "json",
      "--repo",
      missing.repo,
    ]);
    expect(missingDetachedResult.code).toBe(2);
    expect(JSON.parse(missingDetachedResult.stderr)).toMatchObject({
      code: "missing_traces_path",
      message: `Trace input does not exist: ${missingPath}`,
    });

    const capped = await fixtureCopy("budget-cap");
    const stub = await startStub();
    try {
      const cappedResult = await runCli(
        [
          "init",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--max-cost-usd",
          "0",
          "--output",
          "json",
          "--repo",
          capped.repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );
      expect(cappedResult.code).toBe(3);
      expect(JSON.parse(cappedResult.stderr)).toMatchObject({
        code: "budget_cap_refusal",
        message: expect.stringContaining("raise it to at least"),
        remedy: expect.stringContaining("--max-cost-usd"),
      });
    } finally {
      await stub.close();
    }
  });

  it("keeps judge spend inside --max-cost-usd and names the next required cap", async () => {
    const { repo } = await fixtureCopy("judge-budget-cap");
    const stub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "replay",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--max-cost-usd",
          "0.01",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(3);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "budget_cap_refusal",
        remedy: expect.stringMatching(/--max-cost-usd/),
      });
      const { spendEvents } = await readLedger(
        new FsStore(join(repo, ".rightmodeler")),
        "project",
      );
      expect(
        spendEvents.reduce((total, { costUsd }) => total + costUsd, 0),
      ).toBeLessThanOrEqual(0.01);
      expect(spendEvents.some(({ actor }) => actor === "judge")).toBe(true);
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("stops sending to a judge at its first model substitution inside --max-cost-usd", async () => {
    const { repo } = await fixtureCopy("judge-substitution-cap");
    const stub = await startStub({
      servedModels: { "zeta/judge-1": "zeta/judge-1-base" },
    });
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "aggregate",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--max-cost-usd",
          "0.04",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(3);
      expect(warningMessages(result.stderr, "judge_unusable")).toEqual([
        "Judge zeta/judge-1 is unusable: it answered as another model (served zeta/judge-1-base for requested zeta/judge-1); switching to yotta/judge-2.",
      ]);
      const events = result.stderr
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { code?: string });
      expect(events.at(-1)).toMatchObject({ code: "budget_cap_refusal" });
      const zetaCalls = stub
        .getRequestHeaders()
        .filter(({ model }) => model === "zeta/judge-1").length;
      expect(zetaCalls).toBeGreaterThanOrEqual(1);
      expect(zetaCalls).toBeLessThanOrEqual(6);
      const { assessments, spendEvents } = await readLedger(
        new FsStore(join(repo, ".rightmodeler")),
        "project",
      );
      expect(assessments.length).toBeGreaterThan(1);
      expect(
        assessments.every(({ evaluatorId }) => evaluatorId === "yotta/judge-2"),
      ).toBe(true);
      expect(
        spendEvents.reduce((total, { costUsd }) => total + costUsd, 0),
      ).toBeLessThanOrEqual(0.04);
    } finally {
      await stub.close();
    }
  }, 120_000);

  it("includes discovered trace candidates in the non-interactive remedy", async () => {
    const fixture = await fixtureCopy("discovered-trace-remedy");
    const home = await fixtureHome(fixture.root);
    const discovered = join(fixture.repo, "traces.json");
    await cp(tracesPath, discovered);

    const result = await runCli(
      [
        "init",
        "--through",
        "ingest",
        "--output",
        "json",
        "--repo",
        fixture.repo,
      ],
      { env: { HOME: home } },
    );

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "missing_traces_path",
      remedy: expect.stringContaining(
        `Found 1 candidate trace file: ${discovered}. Pass --traces <path>.`,
      ),
    });
  });

  it("adopts the newest discovered trace with --yes in non-interactive use", async () => {
    const fixture = await fixtureCopy("discovered-trace-yes");
    const home = await fixtureHome(fixture.root);
    await cp(tracesPath, join(fixture.repo, "traces.json"));

    const result = await runCli(
      [
        "init",
        "--yes",
        "--through",
        "ingest",
        "--output",
        "json",
        "--repo",
        fixture.repo,
      ],
      { env: { HOME: home } },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(jsonOutput(result).executedStages).toContain("ingest");
  });

  it.each(["unreadable file", "traces file", "unreadable traces directory"])(
    "keeps discovery best-effort with %s",
    async (offender) => {
      const fixture = await fixtureCopy(
        `discovery-${offender.replaceAll(" ", "-")}`,
      );
      const home = await fixtureHome(fixture.root);
      const healthy = join(fixture.repo, "traces.json");
      await cp(tracesPath, healthy);
      const unreadable = join(fixture.repo, "unreadable.json");
      const traces = join(fixture.repo, "traces");
      if (offender === "unreadable file") {
        await writeFile(unreadable, "{}");
        await chmod(unreadable, 0o000);
      } else if (offender === "traces file") {
        await writeFile(traces, "not a directory");
      } else {
        await mkdir(traces);
        await chmod(traces, 0o000);
      }

      try {
        const result = await runCli(
          [
            "init",
            "--through",
            "ingest",
            "--output",
            "json",
            "--repo",
            fixture.repo,
          ],
          { env: { HOME: home } },
        );

        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: "missing_traces_path",
          remedy: expect.stringContaining(healthy),
        });
        expect(result.stderr).not.toMatch(/EACCES|ENOTDIR|errno|stack/iu);
      } finally {
        if (offender === "unreadable file") await chmod(unreadable, 0o600);
        if (offender === "unreadable traces directory") {
          await chmod(traces, 0o700);
        }
      }
    },
  );

  it("reports plain-language Git preconditions before scanning", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rightmodeler-git-preconditions-"),
    );
    temporaryDirectories.push(root);
    const home = await fixtureHome(root);
    const plain = join(root, "plain");
    const empty = join(root, "empty");
    await Promise.all([mkdir(plain), mkdir(empty)]);
    await execFileAsync("git", [
      "-C",
      empty,
      "init",
      "--initial-branch",
      "main",
    ]);

    const notRepository = await runCli(
      ["init", "--output", "json", "--repo", plain],
      { env: { HOME: home } },
    );
    expect(notRepository.code).toBe(2);
    expect(JSON.parse(notRepository.stderr)).toEqual({
      code: "not_git_repository",
      message:
        "This folder is not a git repository. Rightmodeler ties findings to your code, so run it inside the project you want audited (or run git init and commit first).",
      remedy:
        "Run the command again from a Git repository with at least one commit.",
    });

    const noCommits = await runCli(
      ["init", "--output", "json", "--repo", empty],
      { env: { HOME: home } },
    );
    expect(noCommits.code).toBe(2);
    expect(JSON.parse(noCommits.stderr)).toEqual({
      code: "git_repository_has_no_commits",
      message:
        "This git repository has no commits. Rightmodeler ties findings to your code, so make an initial commit and rerun.",
      remedy: "Create the first commit, then rerun the command.",
    });
  });
});
