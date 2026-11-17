import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
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
  factsPrefix,
  readLedger,
  setupStateKey,
  type JsonValue,
} from "@rightmodeler/core";
import { minimumTrialsForFloor } from "@rightmodeler/kernel";
import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { expect } from "vitest";

export const cliPath = fileURLToPath(
  new URL("../../dist/cli.js", import.meta.url),
);
export const demoAppPath = fileURLToPath(
  new URL("../../../../fixtures/demo-app", import.meta.url),
);
export const traceFixturesDir = fileURLToPath(
  new URL("../../../../fixtures/traces/", import.meta.url),
);
export const traceFixtures = readdirSync(traceFixturesDir)
  .filter((name) => /\.(json|jsonl)$/u.test(name))
  .sort();
const langgraphAppPath = fileURLToPath(
  new URL("../../../../fixtures/langgraph-app", import.meta.url),
);
const langgraphTracesPath = fileURLToPath(
  new URL("../../../../fixtures/traces/langgraph-otel.json", import.meta.url),
);
export const tracesPath = fileURLToPath(
  new URL("../../../../fixtures/traces/otel-genai.json", import.meta.url),
);
export const demoGraphPath = fileURLToPath(
  new URL(
    "../../../../fixtures/code-graph/demo-app.graph.json",
    import.meta.url,
  ),
);
export const openaiModelsPath = fileURLToPath(
  new URL("../../../../fixtures/catalogs/openai-models.json", import.meta.url),
);
export const aiGatewayChatResponsePath = fileURLToPath(
  new URL(
    "../../../../fixtures/catalogs/ai-gateway-chat-response.json",
    import.meta.url,
  ),
);
const aiSdkAppPath = fileURLToPath(
  new URL("../../../../fixtures/ai-sdk-app", import.meta.url),
);
export const aiSdkLegacyTracesPath = fileURLToPath(
  new URL(
    "../../../../fixtures/traces/ai-sdk-v7-legacy.jsonl",
    import.meta.url,
  ),
);
export const promptfooCommandPath = fileURLToPath(
  new URL("../../../../fixtures/promptfoo-stub/run.mjs", import.meta.url),
);
export const promptfooAssertionsPath = fileURLToPath(
  new URL(
    "../../../../fixtures/promptfoo-stub/assertions.yaml",
    import.meta.url,
  ),
);
export const livePromptfoo = process.env.RIGHTMODELER_LIVE_PROMPTFOO;
const stubModuleUrl = new URL(
  "../../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const evaluatorStubModuleUrl = new URL(
  "../../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const githubStubModuleUrl = new URL(
  "../../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
export const temporaryDirectories: string[] = [];
export const secret = "phase-a-api-key-must-not-persist";
export const minimumHoldout = minimumTrialsForFloor(0.85, 1);
export const execFileAsync = promisify(execFile);

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
  getMaxInFlight(): number;
}

export interface RecordingStubProvider extends StubProvider {
  getRequestHeaders(): Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    model?: string;
  }>;
  getRequests(): Array<Record<string, unknown>>;
}

interface StubProviderModule {
  startStubProvider(options: {
    port: number;
    bareModelIds?: boolean;
    catalogTotalCount?: number;
    errorModels?: string[];
    includeFreeModel?: boolean;
    malformedJudgeModels?: string[];
    omitCatalogModels?: string[];
    rateLimitedModels?: string[];
    rateLimitMessageIncludes?: string;
    releasedDaysAgo?: Record<string, number>;
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

export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
}

export async function regradeAfterAssertionsEdit(input: {
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

export async function fixtureCopy(
  label: string,
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "demo-app");
  await cp(demoAppPath, repo, { recursive: true });
  await initializeFixtureRepository(repo);
  return { root, repo };
}

export async function renamedModelFixture(
  label: string,
  model: string,
): Promise<{ root: string; repo: string; traces: string }> {
  const { root, repo } = await fixtureCopy(label);
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
        (await readFile(path, "utf8")).replaceAll("acme/large-1", model),
      );
    }),
  );
  const traces = join(root, "otel-genai.json");
  await writeFile(
    traces,
    (await readFile(tracesPath, "utf8")).replaceAll("acme/large-1", model),
  );
  return { root, repo, traces };
}

