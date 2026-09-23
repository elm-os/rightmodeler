import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer } from "node:http";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  FsStore,
  computeRunSpecDigest,
  confirmPlanKey,
  factKey,
  factsPrefix,
  readLedger,
  reportKey,
  setupStateKey,
  type StepRecord,
  type JsonValue,
  verdictKey,
  verdictsPrefix,
} from "@rightmodeler/core";
import {
  judgeExecution,
  minimumTrialsForFloor,
  type JudgeChat,
} from "@rightmodeler/kernel";
import { createProvider } from "@rightmodeler/replay";
import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterAll, describe, expect, it } from "vitest";

import {
  listApprovedSwapSets,
  resolveCheckpointedPipelineCorpus,
  topologicalRecords,
} from "./pipeline.js";
import { Reporter } from "./protocol.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const traceFixturesDir = fileURLToPath(
  new URL("../../../fixtures/traces/", import.meta.url),
);
const traceFixtures = readdirSync(traceFixturesDir)
  .filter((name) => /\.(json|jsonl)$/u.test(name))
  .sort();
const langgraphAppPath = fileURLToPath(
  new URL("../../../fixtures/langgraph-app", import.meta.url),
);
const langgraphTracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/langgraph-otel.json", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const demoGraphPath = fileURLToPath(
  new URL("../../../fixtures/code-graph/demo-app.graph.json", import.meta.url),
);
const aiSdkAppPath = fileURLToPath(
  new URL("../../../fixtures/ai-sdk-app", import.meta.url),
);
const aiSdkLegacyTracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/ai-sdk-v7-legacy.jsonl", import.meta.url),
);
const promptfooCommandPath = fileURLToPath(
  new URL("../../../fixtures/promptfoo-stub/run.mjs", import.meta.url),
);
const promptfooAssertionsPath = fileURLToPath(
  new URL("../../../fixtures/promptfoo-stub/assertions.yaml", import.meta.url),
);
const livePromptfoo = process.env.RIGHTMODELER_LIVE_PROMPTFOO;
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const evaluatorStubModuleUrl = new URL(
  "../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const githubStubModuleUrl = new URL(
  "../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
const temporaryDirectories: string[] = [];
const secret = "phase-a-api-key-must-not-persist";
const minimumHoldout = minimumTrialsForFloor(0.85, 1);
const execFileAsync = promisify(execFile);
const skipDocker = process.env.RIGHTMODELER_SKIP_DOCKER === "1";
if (skipDocker) {
  console.warn(
    "[cli e2e] SKIPPED Mode B confirmation: RIGHTMODELER_SKIP_DOCKER=1",
  );
}

describe("machine error protocol", () => {
  it("preserves a named code from a typed service error", () => {
    let stderr = "";
    const reporter = new Reporter("json", {
      stdout: () => undefined,
      stderr: (value) => {
        stderr += value;
      },
    });
    const error = Object.assign(new Error("active corpus moved"), {
      code: "stale_corpus_parent",
    });

    expect(reporter.error(error)).toBe(10);
    expect(JSON.parse(stderr)).toMatchObject({
      code: "stale_corpus_parent",
      message: "active corpus moved",
    });
  });
});

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
  getMaxInFlight(): number;
}

interface RecordingStubProvider extends StubProvider {
  getRequestHeaders(): Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    model?: string;
  }>;
}

