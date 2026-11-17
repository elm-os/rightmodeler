import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  FsStore,
  computeRunSpecDigest,
  factsPrefix,
  reportKey,
  setupStateKey,
  type JsonValue,
} from "@rightmodeler/core";
import {
  judgeExecution,
  minimumTrialsForFloor,
  type JudgeChat,
} from "@rightmodeler/kernel";
import { createProvider } from "@rightmodeler/replay";
import { afterAll, describe, expect, it } from "vitest";

import {
  aiGatewayChatResponsePath,
  cliPath,
  demoAppPath,
  fixtureCopy,
  jsonOutput,
  lastStderrEvent,
  minimumHoldout,
  readStageArtifact,
  removeTemporaryDirectories,
  runCli,
  secret,
  startRenamedCatalogStub,
  startStub,
  startUnpricedCatalogStub,
  storeText,
  temporaryDirectories,
  traceFixtures,
  traceFixturesDir,
  tracesPath,
  utcDateDaysAgo,
  warningMessages,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

describe("built CLI pipeline", () => {
  it.each(traceFixtures)("runs %s through corpus", async (name) => {
    const { repo } = await fixtureCopy(`corpus-${name}`);
    const result = await runCli([
      "init",
      "--through",
      "corpus",
      "--traces",
      join(traceFixturesDir, name),
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code, result.stderr).toBe(0);
    for (const line of result.stderr.split("\n")) {
      if (line.trim() === "") continue;
      expect(JSON.parse(line)).toMatchObject({
        code: "trace_steps_excluded",
      });
    }
    expect(
      (JSON.parse(result.stdout) as Record<string, unknown>).executedStages,
    ).toEqual(["scan", "ingest", "reconcile", "scrub", "corpus"]);
    const corpus = await readStageArtifact(
      join(repo, ".rightmodeler"),
      "corpus",
    );
    expect(corpus.caseCount).toBeGreaterThan(0);
  });

  it("ingests a trace file Windows PowerShell 5.1 wrote, in UTF-16 with CRLF, like the original", async () => {
    const original = await readFile(tracesPath, "utf8");
    const runCounts: number[] = [];
    for (const [label, bytes] of [
      ["utf8-traces", Buffer.from(original)],
      [
        "utf16-traces",
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(original.replaceAll("\n", "\r\n"), "utf16le"),
        ]),
      ],
    ] as const) {
      const { root, repo } = await fixtureCopy(label);
      const traces = join(root, "otel-genai.json");
      await writeFile(traces, bytes);
      const result = await runCli([
        "init",
        "--through",
        "ingest",
        "--traces",
        traces,
        "--output",
        "json",
        "--repo",
        repo,
      ]);

      expect(result.code, result.stderr).toBe(0);
      const ingest = await readStageArtifact(
        join(repo, ".rightmodeler"),
        "ingest",
      );
      runCounts.push((ingest.runs as unknown[]).length);
    }
    expect(runCounts[0]).toBeGreaterThan(0);
    expect(runCounts[1]).toBe(runCounts[0]);
  });

  it("warns and keeps ingesting when a traced stream never finished", async () => {
    const { repo } = await fixtureCopy("stream-incomplete");
    const result = await runCli([
      "init",
      "--through",
      "ingest",
      "--traces",
      join(traceFixturesDir, "ai-sdk-v7-legacy.jsonl"),
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code, result.stderr).toBe(0);
    const warning = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(warning).toMatchObject({ code: "trace_steps_excluded" });
    expect(warning.message).toContain("stream_incomplete");
    expect(warning.message).toContain("1 traced model call");
    const ingest = await readStageArtifact(
      join(repo, ".rightmodeler"),
      "ingest",
    );
    expect(ingest.runs).toHaveLength(144);
  });

  it("names Envoy's failed and replay-tagged calls and keeps ingesting", async () => {
    const { repo } = await fixtureCopy("envoy-exclusions");
    const result = await runCli([
      "init",
      "--through",
      "ingest",
      "--traces",
      join(traceFixturesDir, "envoy-openinference.jsonl"),
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code, result.stderr).toBe(0);
    const warning = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(warning).toMatchObject({ code: "trace_steps_excluded" });
    expect(warning.message).toContain("1 call_failed");
    expect(warning.message).toContain("1 replay_traffic");
    const ingest = await readStageArtifact(
      join(repo, ".rightmodeler"),
      "ingest",
    );
    expect(
      (ingest.runs as Array<{ steps: unknown[] }>).flatMap(
        ({ steps }) => steps,
      ),
    ).toHaveLength(7);
  });

  it("names Bifrost's failed, fallback and replay rows and keeps ingesting", async () => {
    const { repo } = await fixtureCopy("bifrost-exclusions");
    const result = await runCli([
      "init",
      "--through",
      "ingest",
      "--traces",
      join(traceFixturesDir, "bifrost.jsonl"),
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code, result.stderr).toBe(0);
    const warning = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(warning).toMatchObject({ code: "trace_steps_excluded" });
    expect(warning.message).toContain("1 call_failed");
    expect(warning.message).toContain("1 fallback_answer");
    expect(warning.message).toContain("1 replay_traffic");
    const ingest = await readStageArtifact(
      join(repo, ".rightmodeler"),
      "ingest",
    );
    expect(ingest.format).toBe("bifrost");
  });

  it("ingests a trace directory like the equivalent single file", async () => {
    const records = JSON.parse(await readFile(tracesPath, "utf8")) as unknown[];
    const tracesDirectory = await mkdtemp(
      join(tmpdir(), "rightmodeler-trace-directory-"),
    );
    temporaryDirectories.push(tracesDirectory);
    await Promise.all([
      writeFile(
        join(tracesDirectory, "a.json"),
        JSON.stringify(records.slice(0, 40)),
      ),
      writeFile(
        join(tracesDirectory, "b.json"),
        JSON.stringify(records.slice(40)),
      ),
    ]);
    const { repo: directoryRepo } = await fixtureCopy("trace-directory");
    const { repo: singleRepo } = await fixtureCopy("trace-single-file");

    const directoryResult = await runCli([
      "init",
      "--through",
      "ingest",
      "--traces",
      tracesDirectory,
      "--output",
      "json",
      "--repo",
      directoryRepo,
    ]);
    const singleResult = await runCli([
      "init",
      "--through",
      "ingest",
      "--traces",
      tracesPath,
      "--output",
      "json",
      "--repo",
      singleRepo,
    ]);

    expect(directoryResult.code, directoryResult.stderr).toBe(0);
    expect(singleResult.code, singleResult.stderr).toBe(0);
    expect(jsonOutput(directoryResult).executedStages).toContain("ingest");
    expect(jsonOutput(singleResult).executedStages).toContain("ingest");
    const directoryRuns = (
      await readStageArtifact(join(directoryRepo, ".rightmodeler"), "ingest")
    ).runs;
    const singleRuns = (
      await readStageArtifact(join(singleRepo, ".rightmodeler"), "ingest")
    ).runs;
    expect(directoryRuns).toEqual(singleRuns);
    expect(directoryRuns).toBeInstanceOf(Array);
    expect((directoryRuns as unknown[]).length).toBeGreaterThan(1);

    const store = new FsStore(join(singleRepo, ".rightmodeler"));
    const state = JSON.parse(
      await storeText(store, setupStateKey("project")),
    ) as { stages: Record<string, { inputDigest: string }> };
    expect(state.stages.ingest!.inputDigest).toBe(
      computeRunSpecDigest({
        stage: "ingest",
        traceSha256: createHash("sha256")
          .update(await readFile(tracesPath))
          .digest("hex"),
        reader: "gateway-exclusions-v1",
      }),
    );
  });

  it("exports applySwaps from the bundled programmatic entry", async () => {
    const cli = (await import(pathToFileURL(cliPath).href)) as {
      applySwaps?: unknown;
    };
    expect(cli.applySwaps).toBeTypeOf("function");
  });

  it("uses deterministic judge output and exposes seeded position disagreement", async () => {
    const stub = await startStub();
    const apiKeyEnv = "RIGHTMODELER_JUDGE_E2E_API_KEY";
    process.env[apiKeyEnv] = secret;
    try {
      const provider = createProvider({
        providerId: "stub-provider",
        baseUrl: `http://127.0.0.1:${stub.port}/v1`,
        apiKeyEnv,
      });
      const chat: JudgeChat = async (request) =>
        provider.chat({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          ...(request.responseFormat === undefined
            ? {}
            : { responseFormat: request.responseFormat as JsonValue }),
        });

      const normal = await judgeExecution({
        chat,
        judgeModel: "zeta/judge-1",
        supportsStructuredOutput: true,
        task: "Summarize the recorded case.",
        reference: "Accepted summary",
        candidate: "Candidate summary",
      });
      const seeded = await judgeExecution({
        chat,
        judgeModel: "zeta/judge-1",
        supportsStructuredOutput: true,
        task: "STUB_JUDGE_DISAGREEMENT",
        reference: "Accepted summary",
        candidate: "Candidate summary",
      });

      expect(normal).toMatchObject({
        verdict: "equivalent",
        orderConsistent: true,
      });
      expect(seeded).toMatchObject({
        verdict: "minor_drift",
        orderConsistent: false,
      });
    } finally {
      delete process.env[apiKeyEnv];
      await stub.close();
    }
  });

  it("falls back from a systematically malformed judge without losing assessments", async () => {
    const { repo } = await fixtureCopy("judge-failover");
    const stub = await startStub({
      malformedJudgeModels: ["zeta/judge-1"],
    });
    const apiKeyEnv = "RIGHTMODELER_JUDGE_FAILOVER_E2E_API_KEY";
    const args = [
      "init",
      "--through",
      "replay",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      "--max-concurrency",
      "1",
      "--output",
      "json",
      "--repo",
      repo,
    ];

    try {
      const first = await runCli(args, { env: { [apiKeyEnv]: secret } });
      expect(first.code, first.stderr).toBe(0);
      expect(first.stderr).toContain('"event":"warning"');
      expect(first.stderr).toContain("zeta/judge-1");
      expect(JSON.parse(first.stdout)).toMatchObject({
        executedStages: expect.arrayContaining(["replay"]),
      });

      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      const executions = facts.filter(
        ({ executionId, caseId }) =>
          typeof executionId === "string" && typeof caseId === "string",
      );
      const assessments = facts.filter(
        ({ assessmentId }) => typeof assessmentId === "string",
      );
      const unusableNotes = facts.filter(
        ({ actor, reconcilableTo }) =>
          actor === "judge" &&
          typeof reconcilableTo === "object" &&
          reconcilableTo !== null &&
          !Array.isArray(reconcilableTo) &&
          (reconcilableTo as Record<string, unknown>).judgeStatus ===
            "unusable",
      );

      expect(executions.length).toBeGreaterThanOrEqual(3);
      expect(assessments).toHaveLength(executions.length);
      expect(
        assessments.every(({ evaluatorId }) => evaluatorId === "yotta/judge-2"),
      ).toBe(true);
      expect(unusableNotes).toHaveLength(1);

      expect(stub.getMaxInFlight()).toBe(1);
      const hitsAfterFirstRun = stub.getHitCount();
      const resumed = await runCli(args, { env: { [apiKeyEnv]: secret } });
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(stub.getHitCount()).toBe(hitsAfterFirstRun);
    } finally {
      await stub.close();
    }
  });

  it("judges the recorded answer's text from gateway traces and keeps the recorded message in the stored plan", async () => {
    const { root, repo } = await fixtureCopy("gateway-reference");
    const gatewayMessage = (
      JSON.parse(await readFile(aiGatewayChatResponsePath, "utf8")) as {
        choices: [{ message: Record<string, JsonValue> }];
      }
    ).choices[0].message;
    type TextParts = Array<{ content: string }>;
    const spans = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
      traceId: string;
      startTimeUnixNano: string;
      attributes: {
        "rightmodeler.family": string;
        "gen_ai.request.model": string;
        "gen_ai.system_instructions"?: TextParts;
        "gen_ai.input.messages": Array<{ role: string; parts: TextParts }>;
        "gen_ai.output.messages": [{ parts: TextParts }];
        "gen_ai.usage.input_tokens": number;
        "gen_ai.usage.output_tokens": number;
      };
    }>;
    const text = (parts: TextParts) =>
      parts.map(({ content }) => content).join("\n");
    const recordedTexts: string[] = [];
    const records = spans.map(({ traceId, startTimeUnixNano, attributes }) => {
      const model = attributes["gen_ai.request.model"];
      const system = attributes["gen_ai.system_instructions"];
      const recorded = text(attributes["gen_ai.output.messages"][0].parts);
      recordedTexts.push(recorded);
      return JSON.stringify({
        name: attributes["rightmodeler.family"],
        case_id: traceId,
        timestamp: startTimeUnixNano,
        model,
        messages: [
          ...(system === undefined
            ? []
            : [{ role: "system", content: text(system) }]),
          ...attributes["gen_ai.input.messages"].map(({ role, parts }) => ({
            role,
            content: text(parts),
          })),
        ],
        response: {
          id: "chatcmpl-SANITIZED",
          object: "chat.completion",
          model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { ...gatewayMessage, content: recorded },
            },
          ],
          usage: {
            prompt_tokens: attributes["gen_ai.usage.input_tokens"],
            completion_tokens: attributes["gen_ai.usage.output_tokens"],
          },
        },
      });
    });
    const traces = join(root, "gateway-traces.jsonl");
    await writeFile(traces, `${records.join("\n")}\n`);
    const stub = await startStub();
    const apiKeyEnv = "RIGHTMODELER_GATEWAY_REFERENCE_E2E_API_KEY";

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
      const judgeRequests = stub
        .getRequests()
        .filter(({ messages }) =>
          (messages as Array<{ content: string }>)[0]?.content.startsWith(
            "You are a strict evaluation judge.",
          ),
        );
      expect(judgeRequests.length).toBeGreaterThan(0);
      for (const request of judgeRequests) {
        const prompt = (request.messages as Array<{ content: string }>)
          .map(({ content }) => content)
          .join("\n");
        const reference =
          /<<<UNTRUSTED REFERENCE>>>\n([\s\S]*?)\n<<<END UNTRUSTED REFERENCE>>>/.exec(
            prompt,
          )?.[1];
        expect(recordedTexts).toContain(reference);
        expect(JSON.stringify(request)).not.toContain("provider_metadata");
      }
      const plan = await readStageArtifact(
        join(repo, ".rightmodeler"),
        "shortlist",
      );
      const cases = plan.cases as Array<{ referenceOutput: JsonValue }>;
      expect(cases.length).toBeGreaterThan(0);
      for (const { referenceOutput } of cases) {
        expect(referenceOutput).toMatchObject({
          provider_metadata: gatewayMessage.provider_metadata,
        });
      }
    } finally {
      await stub.close();
    }
  });

  it("falls back from a persistently rate-limited judge and completes family evidence", async () => {
    const { repo } = await fixtureCopy("judge-rate-limit-failover");
    const stub = await startStub({
      rateLimitedModels: ["zeta/judge-1"],
    });
    const apiKeyEnv = "RIGHTMODELER_JUDGE_RATE_LIMIT_E2E_API_KEY";
    const args = [
      "init",
      "--through",
      "aggregate",
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
    ];

    try {
      const result = await runCli(args, { env: { [apiKeyEnv]: secret } });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('"event":"warning"');
      expect(result.stderr).toContain("zeta/judge-1");
      const output = JSON.parse(result.stdout) as {
        familyOutcomes: Array<{
          familyId: string;
          verdict: { decision: string; abstainReason?: unknown };
        }>;
      };
      const summarize = output.familyOutcomes.find(
        ({ familyId }) => familyId === "summarize",
      );
      expect(summarize?.verdict).toMatchObject({ decision: "recommend" });
      expect(summarize?.verdict).not.toHaveProperty("abstainReason");

      const store = new FsStore(join(repo, ".rightmodeler"));
      const facts = (await Promise.all(
        (await store.list(factsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      )) as Array<Record<string, unknown>>;
      const executions = facts.filter(
        ({ executionId, caseId }) =>
          typeof executionId === "string" && typeof caseId === "string",
      );
      const assessments = facts.filter(
        ({ assessmentId }) => typeof assessmentId === "string",
      );
      const providerFailures = facts.filter(({ actor, reconcilableTo }) => {
        if (
          actor !== "judge" ||
          typeof reconcilableTo !== "object" ||
          reconcilableTo === null ||
          Array.isArray(reconcilableTo)
        ) {
          return false;
        }
        const detail = reconcilableTo as Record<string, unknown>;
        return (
          detail.judgeModel === "zeta/judge-1" &&
          detail.judgeFailureKind === "provider_error"
        );
      });
      const unusableNotes = facts.filter(({ actor, reconcilableTo }) => {
        if (
          actor !== "judge" ||
          typeof reconcilableTo !== "object" ||
          reconcilableTo === null ||
          Array.isArray(reconcilableTo)
        ) {
          return false;
        }
        return (
          (reconcilableTo as Record<string, unknown>).judgeStatus === "unusable"
        );
      });

      expect(executions.length).toBeGreaterThanOrEqual(10);
      expect(assessments).toHaveLength(executions.length);
      expect(
        assessments.every(({ evaluatorId }) => evaluatorId === "yotta/judge-2"),
      ).toBe(true);
      expect(providerFailures.length).toBeGreaterThanOrEqual(3);
      expect(providerFailures.length).toBeLessThanOrEqual(10);
      expect(unusableNotes).toEqual([
        expect.objectContaining({
          costUsd: 0,
          reconcilableTo: expect.objectContaining({
            judgeModel: "zeta/judge-1",
            judgeStatus: "unusable",
            consecutiveAssessments: 3,
          }),
        }),
      ]);
    } finally {
      await stub.close();
    }
  });

  it("plans from anywhere and proves checkpointed free stages", async () => {
    const { root, repo } = await fixtureCopy("plan");
    const unrelatedCwd = join(root, "unrelated-cwd");
    await cp(demoAppPath, unrelatedCwd, { recursive: true });

    const help = await runCli(["--help"], { cwd: unrelatedCwd });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("rightmodeler");
    expect(help.stdout).toContain("0 no recommendation");
    expect(help.stdout).toContain("1 recommendation exists");
    expect(help.stdout).toContain(">=10 runtime error");

    const initialPlan = await runCli(
      ["init", "--plan", "--output", "json", "--repo", repo],
      { cwd: unrelatedCwd },
    );
    expect(initialPlan.code).toBe(0);
    expect(jsonOutput(initialPlan).stages).toEqual(
      expect.arrayContaining([
        { stage: "scan", state: "pending" },
        { stage: "report", state: "pending" },
      ]),
    );
    expect(
      (jsonOutput(initialPlan).stages as Array<{ state: string }>).every(
        ({ state }) => state === "pending",
      ),
    ).toBe(true);

    const throughCorpus = [
      "init",
      "--through",
      "corpus",
      "--traces",
      tracesPath,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const first = await runCli(throughCorpus, { cwd: unrelatedCwd });
    expect(first.code).toBe(0);
    expect(jsonOutput(first).executedStages).toEqual([
      "scan",
      "ingest",
      "reconcile",
      "scrub",
      "corpus",
    ]);

    const second = await runCli(throughCorpus, { cwd: unrelatedCwd });
    expect(second.code).toBe(0);
    expect(jsonOutput(second).executedStages).toEqual([]);
    expect(
      (jsonOutput(second).stages as Array<{ state: string }>).every(
        ({ state }) => state === "complete",
      ),
    ).toBe(true);

    await writeFile(join(repo, ".git", "info", "exclude"), "generated/\n", {
      flag: "a",
    });
    await mkdir(join(repo, "generated"), { recursive: true });
    await writeFile(join(repo, "generated", "bundle.js"), "generated\n");

    const third = await runCli(throughCorpus, { cwd: unrelatedCwd });
    expect(third.code).toBe(0);
    expect(jsonOutput(third).executedStages).toEqual([]);
    expect(
      (jsonOutput(third).stages as Array<{ state: string }>).every(
        ({ state }) => state === "complete",
      ),
    ).toBe(true);

    const familyPlan = await runCli(
      ["init", "--plan", "--output", "json", "--repo", repo],
      { cwd: unrelatedCwd },
    );
    expect(familyPlan.code).toBe(0);
    expect(jsonOutput(familyPlan).familyPlans).toEqual([
      expect.objectContaining({
        familyId: "summarize",
        cases: 70,
        holdoutCases: 35,
        minimumHoldoutCases: minimumHoldout,
        stepIds: [expect.any(String), expect.any(String)],
      }),
      expect.objectContaining({
        familyId: "support",
        cases: 7,
        holdoutCases: 0,
        stepIds: [],
        abstainReason: {
          reason: "ambiguous_call_site_binding",
          observed: 0,
          required: 7,
        },
      }),
    ]);
  });

  it("applies release policy filters and quality floor through the built CLI", async () => {
    const { root, repo } = await fixtureCopy("release-policy");
    const store = join(root, "store");
    const denyPolicyPath = join(root, "deny-policy.json");
    const allowPolicyPath = join(root, "allow-policy.json");
    const floorPolicyPath = join(root, "floor-policy.json");
    const deniedModelId = "acme/lite-1";
    const allowedModelId = "acme/small-1";
    await Promise.all([
      writeFile(
        denyPolicyPath,
        JSON.stringify({ denyModels: [deniedModelId] }),
      ),
      writeFile(
        allowPolicyPath,
        JSON.stringify({ allowModels: [allowedModelId] }),
      ),
      // With a byte order mark, as Windows editors often write it.
      writeFile(
        floorPolicyPath,
        `\uFEFF${JSON.stringify({ qualityFloor: 0.95 })}`,
      ),
    ]);
    const stub = await startStub();
    const apiKeyEnv = "RIGHTMODELER_POLICY_E2E_API_KEY";
    const common = ["--repo", repo, "--store", store, "--output", "json"];
    const estimateOptions = [
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
    ];

    try {
      const denied = await runCli(
        [...common, "estimate", ...estimateOptions, "--policy", denyPolicyPath],
        { env: { [apiKeyEnv]: secret } },
      );
      expect(denied.code, denied.stderr).toBe(0);
      const deniedOutput = jsonOutput(denied);
      const deniedShortlist = deniedOutput.shortlist as Array<{
        candidateIds: string[];
      }>;
      expect(
        deniedShortlist.some(({ candidateIds }) => candidateIds.length > 0),
      ).toBe(true);
      expect(
        deniedShortlist.every(
          ({ candidateIds }) => !candidateIds.includes(deniedModelId),
        ),
      ).toBe(true);
      expect(deniedOutput.policy).toMatchObject({
        denyModels: [deniedModelId],
      });

      const allowed = await runCli(
        [
          ...common,
          "estimate",
          ...estimateOptions,
          "--policy",
          allowPolicyPath,
        ],
        { env: { [apiKeyEnv]: secret } },
      );
      expect(allowed.code, allowed.stderr).toBe(0);
      const allowedShortlist = (
        jsonOutput(allowed).shortlist as Array<{ candidateIds: string[] }>
      ).filter(({ candidateIds }) => candidateIds.length > 0);
      expect(allowedShortlist.length).toBeGreaterThan(0);
      for (const { candidateIds } of allowedShortlist) {
        expect(candidateIds).toEqual([allowedModelId]);
      }

      const planArgs = [...common, "init", "--plan", "--traces", tracesPath];
      const defaultPlan = await runCli(planArgs);
      expect(defaultPlan.code, defaultPlan.stderr).toBe(0);
      const defaultFamilyPlans = jsonOutput(defaultPlan).familyPlans as Array<{
        familyId: string;
        minimumHoldoutCases: number;
      }>;
      const raisedPlan = await runCli([
        ...planArgs,
        "--policy",
        floorPolicyPath,
      ]);
      expect(raisedPlan.code, raisedPlan.stderr).toBe(0);
      const raisedFamilyPlans = jsonOutput(raisedPlan).familyPlans as Array<{
        familyId: string;
        minimumHoldoutCases: number;
      }>;
      const raisedMinimum = minimumTrialsForFloor(0.95, 1);
      expect(defaultFamilyPlans.length).toBeGreaterThan(0);
      expect(raisedFamilyPlans).toHaveLength(defaultFamilyPlans.length);
      for (const familyPlan of raisedFamilyPlans) {
        const defaultFamilyPlan = defaultFamilyPlans.find(
          ({ familyId }) => familyId === familyPlan.familyId,
        );
        expect(defaultFamilyPlan).toBeDefined();
        expect(familyPlan.minimumHoldoutCases).toBe(raisedMinimum);
        expect(familyPlan.minimumHoldoutCases).toBeGreaterThan(
          defaultFamilyPlan!.minimumHoldoutCases,
        );
      }
    } finally {
      await stub.close();
    }
  });

  it("tries cheaper models released in the 90 days before the shortlist is planned, or since --released-since, and reports the window", async () => {
    const { repo } = await fixtureCopy("release-window");
    const stub = await startStub({ releasedDaysAgo: { "acme/lite-1": 200 } });
    const apiKeyEnv = "RIGHTMODELER_WINDOW_E2E_API_KEY";
    const options = [
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
    ];
    const env = { env: { [apiKeyEnv]: secret } };
    const since = utcDateDaysAgo(90);
    const caps = async () =>
      (
        await storeText(
          new FsStore(join(repo, ".rightmodeler")),
          reportKey("project", "report.md"),
        )
      )
        .split("\n")
        .filter((line) => /^- released |^- droppedByReleaseWindow /u.test(line))
        .sort();
    try {
      const recent = await runCli(["estimate", ...options], env);
      expect(recent.code, recent.stderr).toBe(0);
      const estimated = jsonOutput(recent);
      expect(estimated).toMatchObject({
        releaseWindow: { since, until: null },
        shortlist: [
          { candidateIds: ["acme/small-1"], droppedByReleaseWindow: 1 },
          { candidateIds: ["acme/small-1"], droppedByReleaseWindow: 1 },
        ],
      });
      const stepRows = (estimated.shortlist as Array<{ stepId: string }>).map(
        ({ stepId }) => `- droppedByReleaseWindow (${stepId}): 1`,
      );

      const widened = await runCli(
        ["estimate", ...options, "--released-since", "500d"],
        env,
      );
      expect(widened.code, widened.stderr).toBe(0);
      expect(jsonOutput(widened)).toMatchObject({
        releaseWindow: { since: utcDateDaysAgo(500), until: null },
        shortlist: [
          {
            candidateIds: ["acme/lite-1", "acme/small-1"],
            droppedByReleaseWindow: 0,
          },
          {
            candidateIds: ["acme/lite-1", "acme/small-1"],
            droppedByReleaseWindow: 0,
          },
        ],
      });

      const initialized = await runCli(["init", ...options], env);
      expect([0, 1], initialized.stderr).toContain(initialized.code);
      jsonOutput(initialized);
      expect(await caps()).toEqual(
        [...stepRows, `- released since: ${since}`].sort(),
      );
      const replayed = new Set(stub.getRequests().map(({ model }) => model));
      expect(replayed).toContain("acme/small-1");
      expect(replayed).not.toContain("acme/lite-1");

      const until = utcDateDaysAgo(0);
      const ended = await runCli(
        ["init", ...options, "--released-until", until],
        env,
      );
      expect([0, 1], ended.stderr).toContain(ended.code);
      jsonOutput(ended);
      expect(await caps()).toEqual(
        [
          ...stepRows,
          `- released since: ${since}`,
          `- released until: ${until}`,
        ].sort(),
      );
    } finally {
      await stub.close();
    }
  });

  it("replays the models named with --candidate whatever their release date, and names each one it leaves out", async () => {
    const { repo } = await fixtureCopy("named-candidates");
    const stub = await startStub({ releasedDaysAgo: { "acme/lite-1": 200 } });
    const renamed = await startRenamedCatalogStub({
      "acme/max-1": "zeta/small-1",
    });
    const apiKeyEnv = "RIGHTMODELER_NAMED_E2E_API_KEY";
    const options = (port: number) => [
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const env = { env: { [apiKeyEnv]: secret } };
    const notCheaper =
      "it is not cheaper than the current model acme/large-1 (3 vs 1.5 USD per million tokens)";
    const unknownRemedy =
      "Pass each --candidate as the provider's /models list spells it (vendor/model), then rerun.";
    try {
      const named = await runCli(
        [
          "estimate",
          ...options(stub.port),
          "--candidate",
          "lite-1",
          "--candidate",
          "acme/max-1",
        ],
        env,
      );
      expect(named.code, named.stderr).toBe(0);
      expect(JSON.parse(named.stdout)).toMatchObject({
        releaseWindow: null,
        namedCandidates: ["acme/max-1", "lite-1"],
        shortlist: [
          {
            candidateIds: ["acme/lite-1"],
            droppedByReleaseWindow: 0,
            namedCandidatesLeftOut: [
              { modelId: "acme/max-1", reason: notCheaper },
            ],
          },
          {
            candidateIds: ["acme/lite-1"],
            droppedByReleaseWindow: 0,
            namedCandidatesLeftOut: [
              { modelId: "acme/max-1", reason: notCheaper },
            ],
          },
        ],
      });
      expect(
        named.stderr
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ).toEqual([
        {
          event: "warning",
          code: "shortlist_candidate_left_out",
          message: `Family summarize: --candidate acme/max-1 was left out: ${notCheaper}.`,
        },
      ]);

      const ineligible = await runCli(
        ["estimate", ...options(stub.port), "--candidate", "acme/max-1"],
        env,
      );
      expect(ineligible.code, ineligible.stderr).toBe(2);
      expect(lastStderrEvent(ineligible)).toEqual({
        code: "named_candidates_ineligible",
        message: `None of the models named with --candidate can be tried at any call site: acme/max-1: ${notCheaper}.`,
        remedy:
          "Name models that cost less than the recorded models and support what each call site needs, or remove --candidate to use the automatic shortlist.",
      });

      const unknown = await runCli(
        ["estimate", ...options(stub.port), "--candidate", "acme/nope-1"],
        env,
      );
      expect(unknown.code, unknown.stderr).toBe(2);
      expect(lastStderrEvent(unknown)).toEqual({
        code: "unknown_candidate",
        message: "--candidate acme/nope-1 is not in the provider catalog.",
        remedy: unknownRemedy,
      });

      const ambiguous = await runCli(
        ["estimate", ...options(renamed.port), "--candidate", "small-1"],
        env,
      );
      expect(ambiguous.code, ambiguous.stderr).toBe(2);
      expect(lastStderrEvent(ambiguous)).toEqual({
        code: "unknown_candidate",
        message:
          "--candidate small-1 matches more than one catalog model: acme/small-1, zeta/small-1.",
        remedy: unknownRemedy,
      });
      expect(stub.getHitCount() + renamed.upstream.getHitCount()).toBe(0);

      const initialized = await runCli(
        ["init", ...options(stub.port), "--candidate", "lite-1"],
        env,
      );
      expect([0, 1], initialized.stderr).toContain(initialized.code);
      jsonOutput(initialized);
      const report = await storeText(
        new FsStore(join(repo, ".rightmodeler")),
        reportKey("project", "report.md"),
      );
      expect(report).toContain("\n- named candidates: lite-1\n");
      expect(report).not.toMatch(/^- (?:released|droppedByReleaseWindow) /mu);
      expect(stub.getRequests().map(({ model }) => model)).toContain(
        "acme/lite-1",
      );
    } finally {
      await renamed.close();
      await stub.close();
    }
  });

  it("stops before any model call when no cheaper model was released inside the window", async () => {
    const { repo } = await fixtureCopy("no-recent-candidates");
    const stub = await startStub({
      releasedDaysAgo: { "acme/lite-1": 200, "acme/small-1": 300 },
    });
    const apiKeyEnv = "RIGHTMODELER_NO_RECENT_E2E_API_KEY";
    const since = utcDateDaysAgo(90);
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

      expect(result.code, result.stderr).toBe(2);
      expect(
        warningMessages(result.stderr, "shortlist_no_recent_candidates"),
      ).toEqual([
        `Family summarize: no model cheaper than the current model was released on or after ${since} (2 cheaper models left out); pass an earlier --released-since, or name models with --candidate.`,
      ]);
      expect(lastStderrEvent(result)).toEqual({
        code: "no_recent_candidates",
        message: `No model cheaper than a recorded model was released on or after ${since}, so there is nothing to replay.`,
        remedy:
          "Pass an earlier --released-since (a date such as 2026-01-01, or a number of days such as 365d), name the models to try with --candidate <id>, or, if the catalog's release dates are placeholders, pass --catalog-reference <url> with a model list that publishes real ones.",
      });
      expect(stub.getHitCount()).toBe(0);
    } finally {
      await stub.close();
    }
  });

  it("ranks by price with a warning when the catalog publishes no release dates, and refuses an explicit range", async () => {
    const { repo } = await fixtureCopy("undated-catalog");
    const stub = await startUnpricedCatalogStub(["released"]);
    const apiKeyEnv = "RIGHTMODELER_UNDATED_E2E_API_KEY";
    const options = [
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
    ];
    const env = { env: { [apiKeyEnv]: secret } };
    try {
      const estimated = await runCli(["estimate", ...options], env);

      expect(estimated.code, estimated.stderr).toBe(0);
      expect(
        warningMessages(estimated.stderr, "release_window_skipped"),
      ).toEqual([
        `The provider catalog gives its priced models fewer than two distinct release dates, so the default release window (models released on or after ${utcDateDaysAgo(90)}) was not applied and candidates are ranked by price. Pass --catalog-reference with a model list that publishes release dates to apply it.`,
      ]);
      expect(JSON.parse(estimated.stdout)).toMatchObject({
        releaseWindow: null,
        shortlist: [
          {
            candidateIds: ["acme/lite-1", "acme/small-1"],
            droppedByReleaseWindow: 0,
          },
          {
            candidateIds: ["acme/lite-1", "acme/small-1"],
            droppedByReleaseWindow: 0,
          },
        ],
      });

      const ranged = await runCli(
        ["estimate", ...options, "--released-since", "2026-01-01"],
        env,
      );
      expect(ranged.code, ranged.stderr).toBe(2);
      expect(lastStderrEvent(ranged)).toEqual({
        code: "release_dates_unavailable",
        message:
          "The provider catalog gives its priced models fewer than two distinct release dates, so --released-since and --released-until cannot be applied.",
        remedy:
          "Pass --catalog-reference <url> with a model list that publishes release dates (for example https://ai-gateway.vercel.sh/v1/models), name the models to try with --candidate <id>, or remove --released-since and --released-until.",
      });
      expect(stub.getHitCount()).toBe(0);
    } finally {
      await stub.close();
    }
  });
});