export function lastStderrEvent(result: ChildResult): {
  code?: string;
  message?: string;
} {
  return JSON.parse(result.stderr.trim().split("\n").at(-1)!) as {
    code?: string;
    message?: string;
  };
}

export async function aiSdkFixtureCopy(
  label: string,
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "ai-sdk-app");
  await cp(aiSdkAppPath, repo, { recursive: true });
  await initializeFixtureRepository(repo);
  return { root, repo };
}

export async function fixtureHome(root: string): Promise<string> {
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return home;
}

export async function initializeFixtureRepository(repo: string): Promise<void> {
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

export async function narrowDemoFixtureForApply(
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

export async function writeToolCallTraces(
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

export function warningMessages(stderr: string, code: string): string[] {
  return stderr
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { code?: string; message: string })
    .filter((event) => event.code === code)
    .map(({ message }) => message);
}

export function utcDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export async function langgraphFixtureCopy(
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

export async function ensureLanggraphImage(root: string): Promise<string> {
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

export async function writeModeBConfig(
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

export function runCli(
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

export function jsonOutput(result: ChildResult): Record<string, unknown> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export async function startStub(
  options: {
    bareModelIds?: boolean;
    catalogTotalCount?: number;
    errorModels?: string[];
    includeFreeModel?: boolean;
    malformedJudgeModels?: string[];
    omitCatalogModels?: string[];
    rateLimitedModels?: string[];
    rateLimitMessageIncludes?: string;
    releasedDaysAgo?: Record<string, number>;
    servedModels?: Record<string, string>;
  } = {},
): Promise<RecordingStubProvider> {
  const module = (await import(stubModuleUrl)) as StubProviderModule;
  return module.startStubProvider({ port: 0, ...options });
}

export async function startUnpricedCatalogStub(
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

export async function startCatalogDriftStub(
  keep: (id: string) => boolean = (id) => id.startsWith("zeta/"),
): Promise<StubProvider> {
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
          : catalog.data.filter(({ id }) => keep(id));
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

export async function startRenamedCatalogStub(
  renames: Readonly<Record<string, string>>,
): Promise<{
  port: number;
  upstream: RecordingStubProvider;
  close(): Promise<void>;
}> {
  const upstream = await startStub();
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
    const text = await upstreamResponse.text();
    response.writeHead(upstreamResponse.status, {
      "content-type":
        upstreamResponse.headers.get("content-type") ?? "application/json",
    });
    if (request.method === "GET" && request.url === "/v1/models") {
      const catalog = JSON.parse(text) as { data: Array<{ id: string }> };
      response.end(
        JSON.stringify({
          ...catalog,
          data: catalog.data.map((model) => ({
            ...model,
            id: renames[model.id] ?? model.id,
          })),
        }),
      );
      return;
    }
    response.end(text);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await upstream.close();
    throw new Error("Renamed catalog stub did not bind a TCP port");
  }
  return {
    port: address.port,
    upstream,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await upstream.close();
    },
  };
}

export async function waitForTerminalRun(
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

export async function startEvaluatorStub(
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

export async function startGithubStub(token: string): Promise<GithubStub> {
  const module = (await import(githubStubModuleUrl)) as GithubStubModule;
  return module.startGithubStub({ port: 0, token });
}

export async function startConfirmStub(): Promise<StubProvider> {
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

export async function storeText(store: FsStore, key: string): Promise<string> {
  const entry = await store.get(key);
  if (entry === null) throw new Error(`Missing store key: ${key}`);
  return Buffer.from(entry.body).toString("utf8");
}

export async function allFileText(root: string): Promise<string> {
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

export async function removeExecutionFacts(
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

export async function rewriteStageArtifact(
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

export async function readStageArtifact(
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
