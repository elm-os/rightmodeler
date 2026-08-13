import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  computeRunSpecDigest,
  confirmPlanKey,
  executionSchema,
  factsPrefix,
  FsStore,
  type Execution,
} from "@rightmodeler/core";
import {
  createDockerExecutor,
  type DockerExecutor,
} from "@rightmodeler/executor";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createBudget } from "./budget.js";
import {
  confirmSwapSet,
  type ConfirmModeB,
  type ConfirmSwapSetInput,
  type ConfirmSwapSetResult,
} from "./confirm.js";
import type {
  ModeBSwapPolicy,
  ReplayModeBInput,
  ReplayModeBResult,
} from "./driver-modeb.js";
import { writeReplayFact } from "./driver.js";
import type { ModelCatalogEntry } from "./provider.js";
import type { ReplayStep } from "./shortlist.js";

const temporaryDirectories: string[] = [];
const projectId = "confirm-test";
const execFileAsync = promisify(execFile);
const testTimeoutMs = 240_000;
const fixturePath = join(
  import.meta.dirname,
  "../../../fixtures/langgraph-app",
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "CONFIRM_MODEB_TEST_API_KEY";
const currentModels: Readonly<Record<string, string>> = {
  classify: "acme/large-1",
  lookup: "acme/max-1",
  answer: "acme/large-1",
};

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

interface StubProvider {
  readonly port: number;
  close(): Promise<void>;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

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
    // Build the pinned fixture runtime once when it is not cached locally.
  }
  const buildRoot = await mkdtemp(
    join(tmpdir(), "rightmodeler-confirm-image-"),
  );
  try {
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const unusedExecutor: DockerExecutor = {
  async launch() {
    throw new Error("The injected confirm runner must be used");
  },
  async status() {
    throw new Error("The injected confirm runner must be used");
  },
  async collect() {
    throw new Error("The injected confirm runner must be used");
  },
  async destroy() {
    throw new Error("The injected confirm runner must be used");
  },
  async reapOrphans() {
    throw new Error("The injected confirm runner must be used");
  },
};

function stepRecords(): ReplayStep[] {
  return Object.entries(currentModels).map(([stepId, currentModel]) => ({
    stepId,
    evidenceQuestionId: `mode-a-${stepId}`,
    currentModel,
    needsTools: stepId === "lookup",
    needsStructuredOutput: false,
    observedContextTokens: 32,
    corpusSplit: "holdout",
    selectionStage: "confirm",
  }));
}

function candidateId(policy: ModeBSwapPolicy): string {
  const entries = Object.entries(policy).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 1
    ? entries[0]![1]
    : JSON.stringify(Object.fromEntries(entries));
}

function candidateFromJudgePrompt(prompt: string): string {
  const match =
    /<<<UNTRUSTED CANDIDATE>>>\n([\s\S]*?)\n<<<END UNTRUSTED CANDIDATE>>>/.exec(
      prompt,
    );
  if (match === null) throw new Error("Judge prompt has no candidate block");
  return match[1]!;
}

function judgeChat() {
  return async (request: Parameters<ConfirmModeB["judge"]["chat"]>[0]) => {
    const candidate = candidateFromJudgePrompt(
      request.messages.map(({ content }) => content).join("\n"),
    );
    const verdict =
      candidate === "accepted" || candidate.startsWith("Deterministic reply ")
        ? "equivalent"
        : "divergent";
    return JSON.stringify({
      verdict,
      score: verdict === "equivalent" ? 1 : 0,
      justification: "deterministic confirmation judge",
    });
  };
}

interface FakeRunner {
  readonly run: (input: ReplayModeBInput) => Promise<ReplayModeBResult>;
  calls(): number;
  killNext(): void;
}

function fakeRunner(
  fails: (members: ReadonlySet<string>) => boolean,
): FakeRunner {
  let calls = 0;
  let kill = false;
  return {
    calls: () => calls,
    killNext: () => {
      kill = true;
    },
    async run(input) {
      calls += 1;
      const members = new Set(
        Object.entries(input.swapPolicy).flatMap(([stepId, model]) =>
          model === currentModels[stepId] ? [] : [stepId],
        ),
      );
      const selectedCandidateId = candidateId(input.swapPolicy);
      const executions: Execution[] = [];
      for (const recordedCase of input.cases) {
        const questionId = input.stepRecords.find(
          ({ stepId }) => stepId === recordedCase.stepId,
        )?.evidenceQuestionId;
        if (questionId === undefined) {
          throw new Error(`Missing fake step: ${recordedCase.stepId}`);
        }
        const executionId = `execution-${computeRunSpecDigest({
          questionId,
          caseId: recordedCase.caseId,
          selectedCandidateId,
        })}`;
        const execution = executionSchema.parse({
          executionId,
          evidenceQuestionId: questionId,
          caseId: recordedCase.caseId,
          stepId: recordedCase.stepId,
          candidateId: selectedCandidateId,
          trajectoryId: recordedCase.trajectoryId,
          corpusSplit: recordedCase.corpusSplit,
          selectionStage: "confirm",
          terminalOutcome: "success",
          finalOutput: fails(members) ? "degraded" : "accepted",
          attribution: "ok",
        });
        await writeReplayFact(
          input.store,
          input.budget.projectId,
          executionId,
          execution,
        );
        executions.push(execution);
      }
      if (kill) {
        kill = false;
        throw new Error("injected process death");
      }
      return {
        completed: executions.length,
        skipped: 0,
        blocked: [],
        rejectedRows: 0,
        executions,
      };
    },
  };
}

async function testContext(
  runner: FakeRunner,
  maxRunSets = 20,
): Promise<{
  root: string;
  store: FsStore;
  input: ConfirmSwapSetInput;
}> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-confirm-"));
  temporaryDirectories.push(root);
  const store = new FsStore(join(root, "store"));
  const modeBBudget = createBudget({
    store,
    projectId,
    runId: `run-${temporaryDirectories.length}`,
    authorizedTotalUsd: 1,
  });
  return {
    root,
    store,
    input: {
      family: {
        familyId: "orders",
        stepOrder: ["classify", "lookup", "answer"],
      },
      swapSet: Object.entries(currentModels).map(([stepId, currentModel]) => ({
        stepId,
        currentModel,
        candidateModel: "acme/small-1",
      })),
      cases: [
        {
          caseId: "case-1",
          stepId: "answer",
          trajectoryId: "trajectory-1",
          corpusSplit: "holdout",
          task: "Answer the recorded order request.",
          messages: [{ role: "user", content: "Where is order ORD-104?" }],
          contextTokens: 32,
          maxOutputTokens: 64,
          referenceOutput: "accepted",
          input: "Where is order ORD-104?",
        },
      ],
      modeB: {
        input: {
          executor: unusedExecutor,
          egress: {
            providerId: "fixture-provider",
            providerBaseUrl: "http://127.0.0.1:1",
            apiKeyEnv: "UNUSED_CONFIRM_TEST_KEY",
            catalog: [],
          },
          image: "unused",
          appSpec: {
            mountPath: root,
            command: () => ["unused"],
          },
          concurrency: 1,
        },
        stepRecords: stepRecords(),
        judge: {
          chat: judgeChat(),
          judgeModel: "neutral/judge",
        },
        runner: runner.run,
      },
      store,
      budget: { modeB: modeBBudget, maxRunSets },
    },
  };
}

async function readPlan(store: FsStore) {
  const entry = await store.get(confirmPlanKey(projectId, "orders"));
  if (entry === null) throw new Error("Missing confirm plan");
  return JSON.parse(Buffer.from(entry.body).toString("utf8")) as {
    verdict?: string;
    queue: Array<{
      subsetKey: string;
      members: string[];
      status: string;
    }>;
  };
}

async function executionCount(store: FsStore): Promise<number> {
  let count = 0;
  for (const key of await store.list(factsPrefix(projectId))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing fact: ${key}`);
    const value: unknown = JSON.parse(Buffer.from(entry.body).toString("utf8"));
    if (executionSchema.safeParse(value).success) count += 1;
  }
  return count;
}

function pairFailure(members: ReadonlySet<string>): boolean {
  return members.has("classify") && members.has("lookup");
}

async function startStub(): Promise<StubProvider> {
  const fixture = (await import(stubModuleUrl)) as StubProviderModule;
  return fixture.startStubProvider({ port: 0 });
}

async function realModeBContext(swapStepIds: readonly string[]): Promise<{
  store: FsStore;
  input: ConfirmSwapSetInput;
  stub: StubProvider;
}> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-confirm-modeb-"));
  temporaryDirectories.push(root);
  const store = new FsStore(join(root, "store"));
  const stub = await startStub();
  process.env[apiKeyEnv] = "fixture-host-key";
  const modeBBudget = createBudget({
    store,
    projectId: `${projectId}-modeb`,
    runId: `modeb-${swapStepIds.join("-")}`,
    authorizedTotalUsd: 1,
  });
  return {
    store,
    stub,
    input: {
      family: {
        familyId: "orders-modeb",
        stepOrder: swapStepIds,
      },
      swapSet: swapStepIds.map((stepId) => ({
        stepId,
        currentModel: currentModels[stepId]!,
        candidateModel: "acme/small-1",
      })),
      cases: [
        {
          caseId: "langgraph-tool-01",
          stepId: "answer",
          trajectoryId: "langgraph-tool-01",
          corpusSplit: "holdout",
          task: "Answer the recorded order lookup request.",
          messages: [{ role: "user", content: "Where is order ORD-104?" }],
          contextTokens: 64,
          maxOutputTokens: 256,
          referenceOutput: "Deterministic reply 81d067ab44f20e70",
          input: "Where is order ORD-104?",
        },
      ],
      modeB: {
        input: {
          executor: createDockerExecutor({
            maxBytesPerNamespace: 16 * 1024 * 1024,
          }),
          egress: {
            providerId: "stub-provider",
            providerBaseUrl: `http://127.0.0.1:${stub.port}`,
            apiKeyEnv,
            catalog,
          },
          image,
          appSpec: {
            mountPath: fixturePath,
            command: (caseFile) => [
              "python3",
              "/rightmodeler/app/main.py",
              "--case-json",
              caseFile,
            ],
            timeoutMs: 30_000,
          },
          concurrency: 1,
        },
        stepRecords: stepRecords(),
        judge: {
          chat: judgeChat(),
          judgeModel: "neutral/judge",
          providerId: "deterministic-test-judge",
        },
      },
      store,
      budget: { modeB: modeBBudget, maxRunSets: 20 },
    },
  };
}