interface StubProviderModule {
  startStubProvider(options: {
    port: number;
    catalogTotalCount?: number;
    errorModels?: string[];
    includeFreeModel?: boolean;
    malformedJudgeModels?: string[];
    omitCatalogModels?: string[];
    rateLimitedModels?: string[];
    rateLimitMessageIncludes?: string;
    servedModels?: Record<string, string>;
  }): Promise<RecordingStubProvider>;
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

interface GithubStubHit {
  method: string;
  path: string;
  body: unknown;
}

interface GithubStub {
  port: number;
  getHits(): GithubStubHit[];
  close(): Promise<void>;
}

interface GithubStubModule {
  startGithubStub(options: {
    port: number;
    token: string;
  }): Promise<GithubStub>;
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

async function regradeAfterAssertionsEdit(input: {
  label: string;
  command: string;
  env: (root: string) => Record<string, string>;
}) {
  const { root, repo } = await fixtureCopy(input.label);
  const assertions = join(root, "rubric", "assertions.yaml");
  await mkdir(dirname(assertions));
  await cp(promptfooAssertionsPath, assertions);
  const modelStub = await startStub();
  const args = [
    "init",
    "--traces",
    tracesPath,
    "--base-url",
    `http://127.0.0.1:${modelStub.port}/v1`,
    "--api-key-env",
    "RIGHTMODELER_E2E_API_KEY",
    "--evaluator",
    "promptfoo",
    "--evaluator-command",
    input.command,
    "--evaluator-config",
    assertions,
    "--evaluator-scorer",
    "output_similarity",
    "--output",
    "json",
    "--repo",
    repo,
  ];
  const init = () =>
    runCli(args, {
      env: { RIGHTMODELER_E2E_API_KEY: secret, ...input.env(root) },
    });
  const grades = async () =>
    (
      await readLedger(new FsStore(join(repo, ".rightmodeler")), "project")
    ).assessments.filter(
      ({ evaluatorId, metricName }) =>
        evaluatorId === "promptfoo" && metricName === "output_similarity",
    );
  try {
    const first = await init();
    expect(first.code, first.stderr).toBe(0);
    jsonOutput(first);
    const chat = modelStub.getHitCount();
    const gradesAfterFirst = await grades();
    expect(gradesAfterFirst.length).toBeGreaterThan(0);
    expect(jsonOutput(await init()).executedStages).toEqual([]);
    await writeFile(
      assertions,
      (await readFile(assertions, "utf8")).replace(
        "value: Paris",
        "value: Lyon",
      ),
    );
    const edited = await init();
    expect(edited.code, edited.stderr).toBe(0);
    expect(JSON.parse(edited.stdout).executedStages).toEqual([
      "replay",
      "aggregate",
      "confirm",
      "report",
    ]);
    expect(modelStub.getHitCount()).toBe(chat);
    const warnings = edited.stderr
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning).toMatchObject({
        event: "warning",
        code: "evaluator_regrade",
      });
    }
    expect(
      warnings.reduce(
        (total, { message }) =>
          total + Number(/^Re-grading (\d+) /u.exec(message!)?.[1]),
        0,
      ),
    ).toBe(gradesAfterFirst.length);
    const gradesAfterEdited = await grades();
    expect(gradesAfterEdited).toHaveLength(2 * gradesAfterFirst.length);
    expect(
      new Set(
        gradesAfterEdited.map(({ evaluatorIdentity }) => evaluatorIdentity),
      ).size,
    ).toBe(2);
    expect(jsonOutput(await init()).executedStages).toEqual([]);
    return { root, gradesAfterFirst, gradesAfterEdited };
  } finally {
    await modelStub.close();
  }
}

async function fixtureCopy(
  label: string,
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "demo-app");
  await cp(demoAppPath, repo, { recursive: true });
  await initializeFixtureRepository(repo);
  return { root, repo };
}

async function aiSdkFixtureCopy(
  label: string,
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "ai-sdk-app");
  await cp(aiSdkAppPath, repo, { recursive: true });
  await initializeFixtureRepository(repo);
  return { root, repo };
}

async function fixtureHome(root: string): Promise<string> {
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return home;
}

async function initializeFixtureRepository(repo: string): Promise<void> {
  await execFileAsync("git", ["-C", repo, "init", "--initial-branch", "main"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "fixture@example.com",
  ]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", [
    "-C",
    repo,
    "commit",
    "--message",
    "Seed fixture",
  ]);
}

