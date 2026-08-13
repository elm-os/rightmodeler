import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  executionSchema,
  factSchema,
  factsPrefix,
  FsStore,
  requestAttemptSchema,
  spendEventSchema,
  type Fact,
} from "@rightmodeler/core";
import {
  createDockerExecutor,
  type DockerCollectRequest,
  type DockerCollectResult,
  type DockerExecutor,
  type DockerLaunchSpec,
  type DockerStatus,
} from "@rightmodeler/executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBudget } from "./budget.js";
import {
  replayModeB,
  type ModeBCase,
  type ReplayModeBInput,
} from "./driver-modeb.js";
import type { ModelCatalogEntry } from "./provider.js";
import type { ReplayStep } from "./shortlist.js";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

interface TraceSpan {
  traceId: string;
  name: string;
  attributes: {
    "gen_ai.input.messages": Array<{
      parts: Array<{ content: string }>;
    }>;
    "gen_ai.output.messages": Array<{
      parts: Array<{ content: string }>;
    }>;
    "gen_ai.usage.input_tokens": number;
  };
}

interface TestContext {
  root: string;
  store: FsStore;
  stub: StubProvider;
  input: ReplayModeBInput;
  executor: DockerExecutor;
  close(): Promise<void>;
}

interface InstrumentedExecutor {
  executor: DockerExecutor;
  launches: DockerLaunchSpec[];
  launchErrors: unknown[];
  collections: DockerCollectResult[];
  statuses: Array<{ handle: string; status: DockerStatus }>;
  handles: string[];
  destroyed: string[];
  credentialFound(): boolean;
}

interface SpendMetadata {
  attemptId: string;
  logicalCallId: string;
  executionId: string;
  stepId: string;
  model: string;
  attemptGroup: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  upstreamStatus: number | null;
  upstreamSource: "provider" | "egress" | null;
  conservativeReservation?: boolean;
}

