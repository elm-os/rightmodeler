import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FsStore,
  confirmPlanKey,
  factsPrefix,
  reportKey,
  type JsonValue,
  verdictsPrefix,
} from "@rightmodeler/core";
import { judgeExecution, type JudgeChat } from "@rightmodeler/kernel";
import { createProvider } from "@rightmodeler/replay";
import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const langgraphAppPath = fileURLToPath(
  new URL("../../../fixtures/langgraph-app", import.meta.url),
);
const langgraphTracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/langgraph-otel.json", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const evaluatorStubModuleUrl = new URL(
  "../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const temporaryDirectories: string[] = [];
const secret = "phase-a-api-key-must-not-persist";
const execFileAsync = promisify(execFile);

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

interface EvaluatorStub {
  port: number;
  close(): Promise<void>;
  getHitCount(method: string, path: string): number;
}

interface EvaluatorStubModule {
  startEvalStub(options: {
    port: number;
    pendingPolls?: number;
    platformPassDecisions?: boolean;
    fail?: boolean;
  }): Promise<EvaluatorStub>;
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixtureCopy(
  label: string,
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "demo-app");
  await cp(demoAppPath, repo, { recursive: true });
  return { root, repo };
}

async function langgraphFixtureCopy(
  label: string,
): Promise<{ root: string; repo: string; traces: string }> {
  const root = await mkdtemp(
    join(dirname(langgraphAppPath), `.rightmodeler-${label}-`),
  );
  temporaryDirectories.push(root);
  const repo = join(root, "langgraph-app");
  await cp(langgraphAppPath, repo, { recursive: true });
  const source = JSON.parse(
    await readFile(langgraphTracesPath, "utf8"),
  ) as Array<Record<string, unknown>>;
  const trajectory = source.filter(
    (span) => span.traceId === "trace-langgraph-01",
  );
  const expanded = Array.from({ length: 40 }, (_, index) =>
    trajectory.map((span, stepIndex) => ({
      ...span,
      traceId: `trace-langgraph-confirm-${String(index + 1).padStart(2, "0")}`,
      span_id: `span-langgraph-confirm-${index + 1}-${stepIndex + 1}`,
      startTimeUnixNano: String((index + 1) * 1_000_000 + stepIndex * 100),
    })),
  ).flat();
  const traces = join(root, "langgraph-confirm-otel.json");
  await writeFile(traces, JSON.stringify(expanded));
  return { root, repo, traces };
}

async function ensureLanggraphImage(root: string): Promise<string> {
  await execFileAsync("docker", ["version"], { encoding: "utf8" });
  const requirements = await readFile(
    join(langgraphAppPath, "requirements.txt"),
  );
  const digest = createHash("sha256")
    .update(requirements)
    .digest("hex")
    .slice(0, 12);
  const image = `rightmodeler-modeb-langgraph:${digest}`;
  try {
    await execFileAsync("docker", ["image", "inspect", image], {
      encoding: "utf8",
    });
    return image;
  } catch {
    const dockerfile = join(root, "Dockerfile.modeb");
    await writeFile(
      dockerfile,
      [
        "FROM node:24-bookworm-slim",
        "RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*",
        "COPY requirements.txt /tmp/requirements.txt",
        "RUN pip3 install --break-system-packages --no-cache-dir -r /tmp/requirements.txt",
        "",
      ].join("\n"),
    );
    await execFileAsync(
      "docker",
      ["build", "--tag", image, "--file", dockerfile, langgraphAppPath],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
    return image;
  }
}

async function writeModeBConfig(
  root: string,
  repo: string,
  image: string,
): Promise<string> {
  const records = scan(repo, createMatcherRegistry(), "project").filter(
    ({ callSite }) => callSite.path === "a_topology.py",
  );
  expect(records).toHaveLength(3);
  const config = join(root, "modeb.json");
  await writeFile(
    config,
    JSON.stringify({
      version: "1",
      image,
      appSpec: {
        mountPath: repo,
        command: [
          "python3",
          "/rightmodeler/app/main.py",
          "--case-json",
          "{caseFile}",
        ],
      },
      stepMap: Object.fromEntries(
        records.map((record, index) => [
          record.stepId,
          ["classify", "lookup", "answer"][index],
        ]),
      ),
    }),
  );
  return config;
}

function runCli(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 10, stdout, stderr });
    });
  });
}