async function narrowDemoFixtureForApply(
  root: string,
  repo: string,
  secondModel = "acme/max-1",
) {
  await Promise.all([
    rm(join(repo, "config"), { recursive: true, force: true }),
    rm(join(repo, "requirements.txt"), { force: true }),
    rm(join(repo, "src", "model-notes.ts"), { force: true }),
    rm(join(repo, "src", "support.py"), { force: true }),
    rm(join(repo, "src", "triage.py"), { force: true }),
    rm(join(repo, "src", "summarize-stream.ts"), { force: true }),
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
    join(repo, "src", "extract.ts"),
    [
      'import { generateText } from "ai";',
      "",
      "export async function extractContact(message: string) {",
      "  return generateText({",
      `    model: "${secondModel}",`,
      "    prompt: `Extract the contact request: ${message}`,",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ dependencies: { ai: "*" } }, null, 2)}\n`,
  );
  const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
    attributes?: Record<string, unknown>;
  }>;
  const filteredTraces = join(root, "summarize-otel.json");
  const summarizeTraces = traces
    .filter(
      ({ attributes }) => attributes?.["rightmodeler.family"] === "summarize",
    )
    .map((trace, index) =>
      index % 2 === 0
        ? trace
        : {
            ...trace,
            attributes: {
              ...trace.attributes,
              "gen_ai.request.model": secondModel,
              "gen_ai.response.model": secondModel,
            },
          },
    );
  await writeFile(filteredTraces, JSON.stringify(summarizeTraces));
  await execFileAsync("git", ["-C", repo, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "commit",
    "--message",
    "Narrow apply fixture",
  ]);
  return filteredTraces;
}

async function writeToolCallTraces(
  root: string,
  summarizeSpans: number,
): Promise<string> {
  const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
    attributes: Record<string, unknown>;
  }>;
  for (const { attributes } of traces
    .filter(
      ({ attributes }) => attributes["rightmodeler.family"] === "summarize",
    )
    .slice(0, summarizeSpans)) {
    attributes["gen_ai.input.messages"] = [
      ...(attributes["gen_ai.input.messages"] as JsonValue[]),
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "call-042", name: "lookup", arguments: {} },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "call-042", response: "ok" }],
      },
    ];
  }
  const path = join(root, "traces.json");
  await writeFile(path, JSON.stringify(traces));
  return path;
}

function warningMessages(stderr: string, code: string): string[] {
  return stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { code?: string; message: string })
    .filter((event) => event.code === code)
    .map(({ message }) => message);
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
  await initializeFixtureRepository(repo);
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
      confirmMaxRunSets: 20,
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

async function startStub(
  options: {
    catalogTotalCount?: number;
    errorModels?: string[];
    includeFreeModel?: boolean;
    malformedJudgeModels?: string[];
    omitCatalogModels?: string[];
    rateLimitedModels?: string[];
    rateLimitMessageIncludes?: string;
    servedModels?: Record<string, string>;
  } = {},
): Promise<RecordingStubProvider> {
  const module = (await import(stubModuleUrl)) as StubProviderModule;
  return module.startStubProvider({ port: 0, ...options });
}

async function startUnpricedCatalogStub(
  strippedFields: readonly string[] = ["pricing"],
): Promise<StubProvider> {
  const upstream = await startStub();
  let hitCount = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const upstreamResponse = await fetch(
      `http://127.0.0.1:${upstream.port}${request.url ?? "/"}`,
      {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(body.length === 0 ? {} : { body }),
      },
    );
    if (request.method === "GET" && request.url === "/v1/models") {
      const catalog = (await upstreamResponse.json()) as {
        object: string;
        data: Array<Record<string, unknown>>;
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...catalog,
          data: catalog.data.map((model) => {
            const unpriced = { ...model };
            for (const field of strippedFields) delete unpriced[field];
            return unpriced;
          }),
        }),
      );
      return;
    }
    hitCount += 1;
    response.writeHead(upstreamResponse.status, {
      "content-type":
        upstreamResponse.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await upstream.close();
    throw new Error("Unpriced catalog stub did not bind a TCP port");
  }
  return {
    port: address.port,
    getHitCount: () => hitCount,
    getMaxInFlight: () => upstream.getMaxInFlight(),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await upstream.close();
    },
  };
}

async function startCatalogDriftStub(): Promise<StubProvider> {
  const upstream = await startStub();
  let hitCount = 0;
  let catalogRequests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const upstreamResponse = await fetch(
      `http://127.0.0.1:${upstream.port}${request.url ?? "/"}`,
      {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(body.length === 0 ? {} : { body }),
      },
    );
    if (request.method === "GET" && request.url === "/v1/models") {
      catalogRequests += 1;
      const catalog = (await upstreamResponse.json()) as {
        object: string;
        data: Array<{ id: string }>;
      };
      const data =
        catalogRequests === 1
          ? catalog.data
          : catalog.data.filter(({ id }) => id.startsWith("zeta/"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...catalog,
          data,
          total_count: data.length,
        }),
      );
      return;
    }
    hitCount += 1;
    response.writeHead(upstreamResponse.status, {
      "content-type":
        upstreamResponse.headers.get("content-type") ?? "application/json",
    });
    response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await upstream.close();
    throw new Error("Catalog-drift stub did not bind a TCP port");
  }
  return {
    port: address.port,
    getHitCount: () => hitCount,
    getMaxInFlight: () => upstream.getMaxInFlight(),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await upstream.close();
    },
  };
}