const execFileAsync = promisify(execFile);
const testTimeoutMs = 240_000;
const projectId = "modeb-test";
const apiKeyEnv = "REPLAY_MODEB_TEST_API_KEY";
const credential = "modeb-host-credential-never-persist";
const fixturePath = join(
  import.meta.dirname,
  "../../../fixtures/langgraph-app",
);
const tracePath = join(
  import.meta.dirname,
  "../../../fixtures/traces/langgraph-otel.json",
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;

const catalog: ModelCatalogEntry[] = [
  {
    id: "acme/small-1",
    family: "acme",
    contextLength: 128_000,
    pricing: { input: 0.0000002, output: 0.0000008 },
    supportsTools: true,
    supportsStructuredOutput: false,
  },
  {
    id: "acme/large-1",
    family: "acme",
    contextLength: 128_000,
    pricing: { input: 0.000001, output: 0.000003 },
    supportsTools: true,
    supportsStructuredOutput: false,
  },
  {
    id: "acme/max-1",
    family: "acme",
    contextLength: 128_000,
    pricing: { input: 0.000002, output: 0.000006 },
    supportsTools: true,
    supportsStructuredOutput: false,
  },
];

let image: string;

beforeAll(async () => {
  await execFileAsync("docker", ["version"], { encoding: "utf8" });
  const requirements = await readFile(join(fixturePath, "requirements.txt"));
  const digest = createHash("sha256")
    .update(requirements)
    .digest("hex")
    .slice(0, 12);
  image = `rightmodeler-modeb-langgraph:${digest}`;
  try {
    await execFileAsync("docker", ["image", "inspect", image], {
      encoding: "utf8",
    });
    return;
  } catch {
    // Build the pinned fixture runtime once when it is not already cached locally.
  }
  const buildRoot = await mkdtemp(join(tmpdir(), "rightmodeler-modeb-image-"));
  const dockerfile = join(buildRoot, "Dockerfile");
  await writeFile(
    dockerfile,
    [
      "FROM node:24-bookworm-slim",
      "RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*",
      "COPY requirements.txt /tmp/requirements.txt",
      "RUN pip3 install --break-system-packages --no-cache-dir -r /tmp/requirements.txt",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    await execFileAsync(
      "docker",
      ["build", "--tag", image, "--file", dockerfile, fixturePath],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}, testTimeoutMs);

afterAll(() => {
  delete process.env[apiKeyEnv];
});

async function startStub(): Promise<StubProvider> {
  const fixture = (await import(stubModuleUrl)) as StubProviderModule;
  return fixture.startStubProvider({ port: 0 });
}

async function startSelectiveAnswerProvider(
  answerMode: "rate-limit" | "malformed" | "classify-rate-limit",
): Promise<StubProvider> {
  let hitCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    hitCount += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const step = request.headers["x-rm-step"];
    if (
      step === "answer" ||
      (step === "classify" && answerMode === "classify-rate-limit")
    ) {
      if (answerMode === "malformed") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
        return;
      }
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      response.end(JSON.stringify({ error: { message: "Injected limit." } }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      messages?: unknown;
    };
    const messageText = JSON.stringify(body.messages ?? []);
    const digest = createHash("sha256")
      .update(messageText)
      .digest("hex")
      .slice(0, 16);
    const inputTokens = Math.max(8, Math.ceil(messageText.length / 4));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `selective-${digest}`,
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `Deterministic reply ${digest}`,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: 12,
          total_tokens: inputTokens + 12,
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    getHitCount: () => hitCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }),
  };
}

function steps(): ReplayStep[] {
  return [
    {
      stepId: "classify",
      evidenceQuestionId: "question-classify",
      currentModel: "acme/large-1",
      needsTools: false,
      needsStructuredOutput: false,
      observedContextTokens: 64,
      corpusSplit: "holdout",
      selectionStage: "confirm",
    },
    {
      stepId: "lookup",
      evidenceQuestionId: "question-lookup",
      currentModel: "acme/max-1",
      needsTools: true,
      needsStructuredOutput: false,
      observedContextTokens: 64,
      corpusSplit: "holdout",
      selectionStage: "confirm",
    },
    {
      stepId: "answer",
      evidenceQuestionId: "question-answer",
      currentModel: "acme/large-1",
      needsTools: false,
      needsStructuredOutput: false,
      observedContextTokens: 64,
      corpusSplit: "holdout",
      selectionStage: "confirm",
    },
  ];
}

async function recordedCases(): Promise<ModeBCase[]> {
  const spans = JSON.parse(await readFile(tracePath, "utf8")) as TraceSpan[];
  const traceIds = [...new Set(spans.map(({ traceId }) => traceId))].slice(
    0,
    3,
  );
  return traceIds.map((traceId) => {
    const trace = spans.filter((span) => span.traceId === traceId);
    const classify = trace.find(({ name }) => name === "classify")!;
    const answer = trace.find(({ name }) => name === "answer")!;
    const input =
      classify.attributes["gen_ai.input.messages"][0]!.parts[0]!.content;
    const referenceOutput =
      answer.attributes["gen_ai.output.messages"][0]!.parts[0]!.content;
    return {
      caseId: traceId,
      stepId: "lookup",
      trajectoryId: traceId,
      corpusSplit: "holdout",
      task: "Answer the recorded order lookup request.",
      messages: [{ role: "user", content: input }],
      contextTokens: Math.max(
        ...trace.map(
          ({ attributes }) => attributes["gen_ai.usage.input_tokens"],
        ),
      ),
      maxOutputTokens: 256,
      referenceOutput,
      input,
    };
  });
}

function appSpec(timeoutMs = 30_000) {
  return {
    mountPath: fixturePath,
    command: (caseFile: string) => [
      "python3",
      "/rightmodeler/app/main.py",
      "--case-json",
      caseFile,
    ],
    timeoutMs,
  };
}

async function createContext(
  selectedCases: readonly ModeBCase[],
  options: {
    executor?: DockerExecutor;
    concurrency?: number;
    stub?: StubProvider;
  } = {},
): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-modeb-test-"));
  const storeRoot = join(root, "store");
  await mkdir(storeRoot);
  const store = new FsStore(storeRoot);
  const stub = options.stub ?? (await startStub());
  process.env[apiKeyEnv] = credential;
  const executor =
    options.executor ??
    createDockerExecutor({ maxBytesPerNamespace: 16 * 1024 * 1024 });
  const budget = createBudget({
    store,
    projectId,
    runId: `run-${randomUUID()}`,
    authorizedTotalUsd: 1,
  });
  const input: ReplayModeBInput = {
    stepRecords: steps(),
    cases: selectedCases,
    swapPolicy: { lookup: "acme/small-1" },
    executor,
    egress: {
      providerId: "stub-provider",
      providerBaseUrl: `http://127.0.0.1:${stub.port}`,
      apiKeyEnv,
      catalog,
    },
    store,
    budget,
    image,
    appSpec: appSpec(),
    concurrency: options.concurrency ?? 3,
  };
  return {
    root,
    store,
    stub,
    input,
    executor,
    async close() {
      await stub.close();
      await rm(root, { recursive: true, force: true });
      delete process.env[apiKeyEnv];
    },
  };
}

async function readFacts(store: FsStore): Promise<Fact[]> {
  return Promise.all(
    (await store.list(factsPrefix(projectId))).map(async (key) => {
      const entry = await store.get(key);
      if (entry === null) throw new Error(`Missing fact: ${key}`);
      return factSchema.parse(
        JSON.parse(Buffer.from(entry.body).toString("utf8")),
      );
    }),
  );
}

async function readTree(root: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) chunks.push(await readFile(path));
    }
  }
  await visit(root);
  return Buffer.concat(chunks);
}

