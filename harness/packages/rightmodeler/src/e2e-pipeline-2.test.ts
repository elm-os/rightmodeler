import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  FsStore,
  factKey,
  factsPrefix,
  reportKey,
  verdictKey,
  verdictsPrefix,
} from "@rightmodeler/core";
import { afterAll, describe, expect, it } from "vitest";

import {
  aiSdkFixtureCopy,
  aiSdkLegacyTracesPath,
  allFileText,
  execFileAsync,
  fixtureCopy,
  jsonOutput,
  minimumHoldout,
  promptfooAssertionsPath,
  promptfooCommandPath,
  readStageArtifact,
  removeTemporaryDirectories,
  runCli,
  secret,
  startEvaluatorStub,
  startStub,
  storeText,
  tracesPath,
  waitForTerminalRun,
  warningMessages,
  writeToolCallTraces,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

describe("built CLI pipeline", () => {
  it("estimates without model spend and idempotently dispatches a detached replay", async () => {
    const { root, repo } = await fixtureCopy("detached-replay");
    const store = join(root, "store");
    const invocationDirectory = join(root, "invocation");
    await mkdir(invocationDirectory);
    const physicalInvocationDirectory = await realpath(invocationDirectory);
    const relativeTraces = relative(physicalInvocationDirectory, tracesPath);
    const relativeEvaluatorCommand = relative(
      physicalInvocationDirectory,
      promptfooCommandPath,
    );
    const relativeEvaluatorConfig = relative(
      physicalInvocationDirectory,
      promptfooAssertionsPath,
    );
    const stub = await startStub({ includeFreeModel: true });
    const apiKeyEnv = "RIGHTMODELER_DETACHED_E2E_API_KEY";
    const common = ["--repo", repo, "--store", store, "--output", "json"];
    const replayOptions = [
      "--traces",
      relativeTraces,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      "--evaluator",
      "promptfoo",
      "--evaluator-command",
      relativeEvaluatorCommand,
      "--evaluator-config",
      relativeEvaluatorConfig,
      "--evaluator-scorer",
      "output_similarity",
      "--max-cost-usd",
      "25",
    ];

    try {
      const estimate = await runCli([...common, "estimate", ...replayOptions], {
        cwd: invocationDirectory,
        env: { [apiKeyEnv]: secret },
      });
      expect(estimate.code, estimate.stderr).toBe(0);
      expect(jsonOutput(estimate)).toMatchObject({
        corpusCases: expect.any(Number),
        candidateExecutions: expect.any(Number),
        projectedCostUsd: expect.any(Number),
        shortlist: expect.any(Array),
      });
      expect(jsonOutput(estimate).candidateExecutions).not.toBe(0);
      expect(
        (
          jsonOutput(estimate).shortlist as Array<{ candidateIds: string[] }>
        ).flatMap(({ candidateIds }) => candidateIds),
      ).not.toContain("acme/free-1");
      expect(stub.getHitCount()).toBe(0);

      const includeFree = await runCli(
        [...common, "estimate", ...replayOptions, "--include-free"],
        {
          cwd: invocationDirectory,
          env: { [apiKeyEnv]: secret },
        },
      );
      expect(includeFree.code, includeFree.stderr).toBe(0);
      expect(
        (
          jsonOutput(includeFree).shortlist as Array<{
            candidateIds: string[];
          }>
        ).flatMap(({ candidateIds }) => candidateIds),
      ).toContain("acme/free-1");

      const first = await runCli(
        [...common, "replay", ...replayOptions, "--detach"],
        { cwd: invocationDirectory, env: { [apiKeyEnv]: secret } },
      );
      expect(first.code).toBe(0);
      const firstDispatch = jsonOutput(first);
      expect(firstDispatch).toMatchObject({
        status: "running",
        terminal: false,
        deduplicated: false,
      });
      const runId = String(firstDispatch.runId);

      const duplicate = await runCli(
        [...common, "replay", ...replayOptions, "--detach"],
        { cwd: invocationDirectory, env: { [apiKeyEnv]: secret } },
      );
      expect(duplicate.code).toBe(0);
      expect(jsonOutput(duplicate)).toMatchObject({
        runId,
        deduplicated: true,
      });

      const terminal = await waitForTerminalRun(repo, store, runId);
      expect(terminal).toMatchObject({
        runId,
        status: "completed",
        terminal: true,
        progress: {
          targetStage: "replay",
          completed: 8,
          total: 8,
        },
      });
      const hitsAtCompletion = stub.getHitCount();

      const terminalDuplicate = await runCli(
        [...common, "replay", ...replayOptions, "--detach"],
        { cwd: invocationDirectory, env: { [apiKeyEnv]: secret } },
      );
      expect(terminalDuplicate.code).toBe(0);
      expect(jsonOutput(terminalDuplicate)).toMatchObject({
        runId,
        status: "completed",
        terminal: true,
        deduplicated: true,
      });
      expect(stub.getHitCount()).toBe(hitsAtCompletion);
    } finally {
      await stub.close();
    }
  });

  it("imports a curated provider corpus without persisting its key", async () => {
    const { repo } = await fixtureCopy("corpus-import");
    const evaluatorStub = await startEvaluatorStub();
    const evaluatorSecret = "corpus-e2e-key-must-not-persist";
    try {
      const result = await runCli(
        [
          "corpus",
          "import",
          "--from",
          "braintrust:braintrust-dataset-1",
          "--base-url",
          `http://127.0.0.1:${evaluatorStub.port}`,
          "--api-key-env",
          "RIGHTMODELER_E2E_CORPUS_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_E2E_CORPUS_KEY: evaluatorSecret } },
      );

      expect(result.code).toBe(0);
      expect(jsonOutput(result)).toMatchObject({
        corpusVersionId: expect.any(String),
        caseCount: 2,
        curatedVerifiedCases: 1,
      });
      const storeRoot = join(repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      expect(await store.list("project/cases/")).toHaveLength(2);
      const currentImport = await store.get(
        "project/setup/imported-reference-corpus.json",
      );
      expect(currentImport).not.toBeNull();
      expect(
        JSON.parse(Buffer.from(currentImport!.body).toString("utf8")),
      ).toMatchObject({
        cases: expect.arrayContaining([
          expect.objectContaining({
            family: "qa",
            referenceSource: "curated",
            referenceVerified: true,
          }),
        ]),
      });
      expect(await allFileText(storeRoot)).not.toContain(evaluatorSecret);
    } finally {
      await evaluatorStub.close();
    }
  });

  it("exports stored trials and verdicts once and persists a key-free receipt", async () => {
    const { repo } = await fixtureCopy("result-export");
    const evaluatorStub = await startEvaluatorStub();
    const evaluatorSecret = "export-e2e-key-must-not-persist";
    const storeRoot = join(repo, ".rightmodeler");
    const store = new FsStore(storeRoot);
    const execution = {
      executionId: "execution-export-1",
      evidenceQuestionId: "question-export-1",
      caseId: "case-export-1",
      stepId: "step-export-1",
      candidateId: "candidate-export-1",
      trajectoryId: "trajectory-export-1",
      corpusSplit: "holdout",
      selectionStage: "confirmation",
      terminalOutcome: "success",
      finalOutput: "Paris",
      attribution: "ok",
    };
    const assessment = {
      assessmentId: "assessment-export-1",
      executionId: execution.executionId,
      evaluatorId: "braintrust",
      metricName: "quality",
      score: 1,
      passed: true,
      rubricVersion: "quality-v1",
      artifactRef: null,
    };
    await store.putImmutable(
      factKey("project", execution.executionId),
      Buffer.from(JSON.stringify(execution), "utf8"),
    );
    await store.putImmutable(
      factKey("project", assessment.assessmentId),
      Buffer.from(JSON.stringify(assessment), "utf8"),
    );
    await store.putImmutable(
      verdictKey("project", "qa"),
      Buffer.from(
        JSON.stringify({
          familyId: "qa",
          decision: "recommend",
          evaluatorKinds: [],
        }),
        "utf8",
      ),
    );
    const args = [
      "export",
      "--to",
      "braintrust",
      "--base-url",
      `http://127.0.0.1:${evaluatorStub.port}`,
      "--api-key-env",
      "RIGHTMODELER_E2E_EXPORT_KEY",
      "--project-id",
      "00000000-0000-4000-8000-000000000001",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const first = await runCli(args, {
        env: { RIGHTMODELER_E2E_EXPORT_KEY: evaluatorSecret },
      });
      expect(first.code).toBe(0);
      expect(jsonOutput(first)).toMatchObject({
        provider: "braintrust",
        exportedTrials: 1,
        exportedVerdicts: 1,
      });
      const exportHits = evaluatorStub.getHitCount("POST", "/v1/experiment");

      const resumed = await runCli(args, {
        env: { RIGHTMODELER_E2E_EXPORT_KEY: evaluatorSecret },
      });

      expect(resumed.code).toBe(0);
      expect(evaluatorStub.getHitCount("POST", "/v1/experiment")).toBe(
        exportHits,
      );
      expect(await store.list("project/exports/")).toHaveLength(1);
      expect(await allFileText(storeRoot)).not.toContain(evaluatorSecret);
    } finally {
      await evaluatorStub.close();
    }
  });

  it("runs end to end, reports both families, resumes replay, and never persists the key", async () => {
    const { repo } = await fixtureCopy("full");
    const stub = await startStub();
    const args = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_E2E_API_KEY",
      "--output",
      "json",
      "--repo",
      repo,
    ];

    try {
      const first = await runCli(args, {
        env: { RIGHTMODELER_E2E_API_KEY: secret },
      });
      expect(first.code).toBe(0);
      const firstOutput = jsonOutput(first);
      const verdicts = firstOutput.verdicts as Array<{
        familyId: string;
        decision: string;
        abstainReason?: {
          reason: string;
          observed: number;
          required: number;
        };
      }>;
      expect(verdicts.map(({ familyId }) => familyId).sort()).toEqual([
        "summarize",
        "support",
      ]);
      expect(
        verdicts.filter(
          ({ decision }) => decision === "recommend" || decision === "reject",
        ),
      ).toEqual([expect.objectContaining({ familyId: "summarize" })]);
      expect(verdicts).toContainEqual(
        expect.objectContaining({
          familyId: "support",
          decision: "abstain",
          abstainReason: {
            reason: "ambiguous_call_site_binding",
            observed: 0,
            required: 7,
          },
        }),
      );
      const outcomes = firstOutput.familyOutcomes as Array<{
        familyId: string;
        decisionDisplay: string;
        effectiveRecommendation: boolean;
        confirmation?: { status: string };
        selection: {
          status: string;
          shortlistedCandidateIds: string[];
          selectedCandidateId?: string;
          selectionAdjustedEstimate?: { lower: number };
        };
        gates: Array<{ pass: boolean }>;
      }>;
      const summarize = outcomes.find(
        ({ familyId }) => familyId === "summarize",
      );
      expect(summarize).toMatchObject({
        decisionDisplay: "recommend (unconfirmed)",
        effectiveRecommendation: false,
        confirmation: { status: "blocked" },
        selection: {
          status: "selected",
          selectionAdjustedEstimate: { lower: expect.any(Number) },
        },
        gates: expect.arrayContaining([
          expect.objectContaining({ pass: true }),
        ]),
      });
      expect(
        summarize?.selection.shortlistedCandidateIds.length,
      ).toBeGreaterThan(1);
      expect(summarize?.selection.shortlistedCandidateIds).toContain(
        summarize?.selection.selectedCandidateId,
      );

      const storeRoot = join(repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      const reportJson = JSON.parse(
        await storeText(store, reportKey("project", "report.json")),
      ) as {
        verdicts: unknown[];
        families: Array<{ gates: unknown[]; selection: unknown }>;
        blockedFamilies: Array<{
          familyId: string;
          diagnosis: { issueClass: string };
        }>;
      };
      const reportMarkdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("ambiguous_call_site_binding (0 of 7)");
      expect(reportMarkdown).toContain("## Gates");
      expect(reportMarkdown).toContain("## Selection");
      expect(reportMarkdown).toContain("Selection-adjusted estimate");
      expect(reportMarkdown).toContain("## Reference ceilings");
      expect(reportMarkdown).toContain("default base 100.0%");
      expect(reportMarkdown).toContain("## Caps");
      expect(reportMarkdown).toContain("droppedByTop");
      expect(reportMarkdown).toContain("droppedFreeModels");
      expect(reportJson.families).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gates: expect.any(Array),
            selection: expect.objectContaining({ status: "selected" }),
          }),
        ]),
      );
      expect(reportJson.blockedFamilies).toContainEqual(
        expect.objectContaining({
          familyId: "support",
          diagnosis: expect.objectContaining({
            issueClass: "insufficient-evidence",
          }),
        }),
      );
      const storedVerdicts = await Promise.all(
        (await store.list(verdictsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      );
      expect(reportJson.verdicts).toEqual(storedVerdicts);
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      const executions = new Map(
        facts
          .filter(
            (fact) =>
              typeof fact.executionId === "string" &&
              typeof fact.candidateId === "string",
          )
          .map((fact) => [fact.executionId as string, fact]),
      );
      const assessments = facts.filter(
        (fact) =>
          typeof fact.assessmentId === "string" &&
          typeof fact.evaluatorId === "string",
      );
      expect(assessments.length).toBeGreaterThan(0);
      for (const assessment of assessments) {
        const execution = executions.get(assessment.executionId as string);
        expect(assessment.evaluatorId).toBe("zeta/judge-1");
        const candidateFamily = String(execution?.candidateId).split("/", 1)[0];
        const referenceFamily = "acme";
        const judgeFamily = String(assessment.evaluatorId).split("/", 1)[0];
        expect(candidateFamily).toBe(referenceFamily);
        expect([candidateFamily, referenceFamily]).not.toContain(judgeFamily);
      }

      const hitsAfterFirstRun = stub.getHitCount();
      expect(hitsAfterFirstRun).toBeGreaterThan(0);
      const resumed = await runCli(args, {
        env: { RIGHTMODELER_E2E_API_KEY: secret },
      });
      expect(resumed.code).toBe(0);
      expect(jsonOutput(resumed).executedStages).toEqual([]);
      expect(stub.getHitCount()).toBe(hitsAfterFirstRun);

      const reportCommand = await runCli([
        "report",
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(reportCommand.code).toBe(0);
      expect(jsonOutput(reportCommand)).toMatchObject({
        verdicts: reportJson.verdicts,
      });
      const humanReport = await runCli([
        "report",
        "--output",
        "human",
        "--repo",
        repo,
      ]);
      expect(humanReport.code).toBe(0);
      expect(humanReport.stderr).toBe("");
      expect(humanReport.stdout).toContain(
        "Family | Decision | Evaluator rates | Availability | Worst-case bound | Abstain reason",
      );
      expect(humanReport.stdout).toContain("summarize | recommend");
      expect(humanReport.stdout).toContain(
        "ambiguous_call_site_binding (0 of 7)",
      );
      expect(humanReport.stdout).toContain("report.md");
      expect(humanReport.stdout).not.toContain('"verdicts"');
      const statusCommand = await runCli([
        "status",
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(statusCommand.code).toBe(0);
      expect(jsonOutput(statusCommand)).toMatchObject({
        corpusVersion: expect.any(String),
        factCounts: {
          Execution: executions.size,
          Assessment: assessments.length,
        },
      });
      expect(executions.size).toBeLessThan(111);

      expect(await allFileText(storeRoot)).not.toContain(secret);
      expect(reportMarkdown).not.toContain(secret);
      expect(JSON.stringify(reportJson)).not.toContain(secret);
    } finally {
      await stub.close();
    }
  }, 180_000);

  it("gives a second family two call sites and never abstains it on distinct steps", async () => {
    const { root, repo } = await fixtureCopy("second-family-call-sites");
    await writeFile(
      join(repo, "src", "support-text.ts"),
      [
        'import { generateText } from "ai";',
        "",
        "export async function supportText(message: string) {",
        "  return generateText({",
        '    model: "acme/large-1",',
        "    prompt: message,",
        '    experimental_telemetry: { isEnabled: true, functionId: "support" },',
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(repo, "src", "support-stream.ts"),
      [
        'import { streamText } from "ai";',
        "",
        "export function supportStream(message: string) {",
        "  return streamText({",
        '    model: "acme/large-1",',
        "    prompt: message,",
        '    experimental_telemetry: { isEnabled: true, functionId: "support" },',
        "  });",
        "}",
        "",
      ].join("\n"),
    );
    await execFileAsync("git", ["-C", repo, "add", "--all"]);
    await execFileAsync("git", [
      "-C",
      repo,
      "commit",
      "--message",
      "Add second family call sites",
    ]);
    const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
      traceId: string;
      span_id: string;
      startTimeUnixNano: string;
      attributes: Record<string, unknown>;
      [key: string]: unknown;
    }>;
    const supportSpans = traces.filter(
      ({ attributes }) => attributes["rightmodeler.family"] === "support",
    );
    const widenedTraces = join(root, "widened-support.json");
    await writeFile(
      widenedTraces,
      JSON.stringify([
        ...traces,
        ...Array.from({ length: 120 }, (_, index) => ({
          ...supportSpans[index % supportSpans.length]!,
          traceId: `trace-support-wide-${index}`,
          span_id: `span-support-wide-${index}`,
          startTimeUnixNano: String(10_000 + index),
        })),
      ]),
    );
    const stub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          widenedTraces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_SECOND_FAMILY_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_SECOND_FAMILY_API_KEY: secret } },
      );

      expect([0, 1], result.stderr).toContain(result.code);
      const output = jsonOutput(result);
      const supportVerdict = (
        output.verdicts as Array<{
          familyId: string;
          abstainReason?: { reason: string };
        }>
      ).find(({ familyId }) => familyId === "support");
      expect(supportVerdict).toBeDefined();
      expect(supportVerdict?.abstainReason?.reason).not.toBe(
        "insufficient_distinct_steps",
      );
      expect(supportVerdict?.abstainReason?.reason).not.toBe(
        "holdout_below_floor_minimum",
      );
      const shortlist = await readStageArtifact(
        join(repo, ".rightmodeler"),
        "shortlist",
      );
      const supportPlan = (
        shortlist.familyPlans as Array<{
          familyId: string;
          holdoutCases: number;
          stepIds: string[];
          abstainReason?: unknown;
        }>
      ).find(({ familyId }) => familyId === "support");
      expect(supportPlan?.holdoutCases).toBeGreaterThanOrEqual(minimumHoldout);
      expect(supportPlan?.stepIds).toHaveLength(2);
      expect(supportPlan).not.toHaveProperty("abstainReason");
      expect(
        (shortlist.steps as Array<{ family: string }>).filter(
          ({ family }) => family === "support",
        ),
      ).toHaveLength(2);
    } finally {
      await stub.close();
    }
  }, 480_000);

  it("abstains a single-call-site family before any replay spend", async () => {
    const { root, repo } = await fixtureCopy("single-call-site-family");
    await Promise.all([
      rm(join(repo, "src", "support.py"), { force: true }),
      rm(join(repo, "src", "triage.py"), { force: true }),
      rm(join(repo, "src", "model-notes.ts"), { force: true }),
      rm(join(repo, "src", "summarize-stream.ts"), { force: true }),
      rm(join(repo, "src", "extract.ts"), { force: true }),
      rm(join(repo, "config"), { recursive: true, force: true }),
      rm(join(repo, "requirements.txt"), { force: true }),
    ]);
    await writeFile(
      join(repo, "src", "summarize.ts"),
      [
        'import { generateText } from "ai";',
        "",
        "export async function summarize(article: string) {",
        "  return generateText({",
        '    model: "acme/large-1",',
        '    system: "Summarize the article faithfully in two concise sentences.",',
        "    prompt: article,",
        "  });",
        "}",
        "",
      ].join("\n"),
    );
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
      "Narrow single call site fixture",
    ]);
    const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
      attributes?: Record<string, unknown>;
    }>;
    const summarizeTraces = join(root, "summarize-otel.json");
    await writeFile(
      summarizeTraces,
      JSON.stringify(
        traces.filter(
          ({ attributes }) =>
            attributes?.["rightmodeler.family"] === "summarize",
        ),
      ),
    );
    const stub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          summarizeTraces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_SINGLE_CALL_SITE_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_SINGLE_CALL_SITE_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      const output = jsonOutput(result);
      const shortlist = await readStageArtifact(
        join(repo, ".rightmodeler"),
        "shortlist",
      );
      expect(shortlist.steps).toEqual([]);
      expect(shortlist.cases).toEqual([]);
      expect(shortlist.familyPlans).toContainEqual(
        expect.objectContaining({
          familyId: "summarize",
          stepIds: [],
          abstainReason: {
            reason: "insufficient_distinct_steps",
            observed: 1,
            required: 2,
          },
        }),
      );
      expect(output.verdicts).toContainEqual(
        expect.objectContaining({
          familyId: "summarize",
          decision: "abstain",
          abstainReason: {
            reason: "insufficient_distinct_steps",
            observed: 1,
            required: 2,
          },
        }),
      );
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("replays a single call site bound by its functionId without a distinct-step abstention", async () => {
    const { repo } = await aiSdkFixtureCopy("single-bound-call-site");
    const stub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          aiSdkLegacyTracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_BOUND_CALL_SITE_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_BOUND_CALL_SITE_API_KEY: secret } },
      );

      expect([0, 1], result.stderr).toContain(result.code);
      const output = JSON.parse(result.stdout) as {
        verdicts: Array<{
          familyId: string;
          evaluatorKinds: Array<{ nDistinctSteps: number }>;
          abstainReason?: { reason: string };
        }>;
      };
      const triage = output.verdicts.find(
        ({ familyId }) => familyId === "triage",
      );
      expect(triage).toBeDefined();
      expect(
        triage!.evaluatorKinds.map(({ nDistinctSteps }) => nDistinctSteps),
      ).toEqual([1]);
      expect(triage!.abstainReason?.reason).not.toBe(
        "insufficient_distinct_steps",
      );
    } finally {
      await stub.close();
    }
  }, 240_000);

  it("leaves recorded tool-call cases out of the replay sample and replays the rest", async () => {
    const { root, repo } = await fixtureCopy("unsendable-cases");
    const traces = await writeToolCallTraces(root, 4);
    const stub = await startStub();
    const apiKeyEnv = "RIGHTMODELER_UNSENDABLE_CASES_API_KEY";
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "replay",
          "--traces",
          traces,
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

      expect(result.code, result.stderr).toBe(0);
      const warnings = warningMessages(
        result.stderr,
        "recorded_messages_not_replayable",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Family summarize: 4 of 70");
      expect(warnings[0]).toContain("must be a text part");
      const storeRoot = join(repo, ".rightmodeler");
      const shortlist = (await readStageArtifact(storeRoot, "shortlist")) as {
        familyPlans: Array<{ familyId: string; leftOutCases?: number }>;
        cases: Array<{ messages: Array<{ parts?: Array<{ type: string }> }> }>;
      };
      expect(
        shortlist.familyPlans.find(({ familyId }) => familyId === "summarize")
          ?.leftOutCases,
      ).toBeGreaterThanOrEqual(4);
      expect(
        shortlist.cases
          .flatMap(({ messages }) => messages)
          .flatMap(({ parts }) => parts ?? [])
          .filter(({ type }) => type === "tool_call"),
      ).toEqual([]);
      const store = new FsStore(storeRoot);
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
    } finally {
      await stub.close();
    }
  }, 120_000);
});