function jsonOutput(result: ChildResult): Record<string, unknown> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function startStub(): Promise<StubProvider> {
  const module = (await import(stubModuleUrl)) as StubProviderModule;
  return module.startStubProvider({ port: 0 });
}

async function startEvaluatorStub(
  options: {
    pendingPolls?: number;
    platformPassDecisions?: boolean;
    fail?: boolean;
  } = {},
): Promise<EvaluatorStub> {
  const module = (await import(evaluatorStubModuleUrl)) as EvaluatorStubModule;
  return module.startEvalStub({
    port: 0,
    pendingPolls: 1,
    platformPassDecisions: false,
    ...options,
  });
}

async function startConfirmStub(): Promise<StubProvider> {
  const upstream = await startStub();
  let hitCount = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const value: unknown =
      body.length === 0
        ? undefined
        : (JSON.parse(body.toString("utf8")) as unknown);
    if (
      request.method === "POST" &&
      request.url === "/v1/chat/completions" &&
      typeof value === "object" &&
      value !== null &&
      "model" in value &&
      value.model === "zeta/judge-1" &&
      JSON.stringify(value).includes(
        "The order lookup result could not be verified.",
      )
    ) {
      hitCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "confirm-judge-divergent",
          object: "chat.completion",
          model: "zeta/judge-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  verdict: "divergent",
                  score: 0,
                  justification: "Seeded interaction failure.",
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 16,
            completion_tokens: 8,
            total_tokens: 24,
          },
        }),
      );
      return;
    }
    const upstreamResponse = await fetch(
      `http://127.0.0.1:${upstream.port}${request.url ?? "/"}`,
      {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(body.length === 0 ? {} : { body }),
      },
    );
    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    response.writeHead(upstreamResponse.status, {
      "content-type":
        upstreamResponse.headers.get("content-type") ?? "application/json",
    });
    response.end(bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await upstream.close();
    throw new Error("Confirm stub did not bind a TCP port");
  }
  return {
    port: address.port,
    getHitCount: () => hitCount + upstream.getHitCount(),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await upstream.close();
    },
  };
}

async function storeText(store: FsStore, key: string): Promise<string> {
  const entry = await store.get(key);
  if (entry === null) throw new Error(`Missing store key: ${key}`);
  return Buffer.from(entry.body).toString("utf8");
}

async function allFileText(root: string): Promise<string> {
  const texts: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) texts.push(await readFile(path, "utf8"));
    }
  }
  await visit(root);
  return texts.join("\n");
}