async function waitForTerminalRun(
  repo: string,
  store: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await runCli([
      "--repo",
      repo,
      "--store",
      store,
      "--output",
      "json",
      "status",
      "--run",
      runId,
    ]);
    expect(result.code).toBe(0);
    const status = jsonOutput(result);
    if (status.terminal === true) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Detached replay did not finish: ${runId}`);
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

async function startGithubStub(token: string): Promise<GithubStub> {
  const module = (await import(githubStubModuleUrl)) as GithubStubModule;
  return module.startGithubStub({ port: 0, token });
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
    getMaxInFlight: () => upstream.getMaxInFlight(),
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

async function removeExecutionFacts(
  storeRoot: string,
  predicate: (execution: Record<string, unknown>) => boolean,
): Promise<void> {
  const store = new FsStore(storeRoot);
  for (const key of await store.list(factsPrefix("project"))) {
    const fact = JSON.parse(await storeText(store, key)) as Record<
      string,
      unknown
    >;
    if (typeof fact.executionId === "string" && predicate(fact)) {
      await rm(join(storeRoot, ".rightmodeler-store", "entries", key), {
        recursive: true,
      });
    }
  }
}

async function rewriteStageArtifact(
  storeRoot: string,
  stage: string,
  rewrite: (artifact: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const store = new FsStore(storeRoot);
  const state = JSON.parse(
    await storeText(store, setupStateKey("project")),
  ) as {
    stages: Record<string, { outputKey: string }>;
  };
  const outputKey = state.stages[stage]?.outputKey;
  expect(outputKey).toEqual(expect.any(String));
  const artifact = JSON.parse(await storeText(store, outputKey!)) as Record<
    string,
    unknown
  >;
  const entry = await store.get(outputKey!);
  expect(entry).not.toBeNull();
  expect(
    await store.compareAndSwap(
      outputKey!,
      entry!.version,
      Buffer.from(JSON.stringify(rewrite(artifact)), "utf8"),
      entry!.fenceToken,
    ),
  ).toBe(true);
}

async function readStageArtifact(
  storeRoot: string,
  stage: string,
): Promise<Record<string, unknown>> {
  const store = new FsStore(storeRoot);
  const state = JSON.parse(
    await storeText(store, setupStateKey("project")),
  ) as {
    stages: Record<string, { outputKey: string }>;
  };
  const outputKey = state.stages[stage]?.outputKey;
  expect(outputKey).toEqual(expect.any(String));
  return JSON.parse(await storeText(store, outputKey!)) as Record<
    string,
    unknown
  >;
}

function topologyRecord(
  stepId: string,
  path: string,
  downstreamStepIds: readonly string[],
): StepRecord {
  return {
    stepId,
    callSite: { path, line: 1, matcherSlug: "topology-test" },
    family: "topology-test",
    replayMode: "e2e",
    prefixProvenance: "model_authored",
    riskTier: "normal",
    capabilityRequirements: [],
    evaluatorLadder: [],
    currentModel: "acme/current",
    observedCostUsd: 0,
    downstreamStepIds: [...downstreamStepIds],
    candidates: [],
    analysisHistory: [],
    status: "pending",
    contentHash: `hash-${stepId}`,
  };
}

describe("topologicalRecords", () => {
  it("respects every edge across all four-node DAGs", () => {
    const ids = ["a", "b", "c", "d"] as const;
    const possibleEdges = ids.flatMap((source, sourceIndex) =>
      ids.slice(sourceIndex + 1).map((target) => [source, target] as const),
    );
    for (let mask = 0; mask < 2 ** possibleEdges.length; mask += 1) {
      const records = ids.map((stepId, index) =>
        topologyRecord(
          stepId,
          `${ids.length - index}.py`,
          possibleEdges.flatMap(([source, target], edgeIndex) =>
            source === stepId && (mask & (1 << edgeIndex)) !== 0
              ? [target]
              : [],
          ),
        ),
      );
      for (const input of [
        records,
        [...records].reverse(),
        [records[1]!, records[3]!, records[0]!, records[2]!],
      ]) {
        const ordered = topologicalRecords(input);
        const position = new Map(
          ordered.map(({ stepId }, order) => [stepId, order]),
        );
        for (const [source, target] of possibleEdges) {
          if (
            records
              .find(({ stepId }) => stepId === source)!
              .downstreamStepIds.includes(target)
          ) {
            expect(position.get(source)).toBeLessThan(position.get(target)!);
          }
        }
      }
    }
  });
});

describe("section 18 autonomy boundary", () => {
  it("has no approval helper in apply or watch production paths", async () => {
    const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
    const matches: string[] = [];
    for (const directory of ["apply", "watch"]) {
      for (const entry of await readdir(join(sourceRoot, directory), {
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        if (entry.name.endsWith(".test.ts")) continue;
        const content = await readFile(
          join(sourceRoot, directory, entry.name),
          "utf8",
        );
        for (const [index, line] of content.split("\n").entries()) {
          if (/approval/i.test(line)) {
            matches.push(`${directory}/${entry.name}:${index + 1}:${line}`);
          }
        }
      }
    }

    expect(matches).toEqual([]);
  });
});

describe("built CLI pipeline", () => {
  it.each(traceFixtures)(
    "runs %s through corpus",
    async (name) => {
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
    },
    60_000,
  );

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
        reader: "ai-sdk-dialects-v1",
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
  }, 60_000);

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
  }, 60_000);

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
      writeFile(floorPolicyPath, JSON.stringify({ qualityFloor: 0.95 })),
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
  }, 60_000);

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
  }, 120_000);

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
  }, 120_000);

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
  }, 60_000);

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
  }, 120_000);

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
  }, 120_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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

  it.skipIf(skipDocker)(
    "runs Mode B confirmation, isolates the interacting pair, and resumes from its frontier",
    async () => {
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
            verdict: expect.objectContaining({
              decision: "reject",
              abstainReason: { reason: "cascade_isolated" },
            }),
            decisionDisplay: "reject",
            effectiveRecommendation: false,
            confirmation: expect.objectContaining({
              status: "isolated",
              runSetsUsed: expect.any(Number),
              culprits: [["classify", "lookup"]],
              cascadeSeedStepId: "classify",
              maxRunSets: 20,
            }),
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
        expect(reportMarkdown).toContain(
          "| langgraph_order_lookup | isolated |",
        );
        expect(reportMarkdown).toContain("classify + lookup");
        expect(reportMarkdown).toContain("cascade_isolated");
        const storedVerdictKeys = await store.list(verdictsPrefix("project"));
        const storedVerdicts = await Promise.all(
          storedVerdictKeys.map(async (key) =>
            JSON.parse(await storeText(store, key)),
          ),
        );
        expect(storedVerdicts).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            decision: "reject",
            abstainReason: { reason: "cascade_isolated" },
          }),
        );

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
    },
    600_000,
  );

  it.skipIf(skipDocker)(
    "confirms a mixed-vendor LangGraph family with a judge outside the final node's model family",
    async () => {
      const { root, repo, traces } = await langgraphFixtureCopy(
        "mixed-vendor-confirm",
      );
      const spans = JSON.parse(await readFile(traces, "utf8")) as Array<{
        name: string;
        attributes: Record<string, unknown>;
      }>;
      await writeFile(
        traces,
        JSON.stringify(
          spans.map((span) =>
            span.name === "answer"
              ? {
                  ...span,
                  attributes: {
                    ...span.attributes,
                    "gen_ai.request.model": "zeta/judge-1",
                    "gen_ai.response.model": "zeta/judge-1",
                  },
                }
              : span,
          ),
        ),
      );
      const image = await ensureLanggraphImage(root);
      const modeBConfig = await writeModeBConfig(root, repo, image);
      const { stepMap } = JSON.parse(await readFile(modeBConfig, "utf8")) as {
        stepMap: Record<string, string>;
      };
      const answerStepId = Object.keys(stepMap).find(
        (stepId) => stepMap[stepId] === "answer",
      )!;
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
            "RIGHTMODELER_MIXED_CONFIRM_API_KEY",
            "--modeb-config",
            modeBConfig,
            "--output",
            "json",
            "--repo",
            repo,
          ],
          { env: { RIGHTMODELER_MIXED_CONFIRM_API_KEY: secret } },
        );
        const output = jsonOutput(result);
        expect([0, 1], JSON.stringify(output.familyOutcomes)).toContain(
          result.code,
        );
        expect(output.executedStages).toContain("confirm");
        expect(output.familyOutcomes).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            confirmation: expect.objectContaining({ status: "confirmed" }),
          }),
        );

        const store = new FsStore(join(repo, ".rightmodeler"));
        const facts = (await Promise.all(
          (await store.list(factsPrefix("project"))).map(async (key) =>
            JSON.parse(await storeText(store, key)),
          ),
        )) as Array<Record<string, unknown>>;
        const executions = new Map(
          facts
            .filter(
              ({ executionId, caseId }) =>
                typeof executionId === "string" && typeof caseId === "string",
            )
            .map((fact) => [fact.executionId as string, fact]),
        );
        const judges: Record<string, string[]> = {};
        for (const { executionId, evaluatorId } of facts.filter(
          ({ assessmentId }) => typeof assessmentId === "string",
        )) {
          const execution = executions.get(executionId as string)!;
          const role = String(execution.caseId).startsWith("confirm-")
            ? "confirm"
            : execution.stepId === answerStepId
              ? "answer"
              : "upstream";
          judges[role] = [
            ...new Set([...(judges[role] ?? []), evaluatorId as string]),
          ];
        }
        expect(judges).toEqual({
          confirm: ["yotta/judge-2"],
          answer: ["yotta/judge-2"],
          upstream: ["zeta/judge-1"],
        });
      } finally {
        await stub.close();
      }
    },
    600_000,
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