async function readStoreBodies(store: FsStore): Promise<Buffer> {
  const bodies: Buffer[] = [];
  for (const key of await store.list("")) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing store entry: ${key}`);
    bodies.push(Buffer.from(entry.body));
  }
  return Buffer.concat(bodies);
}

function instrumentExecutor(base: DockerExecutor): InstrumentedExecutor {
  const launches: DockerLaunchSpec[] = [];
  const collections: DockerCollectResult[] = [];
  const launchErrors: unknown[] = [];
  const statuses: Array<{ handle: string; status: DockerStatus }> = [];
  const handles: string[] = [];
  const destroyed: string[] = [];
  let foundCredential = false;
  return {
    launches,
    launchErrors,
    collections,
    statuses,
    handles,
    destroyed,
    credentialFound: () => foundCredential,
    executor: {
      async launch(spec) {
        launches.push(spec);
        if (JSON.stringify(spec).includes(credential)) foundCredential = true;
        try {
          const handle = await base.launch(spec);
          handles.push(handle);
          return handle;
        } catch (error) {
          launchErrors.push(error);
          throw error;
        }
      },
      async status(handle) {
        const status = await base.status(handle);
        statuses.push({ handle, status });
        return status;
      },
      async collect(handle, request) {
        const collected = await base.collect(handle, request);
        collections.push(collected);
        const scratch = await readTree(request.scratchHostPath);
        if (scratch.includes(credential)) foundCredential = true;
        return collected;
      },
      async destroy(handle) {
        await base.destroy(handle);
        destroyed.push(handle);
      },
      reapOrphans: (options) => base.reapOrphans(options),
    },
  };
}

function parsedFacts(facts: readonly Fact[]) {
  return {
    executions: facts.flatMap((fact) => {
      const parsed = executionSchema.safeParse(fact);
      return parsed.success ? [parsed.data] : [];
    }),
    attempts: facts.flatMap((fact) => {
      const parsed = requestAttemptSchema.safeParse(fact);
      return parsed.success ? [parsed.data] : [];
    }),
    spend: facts.flatMap((fact) => {
      const parsed = spendEventSchema.safeParse(fact);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

function spendMetadata(value: unknown): SpendMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Spend metadata must be an object");
  }
  return value as unknown as SpendMetadata;
}

function catalogPricing(model: string) {
  const pricing = catalog.find(({ id }) => id === model)?.pricing;
  if (pricing === null || pricing === undefined) {
    throw new Error(`Missing test pricing: ${model}`);
  }
  return pricing;
}

function expectedAttemptCost(
  attempt: ReturnType<typeof parsedFacts>["attempts"][number],
  metadata: SpendMetadata,
): number {
  const pricing = catalogPricing(metadata.model);
  const usage = attempt.usage;
  if (
    typeof usage === "object" &&
    usage !== null &&
    !Array.isArray(usage) &&
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number"
  ) {
    return (
      usage.inputTokens * pricing.input + usage.outputTokens * pricing.output
    );
  }
  return (
    metadata.estimatedInputTokens * pricing.input +
    metadata.maxOutputTokens * pricing.output
  );
}

function collectionText(
  collections: readonly DockerCollectResult[],
  suffix: string,
): string | undefined {
  const contents = collections
    .flatMap(({ files }) => files)
    .filter(({ namespace, path }) => `${namespace}/${path}`.endsWith(suffix))
    .at(-1)?.contents;
  return contents === undefined
    ? undefined
    : Buffer.from(contents).toString("utf8");
}

describe("Mode B replay", () => {
  it(
    "replays three recorded LangGraph cases with correlated, priced host-side facts",
    async () => {
      const cases = await recordedCases();
      const base = createDockerExecutor({
        maxBytesPerNamespace: 16 * 1024 * 1024,
      });
      const tracked = instrumentExecutor(base);
      const context = await createContext(cases, {
        executor: tracked.executor,
      });
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));

        expect(tracked.launchErrors).toEqual([]);

        expect(result).toMatchObject({
          completed: 3,
          skipped: 0,
          blocked: [],
          rejectedRows: 0,
        });
        expect(tracked.launches).toHaveLength(3);
        expect(tracked.collections).toHaveLength(3);
        expect(tracked.handles).toHaveLength(3);
        expect(tracked.destroyed).toEqual(
          expect.arrayContaining(tracked.handles),
        );
        for (const launch of tracked.launches) {
          expect(launch.image).toBe(image);
          expect(launch.command[0]).toBe("node");
          expect(launch.labels["com.rightmodeler.run"]).toBe(
            context.input.budget.runId,
          );
          expect(launch.mounts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                hostPath: fixturePath,
                containerPath: "/rightmodeler/app",
                readOnly: true,
              }),
              expect.objectContaining({
                containerPath: "/rightmodeler/runtime",
                readOnly: true,
              }),
            ]),
          );
        }
        for (const collection of tracked.collections) {
          const caseFile = collection.files.find(
            ({ namespace, path }) =>
              namespace === "driver" && path === "case.json",
          );
          if (caseFile === undefined) throw new Error("Missing workload case");
          const workloadCase = JSON.parse(
            Buffer.from(caseFile.contents).toString("utf8"),
          ) as { caseId: string; input: unknown };
          const recordedCase = cases.find(
            ({ caseId }) => caseId === workloadCase.caseId,
          );
          expect(workloadCase).toEqual({
            caseId: recordedCase?.caseId,
            input: recordedCase?.input,
          });
        }
        expect(facts.executions).toHaveLength(3);
        const envelopes = tracked.collections.map((collection) => {
          const stdout = collection.files.find(
            ({ namespace, path }) =>
              namespace === "workload" && path === "stdout.jsonl",
          );
          if (stdout === undefined) throw new Error("Missing workload stdout");
          return JSON.parse(
            Buffer.from(stdout.contents)
              .toString("utf8")
              .trimEnd()
              .split("\n")
              .at(-1)!,
          ) as { caseId: string; finalOutput: unknown };
        });
        for (const recordedCase of cases) {
          const execution = facts.executions.find(
            ({ caseId }) => caseId === recordedCase.caseId,
          );
          const envelope = envelopes.find(
            ({ caseId }) => caseId === recordedCase.caseId,
          );
          expect(execution).toMatchObject({
            terminalOutcome: "success",
            attribution: "ok",
            finalOutput: recordedCase.referenceOutput,
          });
          expect(execution?.finalOutput).toEqual(envelope?.finalOutput);
          const attempts = facts.attempts.filter(
            ({ executionId }) => executionId === execution?.executionId,
          );
          expect(attempts).toHaveLength(3);
          expect(attempts.every(({ costUsd }) => costUsd > 0)).toBe(true);
          expect(attempts.every(({ costIsEstimate }) => costIsEstimate)).toBe(
            true,
          );
          const executionSpend = facts.spend.filter((event) =>
            JSON.stringify(event.reconcilableTo).includes(
              execution?.executionId ?? "missing",
            ),
          );
          expect(
            executionSpend
              .map((event) => spendMetadata(event.reconcilableTo).stepId)
              .sort(),
          ).toEqual(["answer", "classify", "lookup"]);
          expect(
            executionSpend.find((event) =>
              JSON.stringify(event.reconcilableTo).includes(
                '"stepId":"lookup"',
              ),
            )?.reconcilableTo,
          ).toMatchObject({ model: "acme/small-1" });
        }
        const spendByAttempt = new Map(
          facts.spend.map((event) => {
            const metadata = spendMetadata(event.reconcilableTo);
            return [metadata.attemptId, { event, metadata }] as const;
          }),
        );
        expect(spendByAttempt.size).toBe(facts.attempts.length);
        for (const attempt of facts.attempts) {
          const matched = spendByAttempt.get(attempt.attemptId);
          expect(matched).toBeDefined();
          expect(matched?.metadata.executionId).toBe(attempt.executionId);
          expect(attempt.costUsd).toBeCloseTo(
            expectedAttemptCost(attempt, matched!.metadata),
          );
          expect(matched?.event.costUsd).toBeCloseTo(attempt.costUsd);
        }
        expect(tracked.credentialFound()).toBe(false);
        const storeBytes = await readTree(join(context.root, "store"));
        expect(storeBytes.includes(credential)).toBe(false);
        expect(
          storeBytes.includes(Buffer.from(credential).toString("base64")),
        ).toBe(false);
        expect(JSON.stringify(await readFacts(context.store))).not.toContain(
          credential,
        );
        expect(
          (await readStoreBodies(context.store)).includes(credential),
        ).toBe(false);
        const containers = await execFileAsync("docker", [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.rightmodeler.run=${context.input.budget.runId}`,
        ]);
        expect(containers.stdout.trim()).toBe("");
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "charges both physical attempts for one SDK retry and writes one outcome",
    async () => {
      const [recordedCase] = await recordedCases();
      const retryCase = {
        ...recordedCase!,
        headers: { "x-stub-429-once": "modeb-retry" },
      };
      const context = await createContext([retryCase], { concurrency: 1 });
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 1, blocked: [] });
        expect(facts.executions).toHaveLength(1);
        expect(facts.executions[0]).toMatchObject({
          terminalOutcome: "success",
          attribution: "ok",
          finalOutput: retryCase.referenceOutput,
        });
        expect(facts.attempts).toHaveLength(4);
        const spend = facts.spend.filter(
          ({ actor }) => actor === "replay-driver",
        );
        expect(spend).toHaveLength(4);
        expect(
          spend.reduce((sum, event) => sum + event.costUsd, 0),
        ).toBeCloseTo(
          facts.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
        );
        const groupCounts = new Map<number, number>();
        const logicalCallCounts = new Map<string, number>();
        for (const event of spend) {
          const metadata = spendMetadata(event.reconcilableTo);
          const group = metadata.attemptGroup;
          groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
          logicalCallCounts.set(
            metadata.logicalCallId,
            (logicalCallCounts.get(metadata.logicalCallId) ?? 0) + 1,
          );
          const attempt = facts.attempts.find(
            ({ attemptId }) => attemptId === metadata.attemptId,
          );
          expect(attempt).toBeDefined();
          expect(event.costUsd).toBeCloseTo(
            expectedAttemptCost(attempt!, metadata),
          );
        }
        expect([...groupCounts.keys()].sort()).toEqual([1, 2, 3]);
        expect([...groupCounts.values()].sort()).toEqual([1, 1, 2]);
        expect([...logicalCallCounts.values()].sort()).toEqual([1, 1, 2]);
        expect(
          facts.attempts.map(({ streamOutcome }) => streamOutcome).sort(),
        ).toEqual(["completed", "completed", "completed", "provider_error"]);
        expect((await context.input.budget.state()).spentUsd).toBeCloseTo(
          facts.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
        );
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "reports an exhausted terminal rate limit as blocked after earlier steps succeed",
    async () => {
      const [recordedCase] = await recordedCases();
      const provider = await startSelectiveAnswerProvider("rate-limit");
      const context = await createContext([recordedCase!], {
        concurrency: 1,
        stub: provider,
      });
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));

        expect(result).toMatchObject({
          completed: 0,
          skipped: 0,
          rejectedRows: 0,
          blocked: [
            expect.objectContaining({ kind: "rate-limit", observedCeiling: 1 }),
          ],
        });
        expect(facts.executions).toHaveLength(0);
        expect(facts.attempts).toHaveLength(5);
        expect(facts.spend).toHaveLength(5);
        expect(
          facts.spend
            .map((event) => spendMetadata(event.reconcilableTo))
            .filter(({ stepId }) => stepId === "answer")
            .map(({ upstreamStatus }) => upstreamStatus),
        ).toEqual([429, 429, 429]);
        expect(provider.getHitCount()).toBe(5);
        expect((await context.input.budget.state()).spentUsd).toBeCloseTo(
          facts.attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
        );
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "keeps an exhausted rate limit blocked when the workload emits a fallback envelope",
    async () => {
      const [recordedCase] = await recordedCases();
      const provider = await startSelectiveAnswerProvider("rate-limit");
      const context = await createContext([recordedCase!], {
        concurrency: 1,
        stub: provider,
      });
      const fallbackProgram = [
        "import json, os, subprocess, sys",
        "case_file = sys.argv[1]",
        'result = subprocess.run(["python3", "/rightmodeler/app/main.py", "--case-json", case_file])',
        "if result.returncode == 0:",
        "    raise SystemExit(0)",
        'with open(case_file, encoding="utf8") as source:',
        "    case = json.load(source)",
        'print(json.dumps({"runId": os.environ["RM_RUN_ID"], "caseId": case["caseId"], "executionId": os.environ["RM_EXECUTION_ID"], "finalOutput": "fallback"}))',
      ].join("\n");
      context.input = {
        ...context.input,
        appSpec: {
          ...appSpec(),
          command: (caseFile) => ["python3", "-c", fallbackProgram, caseFile],
        },
      };
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({
          completed: 0,
          blocked: [expect.objectContaining({ kind: "rate-limit" })],
        });
        expect(facts.executions).toEqual([]);
        expect(facts.attempts).toHaveLength(5);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "keeps an earlier exhausted rate-limit group blocked after a later successful call",
    async () => {
      const [recordedCase] = await recordedCases();
      const provider = await startSelectiveAnswerProvider(
        "classify-rate-limit",
      );
      const context = await createContext([recordedCase!], {
        concurrency: 1,
        stub: provider,
      });
      const program = [
        "import json, os, sys, urllib.error, urllib.request, uuid",
        "case_file = sys.argv[1]",
        'base = os.environ["OPENAI_BASE_URL"] + "/chat/completions"',
        'body = json.dumps({"model": "acme/large-1", "messages": [], "max_tokens": 1}).encode()',
        "def call(step):",
        '    request = urllib.request.Request(base, data=body, headers={"content-type": "application/json", "x-rm-step": step, "x-rm-call": str(uuid.uuid4())}, method="POST")',
        "    try:",
        "        urllib.request.urlopen(request).read()",
        "    except urllib.error.HTTPError:",
        "        pass",
        'call("classify")',
        'call("lookup")',
        'with open(case_file, encoding="utf8") as source:',
        "    case = json.load(source)",
        'print(json.dumps({"runId": os.environ["RM_RUN_ID"], "caseId": case["caseId"], "executionId": os.environ["RM_EXECUTION_ID"], "finalOutput": "fallback"}))',
      ].join("\n");
      context.input = {
        ...context.input,
        appSpec: {
          ...appSpec(),
          command: (caseFile) => ["python3", "-c", program, caseFile],
        },
      };
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({
          completed: 0,
          blocked: [expect.objectContaining({ kind: "rate-limit" })],
        });
        expect(facts.executions).toEqual([]);
        expect(facts.attempts).toHaveLength(2);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "attributes a missing envelope to a malformed successful provider response",
    async () => {
      const [recordedCase] = await recordedCases();
      const provider = await startSelectiveAnswerProvider("malformed");
      const context = await createContext([recordedCase!], {
        concurrency: 1,
        stub: provider,
      });
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 1, blocked: [] });
        expect(facts.executions).toEqual([
          expect.objectContaining({
            terminalOutcome: "failure",
            finalOutput: null,
            attribution: "ok",
          }),
        ]);
        const answerSpend = facts.spend
          .map((event) => spendMetadata(event.reconcilableTo))
          .filter(({ stepId }) => stepId === "answer");
        expect(answerSpend.length).toBeGreaterThan(0);
        expect(
          answerSpend.every(
            ({ upstreamSource, upstreamStatus }) =>
              upstreamSource === "provider" && upstreamStatus === 200,
          ),
        ).toBe(true);
        const answerAttemptIds = new Set(
          answerSpend.map(({ attemptId }) => attemptId),
        );
        expect(
          facts.attempts
            .filter(({ attemptId }) => answerAttemptIds.has(attemptId))
            .every(({ streamOutcome }) => streamOutcome === "truncated"),
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "maps an empty envelope with zero output tokens to silent failure",
    async () => {
      const [recordedCase] = await recordedCases();
      const emptyCase = {
        ...recordedCase!,
        headers: { "x-stub-empty": "1" },
      };
      const context = await createContext([emptyCase], { concurrency: 1 });
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));

        expect(result).toMatchObject({ completed: 1, blocked: [] });
        expect(facts.executions).toEqual([
          expect.objectContaining({
            terminalOutcome: "failure",
            finalOutput: "",
            attribution: "silent-failure",
          }),
        ]);
        expect(facts.attempts).toHaveLength(2);
        expect(
          facts.attempts.every((attempt) => {
            const usage = attempt.usage;
            return (
              typeof usage === "object" &&
              usage !== null &&
              !Array.isArray(usage) &&
              usage.outputTokens === 0
            );
          }),
        ).toBe(true);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "marks a caught fail-closed correlation row as lost attribution",
    async () => {
      const [recordedCase] = await recordedCases();
      const context = await createContext([recordedCase!], { concurrency: 1 });
      const correlationProgram = [
        "import json, os, sys, urllib.error, urllib.request",
        "case_file = sys.argv[1]",
        'body = json.dumps({"model": "acme/large-1", "messages": [], "max_tokens": 1}).encode()',
        'request = urllib.request.Request(os.environ["OPENAI_BASE_URL"] + "/chat/completions", data=body, headers={"content-type": "application/json", "x-rm-step": "classify"}, method="POST")',
        "try:",
        "    urllib.request.urlopen(request)",
        "except urllib.error.HTTPError:",
        "    pass",
        'with open(case_file, encoding="utf8") as source:',
        "    case = json.load(source)",
        'print(json.dumps({"runId": os.environ["RM_RUN_ID"], "caseId": case["caseId"], "executionId": os.environ["RM_EXECUTION_ID"], "finalOutput": "fallback"}))',
      ].join("\n");
      context.input = {
        ...context.input,
        appSpec: {
          ...appSpec(),
          command: (caseFile) => [
            "python3",
            "-c",
            correlationProgram,
            caseFile,
          ],
        },
      };
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 1, blocked: [] });
        expect(facts.executions).toEqual([
          expect.objectContaining({
            terminalOutcome: "failure",
            finalOutput: null,
            attribution: "lost",
          }),
        ]);
        expect(facts.attempts).toEqual([]);
        expect(context.stub.getHitCount()).toBe(0);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "rejects a successful envelope that never exercised the target step",
    async () => {
      const [recordedCase] = await recordedCases();
      const context = await createContext([recordedCase!], { concurrency: 1 });
      const program = [
        "import json, os, sys",
        'with open(sys.argv[1], encoding="utf8") as source:',
        "    case = json.load(source)",
        'print(json.dumps({"runId": os.environ["RM_RUN_ID"], "caseId": case["caseId"], "executionId": os.environ["RM_EXECUTION_ID"], "finalOutput": "forged"}))',
      ].join("\n");
      context.input = {
        ...context.input,
        appSpec: {
          ...appSpec(),
          command: (caseFile) => ["python3", "-c", program, caseFile],
        },
      };
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 1, blocked: [] });
        expect(facts.executions).toEqual([
          expect.objectContaining({
            terminalOutcome: "failure",
            finalOutput: null,
            attribution: "lost",
          }),
        ]);
        expect(facts.attempts).toEqual([]);
        expect(context.stub.getHitCount()).toBe(0);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "rehydrates a destroyed container and skips the terminal case on rerun",
    async () => {
      const [recordedCase] = await recordedCases();
      const restartCase = {
        ...recordedCase!,
        headers: { "x-stub-hold-before-response-ms": "500" },
      };
      const base = createDockerExecutor({
        maxBytesPerNamespace: 16 * 1024 * 1024,
      });
      const tracked = instrumentExecutor(base);
      let destroyed = false;
      let killer: Promise<void> | undefined;
      const executor: DockerExecutor = {
        ...tracked.executor,
        async launch(spec) {
          const handle = await tracked.executor.launch(spec);
          if (!destroyed) {
            destroyed = true;
            killer = (async () => {
              const checkpoint = join(
                spec.scratchHostPath,
                "proxy",
                "checkpoints",
                `${spec.env.RM_CASE_ID}.jsonl`,
              );
              const attemptSpool = join(
                spec.scratchHostPath,
                "proxy",
                "attempts",
                `${spec.env.RM_EXECUTION_ID}.0.jsonl`,
              );
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline) {
                try {
                  const checkpointReady = (
                    await readFile(checkpoint, "utf8")
                  ).endsWith("\n");
                  const reservationReady = (
                    await readFile(attemptSpool, "utf8")
                  ).includes('"kind":"attempt_reservation"');
                  if (checkpointReady && reservationReady) {
                    await base.destroy(handle);
                    return;
                  }
                } catch {
                  // The proxy has not checkpointed yet.
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              throw new Error("Timed out waiting for the first checkpoint");
            })();
          }
          return handle;
        },
      };
      const context = await createContext([restartCase], {
        executor,
        concurrency: 1,
      });
      try {
        const first = await replayModeB(context.input);
        await killer;
        expect(first.completed).toBe(1);
        expect(first.executions).toEqual([
          expect.objectContaining({
            terminalOutcome: "success",
            attribution: "ok",
            finalOutput: restartCase.referenceOutput,
          }),
        ]);
        expect(tracked.launches).toHaveLength(2);
        expect(tracked.launches[1]?.env).toMatchObject({
          RM_EXECUTION_ID: tracked.launches[0]?.env.RM_EXECUTION_ID,
          RM_RESUME: "1",
        });
        expect(tracked.launches[1]?.scratchHostPath).toBe(
          tracked.launches[0]?.scratchHostPath,
        );
        const checkpoint = collectionText(
          tracked.collections,
          `checkpoints/${recordedCase!.caseId}.jsonl`,
        );
        expect(
          checkpoint
            ?.trimEnd()
            .split("\n")
            .map(
              (line) =>
                (JSON.parse(line) as { attemptGroup: number }).attemptGroup,
            ),
        ).toEqual([1, 2, 3, 4]);

        const firstFacts = parsedFacts(await readFacts(context.store));
        expect(firstFacts.executions).toHaveLength(1);
        expect(firstFacts.executions[0]?.executionId).toBe(
          tracked.launches[0]?.env.RM_EXECUTION_ID,
        );
        expect(firstFacts.attempts).toHaveLength(4);
        expect(
          new Set(firstFacts.attempts.map(({ attemptId }) => attemptId)).size,
        ).toBe(4);
        expect(firstFacts.spend).toHaveLength(4);
        expect(
          firstFacts.spend
            .map((event) => spendMetadata(event.reconcilableTo).attemptGroup)
            .sort(),
        ).toEqual([1, 2, 3, 4]);
        expect(
          firstFacts.spend.find(
            (event) => spendMetadata(event.reconcilableTo).attemptGroup === 1,
          )?.reconcilableTo,
        ).toMatchObject({ conservativeReservation: true });

        const second = await replayModeB(context.input);
        expect(second).toMatchObject({ completed: 0, skipped: 1 });
        const third = await replayModeB(context.input);
        expect(third).toMatchObject({ completed: 0, skipped: 1 });
        expect(tracked.launches).toHaveLength(2);
        const facts = parsedFacts(await readFacts(context.store));
        expect(facts.executions).toHaveLength(1);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "rejects a forged scratch row instead of ingesting it",
    async () => {
      const [recordedCase] = await recordedCases();
      const base = createDockerExecutor({
        maxBytesPerNamespace: 16 * 1024 * 1024,
      });
      let planted = false;
      const executor: DockerExecutor = {
        launch: (spec) => base.launch(spec),
        status: (handle) => base.status(handle),
        async collect(handle, request) {
          if (!planted) {
            planted = true;
            const executionId = await executionIdFromScratch(request);
            const attemptPath = join(
              request.scratchHostPath,
              "proxy",
              "attempts",
              `${executionId}.0.jsonl`,
            );
            const legitimate = JSON.parse(
              (await readFile(attemptPath, "utf8")).split("\n")[0]!,
            ) as Record<string, unknown>;
            await appendFile(
              attemptPath,
              `${JSON.stringify({
                ...legitimate,
                caseId: "forged-case",
                attemptId: "forged-attempt",
              })}\n`,
              "utf8",
            );
          }
          return base.collect(handle, request);
        },
        destroy: (handle) => base.destroy(handle),
        reapOrphans: (options) => base.reapOrphans(options),
      };
      const context = await createContext([recordedCase!], {
        executor,
        concurrency: 1,
      });
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 1, rejectedRows: 1 });
        expect(facts.attempts).toHaveLength(3);
        expect(facts.spend).toHaveLength(3);
        expect(facts.attempts.map(({ attemptId }) => attemptId)).not.toContain(
          "forged-attempt",
        );
        expect(
          facts.spend.map(
            (event) => spendMetadata(event.reconcilableTo).attemptId,
          ),
        ).not.toContain("forged-attempt");
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "records a timed-out case as lost and continues to the next case",
    async () => {
      const cases = (await recordedCases()).slice(0, 2);
      const timeoutCases = [
        {
          ...cases[0]!,
          headers: { "x-fault-stall": "5000" },
        },
        cases[1]!,
      ];
      const base = createDockerExecutor({
        maxBytesPerNamespace: 16 * 1024 * 1024,
      });
      const tracked = instrumentExecutor(base);
      const context = await createContext(timeoutCases, {
        concurrency: 1,
        executor: tracked.executor,
      });
      context.input = { ...context.input, appSpec: appSpec(2_500) };
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 2, blocked: [] });
        expect(facts.executions).toHaveLength(2);
        const timedOutExecution = facts.executions.find(
          ({ caseId }) => caseId === timeoutCases[0]!.caseId,
        );
        expect(timedOutExecution).toMatchObject({
          terminalOutcome: "failure",
          attribution: "lost",
        });
        expect(
          facts.attempts.filter(
            ({ executionId }) => executionId === timedOutExecution?.executionId,
          ),
        ).toEqual([
          expect.objectContaining({
            streamOutcome: "truncated",
            usage: null,
            costIsEstimate: true,
          }),
        ]);
        expect(
          collectionText(
            tracked.collections,
            `checkpoints/${timeoutCases[0]!.caseId}.jsonl`,
          ),
        ).toContain('"attemptGroup":1');
        expect(
          facts.executions.find(
            ({ caseId }) => caseId === timeoutCases[1]!.caseId,
          ),
        ).toMatchObject({ terminalOutcome: "success", attribution: "ok" });
        expect(tracked.launches).toHaveLength(2);
        const timedOutHandle = tracked.handles[0];
        expect(
          tracked.statuses.some(
            ({ handle, status }) =>
              handle === timedOutHandle && status.timedOut,
          ),
        ).toBe(true);
        expect(tracked.destroyed).toEqual(
          expect.arrayContaining(tracked.handles),
        );
        for (const handle of tracked.handles) {
          await expect(
            execFileAsync("docker", ["inspect", handle]),
          ).rejects.toBeDefined();
        }
        expect(context.stub.getHitCount()).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "records every pending case as lost when host egress cannot start",
    async () => {
      const cases = (await recordedCases()).slice(0, 2);
      const base = createDockerExecutor({
        maxBytesPerNamespace: 16 * 1024 * 1024,
      });
      const tracked = instrumentExecutor(base);
      const context = await createContext(cases, {
        concurrency: 2,
        executor: tracked.executor,
      });
      context.input = {
        ...context.input,
        egress: {
          ...context.input.egress,
          providerBaseUrl: "file:///not-an-egress-provider",
        },
      };
      try {
        const result = await replayModeB(context.input);
        const facts = parsedFacts(await readFacts(context.store));
        expect(result).toMatchObject({ completed: 2, blocked: [] });
        expect(result.executions).toHaveLength(2);
        expect(
          result.executions.every(
            ({ terminalOutcome, attribution }) =>
              terminalOutcome === "failure" && attribution === "lost",
          ),
        ).toBe(true);
        expect(facts.executions).toHaveLength(2);
        expect(facts.attempts).toEqual([]);
        expect(facts.spend).toEqual([]);
        expect(tracked.launches).toEqual([]);
      } finally {
        await context.close();
      }
    },
    testTimeoutMs,
  );
});

async function executionIdFromScratch(
  request: DockerCollectRequest,
): Promise<string> {
  const names = await readdir(
    join(request.scratchHostPath, "proxy", "attempts"),
  );
  const name = names.find((candidate) => candidate.endsWith(".0.jsonl"));
  if (name === undefined) throw new Error("Missing attempt spool");
  return name.slice(0, -".0.jsonl".length);
}
