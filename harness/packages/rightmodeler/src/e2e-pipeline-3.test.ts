import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FsStore,
  factsPrefix,
  reportKey,
  setupStateKey,
  verdictsPrefix,
} from "@rightmodeler/core";
import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterAll, describe, expect, it } from "vitest";

import { listApprovedSwapSets } from "./pipeline.js";
import {
  allFileText,
  demoGraphPath,
  execFileAsync,
  fixtureCopy,
  jsonOutput,
  lastStderrEvent,
  minimumHoldout,
  narrowDemoFixtureForApply,
  readStageArtifact,
  removeExecutionFacts,
  removeTemporaryDirectories,
  renamedModelFixture,
  runCli,
  secret,
  startEvaluatorStub,
  startGithubStub,
  startStub,
  startUnpricedCatalogStub,
  storeText,
  temporaryDirectories,
  tracesPath,
  waitForTerminalRun,
  warningMessages,
  writeToolCallTraces,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

describe("built CLI pipeline", () => {
  it("abstains a family whose recorded cases are all unsendable on the holdout floor", async () => {
    const { root, repo } = await fixtureCopy("all-unsendable-cases");
    const traces = await writeToolCallTraces(root, 70);

    const result = await runCli([
      "init",
      "--through",
      "shortlist",
      "--traces",
      traces,
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code, result.stderr).toBe(0);
    const warnings = warningMessages(
      result.stderr,
      "recorded_messages_not_replayable",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Family summarize: 70 of 70");
    const shortlist = await readStageArtifact(
      join(repo, ".rightmodeler"),
      "shortlist",
    );
    expect(shortlist.familyPlans).toContainEqual(
      expect.objectContaining({
        familyId: "summarize",
        stepIds: [],
        leftOutCases: 70,
        abstainReason: {
          reason: "holdout_below_floor_minimum",
          observed: 0,
          required: minimumHoldout,
        },
      }),
    );
  });

  it("judges each call site of a mixed-vendor family outside that call site's model family", async () => {
    const { root, repo } = await fixtureCopy("mixed-vendor");
    const traces = await narrowDemoFixtureForApply(root, repo, "zeta/judge-1");
    const stub = await startStub();
    const apiKeyEnv = "RIGHTMODELER_MIXED_VENDOR_API_KEY";
    const args = [
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
    ];

    try {
      const estimate = await runCli(["estimate", ...args], {
        env: { [apiKeyEnv]: secret },
      });
      expect(estimate.code, estimate.stderr).toBe(0);
      const projection = jsonOutput(estimate) as {
        candidateExecutions: number;
        judgeCalls: number;
        judgeCostUsd: number;
      };
      expect(projection).toMatchObject({
        candidateExecutions: 105,
        judgeCalls: 210,
      });
      expect(projection.judgeCostUsd).toBeCloseTo(0.947028, 6);
      expect(stub.getHitCount()).toBe(0);

      const result = await runCli(["init", ...args], {
        env: { [apiKeyEnv]: secret },
      });
      expect([0, 1], result.stderr).toContain(result.code);
      const verdicts = jsonOutput(result).verdicts as Array<{
        familyId: string;
        evaluatorKinds: Array<{ nDistinctSteps: number }>;
      }>;
      expect(
        verdicts
          .find(({ familyId }) => familyId === "summarize")
          ?.evaluatorKinds.map(({ nDistinctSteps }) => nDistinctSteps),
      ).toEqual([2]);

      const pathByStep = new Map(
        scan(repo, createMatcherRegistry(), "project").map(
          ({ stepId, callSite }) => [stepId, callSite.path],
        ),
      );
      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      const pathByExecution = new Map(
        facts
          .filter(
            ({ executionId, caseId }) =>
              typeof executionId === "string" && typeof caseId === "string",
          )
          .map(({ executionId, stepId }) => [
            executionId as string,
            pathByStep.get(stepId as string)!,
          ]),
      );
      const assessments = facts.filter(
        ({ assessmentId }) => typeof assessmentId === "string",
      );
      expect(assessments).toHaveLength(pathByExecution.size);
      const judges: Record<string, string[]> = {};
      for (const { executionId, evaluatorId } of assessments) {
        const path = pathByExecution.get(executionId as string)!;
        judges[path] = [
          ...new Set([...(judges[path] ?? []), evaluatorId as string]),
        ];
      }
      expect(judges).toEqual({
        "src/summarize.ts": ["zeta/judge-1"],
        "src/extract.ts": ["yotta/judge-2"],
      });
    } finally {
      await stub.close();
    }
  });

  it("keeps one external experiment per split for a mixed-vendor family", async () => {
    const { root, repo } = await fixtureCopy("mixed-vendor-external");
    const traces = await narrowDemoFixtureForApply(root, repo, "zeta/judge-1");
    const modelStub = await startStub();
    const evaluatorStub = await startEvaluatorStub();

    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${modelStub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--evaluator",
          "braintrust",
          "--evaluator-base-url",
          `http://127.0.0.1:${evaluatorStub.port}`,
          "--evaluator-api-key-env",
          "RIGHTMODELER_E2E_EVALUATOR_KEY",
          "--evaluator-project-id",
          "00000000-0000-4000-8000-000000000001",
          "--evaluator-scorer",
          "output_similarity",
          "--evaluator-gate-threshold",
          "0.8",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        {
          env: {
            RIGHTMODELER_E2E_API_KEY: secret,
            RIGHTMODELER_E2E_EVALUATOR_KEY: "mixed-vendor-evaluator-key",
          },
        },
      );
      expect(result.code, result.stderr).toBe(0);
      const verdicts = jsonOutput(result).verdicts as Array<{
        familyId: string;
        evaluatorKinds: Array<{
          evaluatorKind: string;
          nDistinctSteps: number;
        }>;
      }>;
      expect(
        verdicts.find(({ familyId }) => familyId === "summarize")
          ?.evaluatorKinds,
      ).toEqual([
        expect.objectContaining({
          evaluatorKind: "braintrust",
          nDistinctSteps: 2,
        }),
      ]);
      expect(evaluatorStub.getHitCount("POST", "/v1/experiment")).toBe(1);
    } finally {
      await Promise.all([modelStub.close(), evaluatorStub.close()]);
    }
  });

  it("abstains and reports every family when shortlist evidence is entirely missing", async () => {
    const { repo } = await fixtureCopy("missing-shortlist-verdicts");
    const stub = await startStub();
    const baseArgs = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_MISSING_SHORTLIST_API_KEY",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const replay = await runCli([...baseArgs, "--through", "replay"], {
        env: { RIGHTMODELER_MISSING_SHORTLIST_API_KEY: secret },
      });
      expect(replay.code, replay.stderr).toBe(0);
      const storeRoot = join(repo, ".rightmodeler");
      await removeExecutionFacts(storeRoot, () => true);

      const result = await runCli(baseArgs, {
        env: { RIGHTMODELER_MISSING_SHORTLIST_API_KEY: secret },
      });

      expect(result.code, result.stderr).toBe(0);
      const output = jsonOutput(result);
      const families = output.familyOutcomes as Array<{
        decisionDisplay: string;
        effectiveRecommendation: boolean;
        verdict: { abstainReason?: Record<string, unknown> };
      }>;
      expect(families.length).toBeGreaterThan(0);
      expect(families).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            decisionDisplay: "abstain",
            effectiveRecommendation: false,
            verdict: expect.objectContaining({
              abstainReason: {
                reason: "selection_missing_shortlist_verdicts",
                observed: 0,
                required: expect.any(Number),
              },
            }),
          }),
        ]),
      );
      const report = await storeText(
        new FsStore(storeRoot),
        reportKey("project", "report.md"),
      );
      expect(report).toContain("selection_missing_shortlist_verdicts");
    } finally {
      await stub.close();
    }
  });

  it("warns and names catalog drift when every family step lacks its current model", async () => {
    const { repo } = await fixtureCopy("shortlist-catalog-drift");
    const stub = await startStub({
      omitCatalogModels: ["acme/large-1"],
    });
    const apiKeyEnv = "RIGHTMODELER_SHORTLIST_CATALOG_DRIFT_API_KEY";
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
          "jsonl",
          "--repo",
          repo,
        ],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const warnings = events.filter(({ event }) => event === "warning");
      expect(warnings).toEqual([
        {
          event: "warning",
          code: "shortlist_current_model_absent",
          message:
            "Family summarize: Current model is absent from the provider catalog: acme/large-1",
        },
      ]);
      const resultEvent = events.find(({ event }) => event === "result");
      const resultValue = resultEvent?.result as
        | {
            familyOutcomes?: Array<{
              familyId: string;
              verdict: {
                abstainReason?: { reason?: string };
              };
            }>;
          }
        | undefined;
      expect(resultValue?.familyOutcomes?.length).toBeGreaterThan(0);
      expect(
        resultValue?.familyOutcomes?.find(
          ({ familyId }) => familyId === "summarize",
        )?.verdict.abstainReason?.reason,
      ).toBe("provider_catalog_drift");
      expect(
        resultValue?.familyOutcomes?.find(
          ({ familyId }) => familyId === "support",
        )?.verdict.abstainReason?.reason,
      ).toBe("ambiguous_call_site_binding");
    } finally {
      await stub.close();
    }
  });

  it("forwards catalog truncation warnings during estimates", async () => {
    const { repo } = await fixtureCopy("catalog-truncated");
    const stub = await startStub({ catalogTotalCount: 99 });
    const apiKeyEnv = "RIGHTMODELER_CATALOG_TRUNCATED_API_KEY";
    try {
      const result = await runCli(
        [
          "estimate",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
          "--output",
          "jsonl",
          "--repo",
          repo,
        ],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "warning",
          code: "catalog_truncated",
        }),
      );
    } finally {
      await stub.close();
    }
  });

  it("resolves a bare recorded model id against the provider catalog", async () => {
    const { repo } = await fixtureCopy("shortlist-model-resolution");
    await Promise.all(
      [
        "summarize.ts",
        "summarize-stream.ts",
        "extract.ts",
        "triage.py",
        "support.py",
      ].map(async (name) => {
        const path = join(repo, "src", name);
        await writeFile(
          path,
          (await readFile(path, "utf8")).replaceAll("acme/large-1", "large-1"),
        );
      }),
    );
    const tracesDirectory = await mkdtemp(
      join(tmpdir(), "rightmodeler-bare-model-"),
    );
    temporaryDirectories.push(tracesDirectory);
    const traces = join(tracesDirectory, "otel-genai.json");
    await writeFile(
      traces,
      (await readFile(tracesPath, "utf8")).replaceAll(
        "acme/large-1",
        "large-1",
      ),
    );
    const stub = await startStub();
    const apiKeyEnv = "RIGHTMODELER_MODEL_RESOLUTION_API_KEY";
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
          "--output",
          "jsonl",
          "--repo",
          repo,
        ],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      const warnings = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(({ event }) => event === "warning");
      const resolved = warnings.find(
        ({ code }) => code === "shortlist_current_model_resolved",
      );
      expect(resolved?.message).toContain("large-1");
      expect(resolved?.message).toContain("acme/large-1");
      expect(warnings).not.toContainEqual(
        expect.objectContaining({ code: "shortlist_current_model_absent" }),
      );
    } finally {
      await stub.close();
    }
  });

  it("stops before any spend when bare model ids cannot name the judge's vendor", async () => {
    const { repo, traces } = await renamedModelFixture(
      "bare-judge-vendor",
      "large-1",
    );
    const stub = await startStub({ bareModelIds: true });
    const apiKeyEnv = "RIGHTMODELER_BARE_JUDGE_API_KEY";
    try {
      for (const command of [
        ["estimate"],
        ["init", "--through", "aggregate"],
      ]) {
        const result = await runCli(
          [
            ...command,
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

        expect(result.code, result.stderr).toBe(2);
        const error = lastStderrEvent(result);
        expect(error.code, command[0]).toBe("judge_family_unknown");
        expect(error.message, command[0]).toContain("large-1");
      }
      expect(stub.getHitCount()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("names the missing neutral judge before any spend", async () => {
    const { repo } = await fixtureCopy("no-neutral-judge");
    const stub = await startStub({
      omitCatalogModels: ["zeta/judge-1", "yotta/judge-2"],
    });
    const apiKeyEnv = "RIGHTMODELER_NO_NEUTRAL_JUDGE_API_KEY";
    try {
      for (const command of [
        ["estimate"],
        ["init", "--through", "aggregate"],
      ]) {
        const result = await runCli(
          [
            ...command,
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

        expect(result.code, result.stderr).toBe(2);
        const error = lastStderrEvent(result);
        expect(error.code, command[0]).toBe("no_neutral_judge");
        expect(error.message, command[0]).toContain(
          "the candidates come from acme and the recorded model from acme",
        );
      }
      expect(stub.getHitCount()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("checks the fallback judge's vendor before any spend when the external evaluator is unreachable", async () => {
    const { repo, traces } = await renamedModelFixture(
      "fallback-judge-vendor",
      "large-1",
    );
    const stub = await startStub({ bareModelIds: true });
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "aggregate",
          "--traces",
          traces,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
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

      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain(
        '"code":"external_evaluator_unreachable"',
      );
      expect(lastStderrEvent(result).code).toBe("judge_family_unknown");
      expect(stub.getHitCount()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("refuses an unpriced catalog until a pricing file is supplied", async () => {
    const { root, repo } = await fixtureCopy("unpriced-catalog");
    const stub = await startUnpricedCatalogStub();
    const apiKeyEnv = "RIGHTMODELER_UNPRICED_CATALOG_API_KEY";
    const baseArgs = [
      "estimate",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      "--repo",
      repo,
    ];
    try {
      const unpriced = await runCli([...baseArgs, "--output", "jsonl"], {
        env: { [apiKeyEnv]: secret },
      });

      expect(unpriced.code).toBe(2);
      expect(JSON.parse(unpriced.stderr)).toMatchObject({
        code: "no_priced_candidates",
        remedy: expect.stringContaining("--pricing-file"),
      });

      const pricingFile = join(root, "pricing.json");
      await writeFile(
        pricingFile,
        JSON.stringify({
          "acme/large-1": { input: 0.000001, output: 0.000003 },
          "acme/small-1": { input: 0.0000002, output: 0.0000008 },
          "zeta/judge-1": { input: 0.000004, output: 0.000012 },
        }),
      );
      const priced = await runCli(
        [...baseArgs, "--pricing-file", pricingFile, "--output", "json"],
        { env: { [apiKeyEnv]: secret } },
      );

      expect(priced.code, priced.stderr).toBe(0);
      expect(jsonOutput(priced).candidateExecutions).not.toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("abstains when one candidate is missing its shortlist verdict", async () => {
    const { repo } = await fixtureCopy("missing-candidate-verdict");
    const stub = await startStub();
    const baseArgs = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_MISSING_CANDIDATE_API_KEY",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const replay = await runCli([...baseArgs, "--through", "replay"], {
        env: { RIGHTMODELER_MISSING_CANDIDATE_API_KEY: secret },
      });
      expect(replay.code, replay.stderr).toBe(0);
      const storeRoot = join(repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      const executions = await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) => ({
          key,
          fact: JSON.parse(await storeText(store, key)) as Record<
            string,
            unknown
          >,
        })),
      );
      const confirmedCandidate = executions.find(
        ({ fact }) =>
          typeof fact.executionId === "string" &&
          fact.corpusSplit === "holdout" &&
          typeof fact.candidateId === "string",
      )?.fact.candidateId;
      expect(confirmedCandidate).toEqual(expect.any(String));
      await removeExecutionFacts(
        storeRoot,
        (execution) =>
          execution.corpusSplit === "shortlist" &&
          execution.candidateId === confirmedCandidate,
      );

      const result = await runCli(baseArgs, {
        env: { RIGHTMODELER_MISSING_CANDIDATE_API_KEY: secret },
      });

      expect(result.code, result.stderr).toBe(0);
      const output = jsonOutput(result);
      expect(output.familyOutcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            decisionDisplay: "abstain",
            effectiveRecommendation: false,
            verdict: expect.objectContaining({
              abstainReason: {
                reason: "selection_candidate_verdict_missing",
                observed: expect.any(Number),
                required: expect.any(Number),
              },
            }),
          }),
        ]),
      );
      const report = await storeText(store, reportKey("project", "report.md"));
      expect(report).toContain("selection_candidate_verdict_missing");
      expect(report).toContain("## Blocked families");
      expect(report).toContain("insufficient-evidence");
      expect(report).toContain("collect-evidence");
    } finally {
      await stub.close();
    }
  });

  it("reports only the case whose evaluator evidence is missing", async () => {
    const { repo } = await fixtureCopy("missing-evaluator-evidence");
    const stub = await startStub();
    const baseArgs = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_MISSING_EVIDENCE_API_KEY",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const replay = await runCli([...baseArgs, "--through", "replay"], {
        env: { RIGHTMODELER_MISSING_EVIDENCE_API_KEY: secret },
      });
      expect(replay.code, replay.stderr).toBe(0);
      const storeRoot = join(repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      const facts = await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) => ({
          key,
          fact: JSON.parse(await storeText(store, key)) as Record<
            string,
            unknown
          >,
        })),
      );
      const executions = new Map(
        facts.flatMap(({ fact }) =>
          typeof fact.executionId === "string" &&
          typeof fact.terminalOutcome === "string"
            ? [[fact.executionId, fact] as const]
            : [],
        ),
      );
      const target = facts.find(({ fact }) => {
        if (
          typeof fact.assessmentId !== "string" ||
          typeof fact.executionId !== "string"
        ) {
          return false;
        }
        return executions.get(fact.executionId)?.corpusSplit === "holdout";
      });
      expect(target).toBeDefined();
      if (target === undefined || typeof target.fact.executionId !== "string") {
        throw new Error("Missing holdout assessment fixture");
      }
      const targetExecution = executions.get(target.fact.executionId);
      if (typeof targetExecution?.caseId !== "string") {
        throw new Error("Missing holdout execution fixture");
      }
      const targetCaseId = targetExecution.caseId;
      await rm(join(storeRoot, ".rightmodeler-store", "entries", target.key), {
        recursive: true,
      });

      const result = await runCli(baseArgs, {
        env: { RIGHTMODELER_MISSING_EVIDENCE_API_KEY: secret },
      });

      expect(result.code, result.stderr).toBe(0);
      const reportJson = JSON.parse(
        await storeText(store, reportKey("project", "report.json")),
      ) as {
        families: Array<{
          familyId: string;
          verdict: { caseIds: string[] };
        }>;
        blockedFamilies: Array<{
          familyId: string;
          diagnosis: {
            issueClass: string;
            triggerCaseIds: string[];
          };
        }>;
      };
      const family = reportJson.families.find(({ verdict }) =>
        verdict.caseIds.includes(targetCaseId),
      );
      expect(family?.verdict.caseIds.length).toBeGreaterThan(1);
      expect(
        reportJson.blockedFamilies.find(
          ({ familyId }) => familyId === family?.familyId,
        )?.diagnosis,
      ).toEqual(
        expect.objectContaining({
          issueClass: "insufficient-evidence",
          triggerCaseIds: [targetCaseId],
        }),
      );
    } finally {
      await stub.close();
    }
  });

  it("blocks only affected families when operational replay cells cannot complete", async () => {
    const { repo } = await fixtureCopy("replay-operational-block");
    const stub = await startStub({
      rateLimitMessageIncludes: "Fixture bulletin",
    });
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_BLOCKED_REPLAY_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_BLOCKED_REPLAY_API_KEY: secret } },
      );

      expect(result.code, result.stderr).toBe(0);
      const output = jsonOutput(result);
      const families = output.familyOutcomes as Array<{
        familyId: string;
        verdict: { abstainReason?: { reason?: string } };
      }>;
      expect(
        families
          .filter(
            ({ verdict }) =>
              verdict.abstainReason?.reason === "replay_operational_block",
          )
          .map(({ familyId }) => familyId),
      ).toEqual(["summarize"]);
      expect(
        families.find(({ familyId }) => familyId === "summarize")?.verdict
          .abstainReason,
      ).toMatchObject({
        reason: "replay_operational_block",
        observed: expect.any(Number),
        required: 0,
      });
      expect(
        families.find(({ familyId }) => familyId === "support")?.verdict
          .abstainReason?.reason,
      ).toBe("ambiguous_call_site_binding");
      const report = await storeText(
        new FsStore(join(repo, ".rightmodeler")),
        reportKey("project", "report.md"),
      );
      expect(report).toContain("replay_operational_block");
      expect(report).toContain("## Blocked families");
      expect(report).toContain("replay");
      expect(report).toContain("fix-replay");
    } finally {
      await stub.close();
    }
  });

  it("runs from the demo scan corpus to one idempotent draft pull request", async () => {
    const { root, repo } = await fixtureCopy("apply");
    const filteredTraces = await narrowDemoFixtureForApply(root, repo);
    const provider = await startStub();
    const githubToken = "github-e2e-token";
    const github = await startGithubStub(githubToken);
    const githubBaseUrl = `http://127.0.0.1:${github.port}`;
    const head = (
      await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    const summarizeSource = await readFile(
      join(repo, "src", "summarize.ts"),
      "utf8",
    );
    const extractSource = await readFile(
      join(repo, "src", "extract.ts"),
      "utf8",
    );
    const control = (path: string, body: Record<string, unknown>) =>
      fetch(`${githubBaseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${githubToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const seed = () =>
      control("/__test/seed", {
        owner: "acme",
        repo: "demo-app",
        defaultBranch: "main",
        sha: head,
        tree: {
          src: {
            "extract.ts": extractSource,
            "summarize.ts": summarizeSource,
          },
        },
      });
    expect((await seed()).status).toBe(201);

    const initArgs = [
      "init",
      "--traces",
      filteredTraces,
      "--base-url",
      `http://127.0.0.1:${provider.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_APPLY_E2E_API_KEY",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const applyArgs = [
      "apply",
      "--owner",
      "acme",
      "--github-repo",
      "demo-app",
      "--github-base-url",
      githubBaseUrl,
      "--github-token-env",
      "RIGHTMODELER_GITHUB_E2E_TOKEN",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const watchArgs = [
      "watch",
      "--owner",
      "acme",
      "--github-repo",
      "demo-app",
      "--pr",
      "1",
      "--github-base-url",
      githubBaseUrl,
      "--github-token-env",
      "RIGHTMODELER_GITHUB_E2E_TOKEN",
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const env = {
      RIGHTMODELER_APPLY_E2E_API_KEY: secret,
      RIGHTMODELER_GITHUB_E2E_TOKEN: githubToken,
    };

    try {
      const initialized = await runCli(initArgs, { env });
      expect(initialized.code, initialized.stdout).toBe(1);
      const initializedOutput = jsonOutput(initialized);
      expect(initializedOutput).toMatchObject({ recommendationExists: true });
      const recommended = (
        initializedOutput.verdicts as Array<{
          decision: string;
          caseIds: string[];
          familyId: string;
          candidateId: string;
        }>
      ).find(({ decision }) => decision === "recommend");
      expect(recommended?.caseIds.length).toBeGreaterThan(0);

      const dryRun = await runCli([...applyArgs, "--dry-run"], { env });
      expect(dryRun.code).toBe(0);
      expect(jsonOutput(dryRun)).toMatchObject({ status: "dry_run" });
      const preview = jsonOutput(dryRun);
      const graphDryRun = await runCli(
        [...applyArgs, "--dry-run", "--code-graph", demoGraphPath],
        { env },
      );
      expect(graphDryRun.code).toBe(0);
      expect(graphDryRun.stderr).toContain('"code":"code_graph_stale"');
      const graphPreview = JSON.parse(graphDryRun.stdout) as Record<
        string,
        unknown
      >;
      for (const field of [
        "runSpecDigest",
        "branch",
        "title",
        "files",
        "reviewers",
        "teamReviewers",
      ]) {
        expect(graphPreview[field]).toEqual(preview[field]);
      }
      expect(String(graphPreview.body).startsWith(String(preview.body))).toBe(
        true,
      );
      expect(String(graphPreview.body)).toContain("## Code context (Graphify)");
      expect(String(graphPreview.body)).toContain("Stale: built at");
      expect(String(preview.body)).not.toContain("## Code context");
      expect(
        github
          .getHits()
          .filter(
            ({ method, path }) =>
              !path.startsWith("/__test/") &&
              ["POST", "PUT", "PATCH", "DELETE"].includes(method),
          ),
      ).toEqual([]);

      expect(
        (
          await control("/__test/advance-base", {
            owner: "acme",
            repo: "demo-app",
            branch: "main",
            tree: {},
          })
        ).status,
      ).toBe(200);
      const refused = await runCli(applyArgs, { env });
      expect(refused.code).toBe(1);
      expect(jsonOutput(refused)).toMatchObject({
        status: "refused",
        reasons: [expect.objectContaining({ code: "stale_evidence" })],
      });
      expect((await seed()).status).toBe(201);

      const applied = await runCli(applyArgs, { env });
      expect(applied.code).toBe(0);
      expect(jsonOutput(applied)).toMatchObject({
        status: "applied",
        prNumber: 1,
        teamReviewers: ["models"],
      });

      const pullWrites = () =>
        github
          .getHits()
          .filter(
            ({ method, path }) =>
              method === "POST" && path === "/repos/acme/demo-app/pulls",
          );
      expect(pullWrites()).toHaveLength(1);
      const pullBody = pullWrites()[0]?.body as
        Record<string, unknown> | undefined;
      expect(pullBody).toMatchObject({ draft: true, base: "main" });
      expect(String(pullBody?.body)).toContain("## Summary");
      expect(String(pullBody?.body)).toContain("## Rightmodeler evidence");
      expect(String(pullBody?.body)).toMatch(
        new RegExp(
          `^\\| ${recommended!.familyId} \\|(?: [^|\\n]* \\|){6} \\$\\d+\\.\\d{6} \\| \\$\\d+\\.\\d{6} \\| [+-]\\d+\\.\\d% \\| \\d+ ms \\|`,
          "m",
        ),
      );
      expect(String(pullBody?.body)).toContain(recommended!.caseIds[0]!);
      expect(String(pullBody?.body)).not.toContain(
        "The city opened two cooling centers",
      );

      const repeated = await runCli(applyArgs, { env });
      expect(repeated.code).toBe(0);
      expect(jsonOutput(repeated)).toMatchObject({
        status: "existing",
        prNumber: 1,
      });
      expect(pullWrites()).toHaveLength(1);

      const projectStore = new FsStore(join(repo, ".rightmodeler"));
      const watchLockKey = `project/watch-locks/${createHash("sha256")
        .update("acme/demo-app")
        .digest("hex")}/pr-1.json`;
      expect(
        await projectStore.compareAndSwap(
          watchLockKey,
          0,
          Buffer.from(
            JSON.stringify({
              status: "held",
              ownerId: "competing-watch",
              lockedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
            }),
            "utf8",
          ),
          1,
        ),
      ).toBe(true);
      const hitsBeforeContention = github.getHits().length;
      const contendedWatch = await runCli(watchArgs, { env });
      expect(contendedWatch.code).toBe(2);
      expect(jsonOutput(contendedWatch)).toMatchObject({
        status: "lock_held",
        actions: [],
      });
      expect(github.getHits()).toHaveLength(hitsBeforeContention);
      const heldLock = await projectStore.get(watchLockKey);
      expect(heldLock).not.toBeNull();
      expect(
        await projectStore.compareAndSwap(
          watchLockKey,
          heldLock!.version,
          Buffer.from(JSON.stringify({ status: "available" }), "utf8"),
          heldLock!.fenceToken + 1,
        ),
      ).toBe(true);

      expect(
        (
          await control("/__test/merge", {
            owner: "acme",
            repo: "demo-app",
            pullNumber: 1,
          })
        ).status,
      ).toBe(200);
      const watched = await runCli(watchArgs, { env });
      expect(watched.code).toBe(1);
      expect(jsonOutput(watched)).toMatchObject({
        status: "actions_taken",
        phase: "ended",
        actions: [
          expect.objectContaining({ type: "pr_merged" }),
          expect.objectContaining({ type: "watch_ended" }),
        ],
      });
      const approved = await listApprovedSwapSets({ repo });
      expect(approved).toHaveLength(1);
      expect(approved[0]).toMatchObject({
        prNumber: 1,
        familyIds: [recommended!.familyId],
        swaps: expect.arrayContaining([
          expect.objectContaining({
            familyId: recommended!.familyId,
            toModel: recommended!.candidateId,
          }),
        ]),
      });
      const hitsAfterMerge = github.getHits().length;
      const quietWatch = await runCli(watchArgs, { env });
      expect(quietWatch.code).toBe(0);
      expect(jsonOutput(quietWatch)).toMatchObject({ status: "quiet" });
      expect(github.getHits()).toHaveLength(hitsAfterMerge);

      const afterMerge = await runCli(applyArgs, { env });
      expect(afterMerge.code).toBe(0);
      expect(jsonOutput(afterMerge)).toMatchObject({
        status: "existing",
        prNumber: 1,
        reviewers: [],
        teamReviewers: ["models"],
      });
      expect(pullWrites()).toHaveLength(1);

      const report = await runCli([
        "report",
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(report.code).toBe(1);
      expect(jsonOutput(report).apply).toEqual([
        expect.objectContaining({
          repo: "acme/demo-app",
          prNumber: 1,
          state: "watch_ended",
          eventCount: 5,
        }),
      ]);
      const reportMarkdown = await storeText(
        new FsStore(join(repo, ".rightmodeler")),
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("## Apply");
      expect(reportMarkdown).toMatch(
        new RegExp(
          `^\\| ${recommended!.familyId} \\| \\$\\d+\\.\\d{6} \\| \\$\\d+\\.\\d{6} \\| [+-]\\d+\\.\\d% \\| \\d+ ms \\|$`,
          "m",
        ),
      );

      const rejectingOwner = "acme-reject";
      expect(
        (
          await control("/__test/seed", {
            owner: rejectingOwner,
            repo: "demo-app",
            defaultBranch: "main",
            sha: head,
            tree: {
              src: {
                "extract.ts": extractSource,
                "summarize.ts": summarizeSource,
              },
            },
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await control(`/repos/${rejectingOwner}/demo-app/git/refs`, {
            ref: "refs/heads/dummy",
            sha: head,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await control(`/repos/${rejectingOwner}/demo-app/pulls`, {
            title: "Reserve pull number",
            body: "Fixture setup",
            head: "dummy",
            base: "main",
            draft: true,
          })
        ).status,
      ).toBe(201);
      const rejectingApplyArgs = applyArgs.map((argument, index) =>
        applyArgs[index - 1] === "--owner" ? rejectingOwner : argument,
      );
      const rejectingWatchArgs = watchArgs.map((argument, index) => {
        if (watchArgs[index - 1] === "--owner") return rejectingOwner;
        if (watchArgs[index - 1] === "--pr") return "2";
        return argument;
      });
      const rejectionCandidate = await runCli(rejectingApplyArgs, { env });
      expect(rejectionCandidate.code).toBe(0);
      expect(jsonOutput(rejectionCandidate)).toMatchObject({
        status: "applied",
        prNumber: 2,
      });
      expect(
        (
          await control("/__test/close", {
            owner: rejectingOwner,
            repo: "demo-app",
            pullNumber: 2,
          })
        ).status,
      ).toBe(200);
      const rejectedWatch = await runCli(rejectingWatchArgs, { env });
      expect(rejectedWatch.code).toBe(1);
      expect(jsonOutput(rejectedWatch)).toMatchObject({
        status: "actions_taken",
        phase: "ended",
      });
      const reappliedRejection = await runCli(rejectingApplyArgs, { env });
      expect(reappliedRejection.code).toBe(1);
      expect(jsonOutput(reappliedRejection)).toMatchObject({
        status: "refused",
        reasons: [
          expect.objectContaining({
            code: "previously_rejected",
            detail: expect.objectContaining({ prNumber: 2 }),
          }),
        ],
      });
      expect(
        github
          .getHits()
          .filter(
            ({ method, path }) =>
              method === "POST" &&
              path === `/repos/${rejectingOwner}/demo-app/pulls`,
          ),
      ).toHaveLength(2);

      const setupBeforeReproof = JSON.parse(
        await storeText(projectStore, setupStateKey("project")),
      ) as {
        stages: { shortlist: { inputDigest: string } };
      };
      const verdictKeys = await projectStore.list(verdictsPrefix("project"));
      expect(verdictKeys.length).toBeGreaterThan(0);
      const verdictEntry = await projectStore.get(verdictKeys[0]!);
      expect(verdictEntry).not.toBeNull();
      const verdictValue = JSON.parse(
        Buffer.from(verdictEntry!.body).toString("utf8"),
      ) as Record<string, unknown>;
      expect(
        await projectStore.compareAndSwap(
          verdictKeys[0]!,
          verdictEntry!.version,
          Buffer.from(
            JSON.stringify({
              ...verdictValue,
              reproof_requested: true,
              reproof_request_ids: ["review:reproof-fixture"],
            }),
            "utf8",
          ),
          verdictEntry!.fenceToken,
        ),
      ).toBe(true);
      const providerHitsBeforeReproof = provider.getHitCount();

      const reproof = await runCli(initArgs, { env });

      expect(reproof.code).toBe(1);
      expect(provider.getHitCount()).toBeGreaterThan(providerHitsBeforeReproof);
      const setupAfterReproof = JSON.parse(
        await storeText(projectStore, setupStateKey("project")),
      ) as {
        stages: { shortlist: { inputDigest: string } };
      };
      expect(setupAfterReproof.stages.shortlist.inputDigest).not.toBe(
        setupBeforeReproof.stages.shortlist.inputDigest,
      );
      expect(
        JSON.parse(await storeText(projectStore, verdictKeys[0]!)),
      ).toMatchObject({
        reproof_requested: false,
        reproof_request_ids: ["review:reproof-fixture"],
      });

      for (const swap of approved[0]!.swaps) {
        const path = join(repo, swap.path);
        const before = await readFile(path, "utf8");
        const after = before.replace(swap.fromModel, swap.toModel);
        expect(after).not.toBe(before);
        await writeFile(path, after);
      }
      await execFileAsync("git", ["-C", repo, "add", "."]);
      await execFileAsync("git", [
        "-C",
        repo,
        "commit",
        "--message",
        "Apply approved swaps",
      ]);
      const regressionOptions = [
        "--traces",
        filteredTraces,
        "--base-url",
        `http://127.0.0.1:${provider.port}/v1`,
        "--api-key-env",
        "RIGHTMODELER_APPLY_E2E_API_KEY",
        "--approved-run",
        approved[0]!.runSpecDigest,
      ];
      const regressionEstimate = await runCli(
        ["--repo", repo, "--output", "json", "estimate", ...regressionOptions],
        { env },
      );
      expect(regressionEstimate.code, regressionEstimate.stderr).toBe(0);
      expect(jsonOutput(regressionEstimate)).toMatchObject({
        candidateExecutions: expect.any(Number),
        shortlist: expect.arrayContaining([
          expect.objectContaining({
            candidateIds: [recommended!.candidateId],
          }),
        ]),
      });
      const providerHitsBeforeRegression = provider.getHitCount();
      const regression = await runCli(
        [
          "--repo",
          repo,
          "--output",
          "json",
          "replay",
          ...regressionOptions,
          "--detach",
        ],
        { env },
      );
      expect(regression.code, regression.stderr).toBe(0);
      const regressionRunId = String(jsonOutput(regression).runId);
      await expect(
        waitForTerminalRun(repo, join(repo, ".rightmodeler"), regressionRunId),
      ).resolves.toMatchObject({
        phase: "aggregate",
        status: "completed",
        progress: { completed: 9, total: 9 },
      });
      expect(provider.getHitCount()).toBeGreaterThan(
        providerHitsBeforeRegression,
      );
    } finally {
      await Promise.all([provider.close(), github.close()]);
    }
  }, 900_000);

  it("prefers a reachable external evaluator, persists every metric, and makes zero judge calls", async () => {
    const { repo } = await fixtureCopy("external-evaluator");
    const modelStub = await startStub();
    const evaluatorStub = await startEvaluatorStub();
    const evaluatorSecret = "external-evaluator-key-must-not-persist";
    const args = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${modelStub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_E2E_API_KEY",
      "--evaluator",
      "braintrust",
      "--evaluator-base-url",
      `http://127.0.0.1:${evaluatorStub.port}`,
      "--evaluator-api-key-env",
      "RIGHTMODELER_E2E_EVALUATOR_KEY",
      "--evaluator-project-id",
      "00000000-0000-4000-8000-000000000001",
      "--evaluator-scorer",
      "output_similarity",
      "--evaluator-scorer",
      "secondary_similarity",
      "--evaluator-gate-metric",
      "output_similarity",
      "--evaluator-gate-threshold",
      "0.8",
      "--output",
      "json",
      "--repo",
      repo,
    ];

    try {
      const first = await runCli(args, {
        env: {
          RIGHTMODELER_E2E_API_KEY: secret,
          RIGHTMODELER_E2E_EVALUATOR_KEY: evaluatorSecret,
        },
      });
      expect(first.code).toBe(0);
      const output = jsonOutput(first);
      const verdicts = output.verdicts as Array<{
        evaluatorKinds: Array<{ evaluatorKind: string }>;
      }>;
      expect(
        verdicts.flatMap(({ evaluatorKinds }) =>
          evaluatorKinds.map(({ evaluatorKind }) => evaluatorKind),
        ),
      ).toEqual(expect.arrayContaining(["braintrust"]));

      const storeRoot = join(repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      const executions = facts.filter(
        (fact) =>
          typeof fact.executionId === "string" &&
          typeof fact.candidateId === "string",
      );
      const attempts = facts.filter(
        (fact) =>
          typeof fact.attemptId === "string" &&
          typeof fact.logicalCallId === "string",
      );
      const assessments = facts.filter(
        (fact) =>
          typeof fact.assessmentId === "string" &&
          fact.evaluatorId === "braintrust",
      );
      expect(assessments).toHaveLength(executions.length * 2);
      expect(new Set(assessments.map(({ metricName }) => metricName))).toEqual(
        new Set(["output_similarity", "secondary_similarity"]),
      );
      expect(
        assessments.every(
          ({ rubricVersion }) => rubricVersion === "threshold:0.8",
        ),
      ).toBe(true);
      expect(
        facts.some((fact) => "actor" in fact && fact.actor === "judge"),
      ).toBe(false);
      expect(modelStub.getHitCount()).toBe(attempts.length);
      expect(
        evaluatorStub.getHitCount("POST", "/v1/experiment"),
      ).toBeGreaterThan(0);
      expect(evaluatorStub.getHitCount("GET", "/v1/project")).toBeGreaterThan(
        0,
      );

      const reportMarkdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("braintrust:");
      expect(await allFileText(storeRoot)).not.toContain(evaluatorSecret);
      expect(reportMarkdown).not.toContain(evaluatorSecret);

      const modelHits = modelStub.getHitCount();
      const evaluatorHits = evaluatorStub.getHitCount("POST", "/v1/experiment");
      const resumed = await runCli(args, {
        env: {
          RIGHTMODELER_E2E_API_KEY: secret,
          RIGHTMODELER_E2E_EVALUATOR_KEY: evaluatorSecret,
        },
      });
      expect(resumed.code).toBe(0);
      expect(jsonOutput(resumed).executedStages).toEqual([]);
      expect(modelStub.getHitCount()).toBe(modelHits);
      expect(evaluatorStub.getHitCount("POST", "/v1/experiment")).toBe(
        evaluatorHits,
      );
    } finally {
      await Promise.all([modelStub.close(), evaluatorStub.close()]);
    }
  });

  it("names failed external assessments as absent without fabricating Assessment facts", async () => {
    const { repo } = await fixtureCopy("external-evaluator-failed");
    const modelStub = await startStub();
    const evaluatorStub = await startEvaluatorStub({ fail: true });
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
          `http://127.0.0.1:${evaluatorStub.port}`,
          "--evaluator-api-key-env",
          "RIGHTMODELER_E2E_EVALUATOR_KEY",
          "--evaluator-project-id",
          "00000000-0000-4000-8000-000000000001",
          "--evaluator-scorer",
          "output_similarity",
          "--evaluator-gate-threshold",
          "0.8",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        {
          env: {
            RIGHTMODELER_E2E_API_KEY: secret,
            RIGHTMODELER_E2E_EVALUATOR_KEY: "failed-evaluator-key",
          },
        },
      );
      expect(result.code).toBe(0);
      const output = jsonOutput(result);
      const verdicts = output.verdicts as Array<{
        familyId: string;
        assessmentAbsent: number;
        assessmentAbsentReasons: Array<{ reason: string; count: number }>;
        abstainReason?: { reason: string };
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
      ).toEqual(expect.arrayContaining(["external_experiment_failed"]));
      expect(
        verdicts.find(({ familyId }) => familyId === "support"),
      ).toMatchObject({
        assessmentAbsent: 0,
        abstainReason: { reason: "ambiguous_call_site_binding" },
      });

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
      await Promise.all([modelStub.close(), evaluatorStub.close()]);
    }
  });

  it("leaves candidates answered by another model out of the evidence as attribution_substituted", async () => {
    const { repo } = await fixtureCopy("substituted-candidates");
    const modelStub = await startStub({
      servedModels: {
        "acme/small-1": "acme/large-1",
        "acme/lite-1": "acme/large-1",
      },
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
          `http://127.0.0.1:${modelStub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );
      expect(result.code, result.stderr).toBe(0);
      const warnings = result.stderr
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, string>);
      const substitutedWarnings = warnings.filter(
        ({ code }) => code === "replay_responses_substituted",
      );
      expect(substitutedWarnings).toHaveLength(1);
      expect(substitutedWarnings[0]!.message).toContain("model ");
      expect(substitutedWarnings[0]!.message).toContain("--store");

      const verdicts = (JSON.parse(result.stdout) as Record<string, unknown>)
        .verdicts as Array<{
        familyId: string;
        assessmentAbsentReasons: Array<{ reason: string; count: number }>;
      }>;
      expect(
        verdicts
          .filter(({ familyId }) => familyId === "summarize")
          .flatMap(({ assessmentAbsentReasons }) =>
            assessmentAbsentReasons.map(({ reason }) => reason),
          ),
      ).toContain("attribution_substituted");

      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      const substitutedExecutions = facts.filter(
        (fact) =>
          typeof fact.executionId === "string" &&
          (fact.candidateId === "acme/small-1" ||
            fact.candidateId === "acme/lite-1"),
      );
      expect(substitutedExecutions.length).toBeGreaterThan(0);
      expect(
        substitutedExecutions.every(
          ({ attribution }) => attribution === "substituted",
        ),
      ).toBe(true);
      const substitutedIds = new Set(
        substitutedExecutions.map(({ executionId }) => executionId),
      );
      expect(
        facts.some(
          (fact) =>
            typeof fact.assessmentId === "string" &&
            substitutedIds.has(fact.executionId as string),
        ),
      ).toBe(false);
    } finally {
      await modelStub.close();
    }
  });

  it("sends --header values with catalog, replay and judge requests", async () => {
    const { repo } = await fixtureCopy("static-headers");
    const modelStub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--through",
          "replay",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${modelStub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--header",
          "x-rightmodeler-replay: 1",
          "--header",
          "x-route: e2e",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );
      expect(result.code, result.stderr).toBe(0);

      const received = modelStub.getRequestHeaders();
      const kinds = [
        received.filter(
          ({ method, path }) => method === "GET" && path === "/v1/models",
        ),
        received.filter(
          ({ model }) => model === "acme/small-1" || model === "acme/lite-1",
        ),
        received.filter(
          ({ model }) => model === "zeta/judge-1" || model === "yotta/judge-2",
        ),
      ];
      for (const requests of kinds) {
        expect(requests.length).toBeGreaterThan(0);
        for (const { headers } of requests) {
          expect(headers).toMatchObject({
            "x-rightmodeler-replay": "1",
            "x-route": "e2e",
          });
        }
      }
    } finally {
      await modelStub.close();
    }
  });
});