describe("confirmSwapSet", () => {
  it("confirms a passing full swap set in exactly one run set", async () => {
    const runner = fakeRunner(() => false);
    const context = await testContext(runner);

    const result = await confirmSwapSet(context.input);

    expect(result).toMatchObject({
      familyId: "orders",
      verdict: "confirmed",
      culprits: [],
      runSetsUsed: 1,
    });
    expect(result.members).toEqual([
      { stepId: "classify", cascadeStatus: "confirmed" },
      { stepId: "lookup", cascadeStatus: "confirmed" },
      { stepId: "answer", cascadeStatus: "confirmed" },
    ]);
    expect(runner.calls()).toBe(1);
    expect((await readPlan(context.store)).queue).toEqual([
      expect.objectContaining({
        members: ["classify", "lookup", "answer"],
        status: "pass",
      }),
    ]);
  });

  it("isolates the seeded interacting pair and never rejects the answer", async () => {
    const runner = fakeRunner(pairFailure);
    const context = await testContext(runner);

    const result = await confirmSwapSet(context.input);

    expect(result).toMatchObject({
      verdict: "isolated",
      culprits: [["classify", "lookup"]],
      cascadeSeed: "classify",
    });
    expect(result.members).toEqual([
      { stepId: "classify", cascadeStatus: "cascade-seed" },
      { stepId: "lookup", cascadeStatus: "uncertain" },
      { stepId: "answer", cascadeStatus: "pass" },
    ]);
    expect(
      result.members.map(({ cascadeStatus }) => cascadeStatus),
    ).not.toContain("reject");
    expect(
      (await readPlan(context.store)).queue.every(
        ({ status }) => status === "pass" || status === "fail",
      ),
    ).toBe(true);
  });

  it("recovers completed subset facts after death without rerunning that subset", async () => {
    const runner = fakeRunner(pairFailure);
    const context = await testContext(runner);
    runner.killNext();

    await expect(confirmSwapSet(context.input)).rejects.toThrow(
      "injected process death",
    );
    expect(runner.calls()).toBe(1);
    expect(await executionCount(context.store)).toBe(1);
    expect((await readPlan(context.store)).queue[0]?.status).toBe("running");

    const resumed = await confirmSwapSet(context.input);

    expect(resumed).toMatchObject({
      verdict: "isolated",
      culprits: [["classify", "lookup"]],
      cascadeSeed: "classify",
    });
    expect(runner.calls()).toBe(resumed.runSetsUsed);
    expect(await executionCount(context.store)).toBe(resumed.runSetsUsed);
  });

  it("names the next required run-set cap and leaves a resumable frontier", async () => {
    const runner = fakeRunner(pairFailure);
    const context = await testContext(runner, 1);

    const capped = await confirmSwapSet(context.input);

    expect(capped).toMatchObject({
      verdict: "inconclusive",
      runSetsUsed: 1,
      requiredMaxRunSets: 2,
    });
    expect(runner.calls()).toBe(1);
    expect(await readPlan(context.store)).toMatchObject({
      verdict: "inconclusive",
      queue: [
        expect.objectContaining({
          members: ["classify", "lookup", "answer"],
          status: "fail",
        }),
        expect.objectContaining({ members: [], status: "pending" }),
      ],
    });

    const resumedInput: ConfirmSwapSetInput = {
      ...context.input,
      budget: { ...context.input.budget, maxRunSets: 20 },
    };
    const resumed = await confirmSwapSet(resumedInput);
    expect(resumed.verdict).toBe("isolated");
    expect(runner.calls()).toBe(resumed.runSetsUsed);
  });

  it("fails loudly instead of resetting a malformed persisted plan", async () => {
    const runner = fakeRunner(() => false);
    const context = await testContext(runner);
    await context.store.putImmutable(
      confirmPlanKey(projectId, "orders"),
      Buffer.from("{not-json", "utf8"),
    );

    await expect(confirmSwapSet(context.input)).rejects.toThrow();
    expect(runner.calls()).toBe(0);
  });

  it("does not reuse evidence when the confirmation question changes", async () => {
    const runner = fakeRunner(() => false);
    const context = await testContext(runner);
    await confirmSwapSet(context.input);

    await expect(
      confirmSwapSet({
        ...context.input,
        cases: context.input.cases.map((recordedCase) => ({
          ...recordedCase,
          task: `${recordedCase.task} Revised.`,
        })),
      }),
    ).rejects.toThrow("Confirm plan belongs to a different input");
    expect(runner.calls()).toBe(1);
  });

  it(
    "confirms an answer-only swap through the real Mode B fixture in one run set",
    async () => {
      const context = await realModeBContext(["answer"]);
      try {
        const result = await confirmSwapSet(context.input);
        expect(result).toMatchObject({
          verdict: "confirmed",
          runSetsUsed: 1,
          culprits: [],
        });
      } finally {
        await context.stub.close();
      }
    },
    testTimeoutMs,
  );

  it(
    "isolates classify and lookup through the real seeded interaction seam",
    async () => {
      const context = await realModeBContext(["classify", "lookup", "answer"]);
      try {
        const result = await confirmSwapSet(context.input);
        expect(result).toMatchObject({
          verdict: "isolated",
          culprits: [["classify", "lookup"]],
          cascadeSeed: "classify",
          members: [
            { stepId: "classify", cascadeStatus: "cascade-seed" },
            { stepId: "lookup", cascadeStatus: "uncertain" },
            { stepId: "answer", cascadeStatus: "pass" },
          ],
        });
      } finally {
        await context.stub.close();
      }
    },
    testTimeoutMs,
  );
});