describe("built CLI pipeline", () => {
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
        (
          await provider.chat({
            model: request.model,
            messages: request.messages,
            temperature: request.temperature,
            responseFormat: request.responseFormat as JsonValue,
          })
        ).content;

      const normal = await judgeExecution({
        chat,
        judgeModel: "zeta/judge-1",
        task: "Summarize the recorded case.",
        reference: "Accepted summary",
        candidate: "Candidate summary",
      });
      const seeded = await judgeExecution({
        chat,
        judgeModel: "zeta/judge-1",
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
            reason: "insufficient_review_trials",
            observed: 3,
            required: 10,
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
      };
      const reportMarkdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("insufficient_review_trials (3 of 10)");
      expect(reportMarkdown).toContain("## Gates");
      expect(reportMarkdown).toContain("## Selection");
      expect(reportMarkdown).toContain("Selection-adjusted estimate");
      expect(reportMarkdown).toContain("## Caps");
      expect(reportMarkdown).toContain("droppedByTop");
      expect(reportJson.families).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gates: expect.any(Array),
            selection: expect.objectContaining({ status: "selected" }),
          }),
        ]),
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
        "insufficient_review_trials (3 of 10)",
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
          Execution: 111,
          Assessment: 111,
        },
      });

      expect(await allFileText(storeRoot)).not.toContain(secret);
      expect(reportMarkdown).not.toContain(secret);
      expect(JSON.stringify(reportJson)).not.toContain(secret);
    } finally {
      await stub.close();
    }
  }, 60_000);

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
  }, 60_000);

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
        assessmentAbsent: number;
        assessmentAbsentReasons: Array<{ reason: string; count: number }>;
      }>;
      expect(
        verdicts.every(({ assessmentAbsent }) => assessmentAbsent > 0),
      ).toBe(true);
      expect(
        verdicts.flatMap(({ assessmentAbsentReasons }) =>
          assessmentAbsentReasons.map(({ reason }) => reason),
        ),
      ).toEqual(expect.arrayContaining(["external_experiment_failed"]));

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
  }, 60_000);

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

  it("runs Mode B confirmation, isolates the interacting pair, and resumes from its frontier", async () => {
    const { root, repo, traces } = await langgraphFixtureCopy("confirm");
    const image = await ensureLanggraphImage(root);
    const modeBConfig = await writeModeBConfig(root, repo, image);
    const stub = await startConfirmStub();
    const args = [
      "init",
      "--traces",
      traces,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_CONFIRM_E2E_API_KEY",
      "--modeb-config",
      modeBConfig,
      "--output",
      "json",
      "--repo",
      repo,
    ];

    try {
      const first = await runCli(args, {
        env: { RIGHTMODELER_CONFIRM_E2E_API_KEY: secret },
      });
      const output = jsonOutput(first);
      expect(first.code, JSON.stringify(output.familyOutcomes)).toBe(0);
      const store = new FsStore(join(repo, ".rightmodeler"));
      expect(output.executedStages).toContain("confirm");
      expect(output.familyOutcomes).toContainEqual(
        expect.objectContaining({
          familyId: "langgraph_order_lookup",
          effectiveRecommendation: false,
          confirmation: {
            status: "isolated",
            runSetsUsed: expect.any(Number),
            culprits: [["classify", "lookup"]],
            cascadeSeedStepId: "classify",
          },
        }),
      );

      const factKeys = await store.list(factsPrefix("project"));
      const facts = await Promise.all(
        factKeys.map(async (key) => JSON.parse(await storeText(store, key))),
      );
      const cascades = facts.filter(
        (fact) =>
          typeof fact === "object" && fact !== null && "cascadeId" in fact,
      ) as Array<Record<string, unknown>>;
      expect(cascades).toContainEqual(
        expect.objectContaining({
          familyId: "langgraph_order_lookup",
          verdict: "isolated",
          culprits: [["classify", "lookup"]],
          cascadeSeedStepId: "classify",
          runSetsUsed: expect.any(Number),
        }),
      );
      const plan = JSON.parse(
        await storeText(
          store,
          confirmPlanKey("project", "langgraph_order_lookup"),
        ),
      ) as { verdict: string; queue: Array<{ status: string }> };
      expect(plan.verdict).toBe("isolated");
      expect(
        plan.queue.every(
          ({ status }) => status === "pass" || status === "fail",
        ),
      ).toBe(true);

      const reportMarkdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("## Confirm");
      expect(reportMarkdown).toContain("| langgraph_order_lookup | isolated |");
      expect(reportMarkdown).toContain("classify + lookup");

      const hits = stub.getHitCount();
      const resumed = await runCli(args, {
        env: { RIGHTMODELER_CONFIRM_E2E_API_KEY: secret },
      });
      expect(resumed.code).toBe(0);
      expect(jsonOutput(resumed).executedStages).toEqual([]);
      expect(stub.getHitCount()).toBe(hits);
      expect(await store.list(factsPrefix("project"))).toHaveLength(
        factKeys.length,
      );
    } finally {
      await stub.close();
    }
  }, 600_000);

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

    expect(result.code).toBe(10);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "runtime_error",
      message: expect.stringContaining("appSpec.command"),
    });
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
    const missingResult = await runCli([
      "init",
      "--through",
      "ingest",
      "--output",
      "json",
      "--repo",
      missing.repo,
    ]);
    expect(missingResult.code).toBe(2);
    expect(JSON.parse(missingResult.stderr)).toMatchObject({
      code: "missing_traces_path",
      remedy: expect.stringContaining("--traces"),
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
});
