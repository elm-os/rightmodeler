import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  factSchema,
  factsPrefix,
  FsStore,
  type Fact,
} from "@rightmodeler/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BudgetRefusalError,
  createBudget,
  createProvider,
  replayModeA,
  shortlist,
  type JudgeChat,
  type ModelCatalogEntry,
  type ProviderClient,
  type RecordedCase,
  type ReplayStep,
} from "./index.js";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;

const projectId = "replay-test";
const runId = "run-1";
const fakeKey = "fake-provider-key-never-persist";

async function startStub(): Promise<StubProvider> {
  const fixture = (await import(stubModuleUrl)) as StubProviderModule;
  return fixture.startStubProvider({ port: 0 });
}

function baseUrl(stub: StubProvider): string {
  return `http://127.0.0.1:${stub.port}/v1`;
}

function step(overrides: Partial<ReplayStep> = {}): ReplayStep {
  return {
    stepId: "step-1",
    evidenceQuestionId: "question-1",
    currentModel: "acme/large-1",
    needsTools: false,
    needsStructuredOutput: false,
    observedContextTokens: 64,
    ...overrides,
  };
}

function recordedCase(overrides: Partial<RecordedCase> = {}): RecordedCase {
  return {
    caseId: "case-1",
    stepId: "step-1",
    trajectoryId: "trajectory-1",
    corpusSplit: "shortlist",
    system: "Keep the recorded request unchanged.",
    messages: [{ role: "user", content: "Summarize this case." }],
    temperature: 0.25,
    contextTokens: 64,
    maxOutputTokens: 32,
    referenceOutput: "Accepted summary",
    ...overrides,
  };
}

function judge(counter?: { calls: number }): JudgeChat {
  return async (request) => {
    if (counter !== undefined) counter.calls += 1;
    expect(request.stream).toBe(false);
    return {
      content: JSON.stringify({
        evaluatorId: "judge-test",
        metricName: "reference-equivalence",
        score: 1,
        passed: true,
        rubricVersion: "v1",
        artifactRef: { kind: "inline" },
      }),
    };
  };
}

async function readFacts(store: FsStore): Promise<Fact[]> {
  const keys = await store.list(factsPrefix(projectId));
  return Promise.all(
    keys.map(async (key) => {
      const entry = await store.get(key);
      if (entry === null) throw new Error(`Missing listed fact: ${key}`);
      return factSchema.parse(
        JSON.parse(Buffer.from(entry.body).toString("utf8")),
      );
    }),
  );
}

describe("provider client", () => {
  let stub: StubProvider;

  beforeEach(async () => {
    process.env.REPLAY_TEST_API_KEY = fakeKey;
    stub = await startStub();
  });

  afterEach(async () => {
    delete process.env.REPLAY_TEST_API_KEY;
    await stub.close();
  });

  it("normalizes the OpenAI-compatible catalog and estimates missing cost", async () => {
    const provider = createProvider({
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });

    const catalog = await provider.listModels();

    expect(catalog[0]).toEqual({
      id: "acme/small-1",
      family: "acme",
      contextLength: 0,
      pricing: { input: 0.0000002, output: 0.0000008 },
      supportsTools: true,
      supportsStructuredOutput: false,
    });

    const response = await provider.chat({
      model: "acme/small-1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.4,
      maxOutputTokens: 20,
    });

    expect(response.content).toMatch(/^Deterministic reply /);
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBe(12);
    expect(response.costUsd).toBeCloseTo(
      response.usage.inputTokens * 0.0000002 + 12 * 0.0000008,
    );
    expect(response.costIsEstimate).toBe(true);
  });

  it("reads the API key at call time", async () => {
    const provider = createProvider({
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });
    delete process.env.REPLAY_TEST_API_KEY;

    await expect(provider.listModels()).rejects.toThrow("REPLAY_TEST_API_KEY");
  });
});

describe("budget reservation", () => {
  let directory: string;
  let store: FsStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rightmodeler-replay-budget-"));
    store = new FsStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses concurrent reservations past the cap and states the required cap", async () => {
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.01,
    });
    const first = await budget.reserveExecution({
      contextTokens: 2,
      maxOutputTokens: 2,
      pricing: { input: 0.001, output: 0.002 },
    });

    let refusal: BudgetRefusalError | undefined;
    try {
      await budget.reserveExecution({
        contextTokens: 3,
        maxOutputTokens: 1,
        pricing: { input: 0.001, output: 0.002 },
      });
    } catch (error) {
      if (error instanceof BudgetRefusalError) refusal = error;
      else throw error;
    }

    expect(refusal?.requiredCapUsd).toBeCloseTo(0.011);
    expect(refusal?.message).toContain("$0.011");
    expect((await budget.state()).reservedUsd).toBeCloseTo(0.006);

    await first.refund(0.001);
    expect(await budget.state()).toMatchObject({
      spentUsd: 0.001,
      reservedUsd: 0,
    });
  });

  it("treats an omitted cap as unlimited", async () => {
    const budget = createBudget({ store, projectId, runId });
    const reservation = await budget.reserveExecution({
      contextTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      pricing: { input: 1, output: 1 },
    });

    expect((await budget.state()).reservedUsd).toBe(2_000_000);
    await reservation.refund(3);
    expect(await budget.state()).toMatchObject({
      spentUsd: 3,
      reservedUsd: 0,
    });
  });
});

describe("shortlist", () => {
  const catalog: ModelCatalogEntry[] = [
    {
      id: "vendor/current",
      family: "vendor",
      contextLength: 1_000,
      pricing: { input: 4, output: 8 },
      supportsTools: true,
      supportsStructuredOutput: true,
    },
    {
      id: "vendor/qualified",
      family: "vendor",
      contextLength: 1_000,
      pricing: { input: 1, output: 2 },
      supportsTools: true,
      supportsStructuredOutput: true,
    },
    {
      id: "vendor/no-tools",
      family: "vendor",
      contextLength: 1_000,
      pricing: { input: 0.5, output: 1 },
      supportsTools: false,
      supportsStructuredOutput: true,
    },
    {
      id: "vendor/no-structure",
      family: "vendor",
      contextLength: 1_000,
      pricing: { input: 0.25, output: 0.5 },
      supportsTools: true,
      supportsStructuredOutput: false,
    },
    {
      id: "vendor/short-context",
      family: "vendor",
      contextLength: 10,
      pricing: { input: 0.1, output: 0.2 },
      supportsTools: true,
      supportsStructuredOutput: true,
    },
    {
      id: "vendor/not-cheaper",
      family: "vendor",
      contextLength: 1_000,
      pricing: { input: 4, output: 8 },
      supportsTools: true,
      supportsStructuredOutput: true,
    },
  ];

  it("filters capabilities, context, allow/deny, and price", () => {
    const result = shortlist(
      [
        step({
          currentModel: "vendor/current",
          needsTools: true,
          needsStructuredOutput: true,
          observedContextTokens: 100,
        }),
      ],
      catalog,
      {
        allow: ["vendor/qualified", "vendor/no-tools"],
        deny: ["vendor/no-tools"],
      },
    );

    expect(result[0]?.candidates.map((candidate) => candidate.id)).toEqual([
      "vendor/qualified",
    ]);
  });

  it("returns an abstention when the current model is absent", () => {
    const result = shortlist(
      [step({ currentModel: "vendor/missing" })],
      catalog,
      {},
    );

    expect(result[0]).toMatchObject({
      candidates: [],
      abstention: { kind: "current-model-absent" },
    });
  });

  it("ranks the cheapest candidates first and defaults to eight", () => {
    const rankedCatalog = [
      { ...catalog[0]!, pricing: { input: 100, output: 100 } },
      ...Array.from({ length: 10 }, (_, index): ModelCatalogEntry => ({
        id: `vendor/candidate-${index}`,
        family: "vendor",
        contextLength: 1_000,
        pricing: { input: index + 1, output: index + 1 },
        supportsTools: true,
        supportsStructuredOutput: true,
      })),
    ];

    const result = shortlist(
      [
        step({
          currentModel: "vendor/current",
          observedContextTokens: 100,
        }),
      ],
      rankedCatalog,
    );

    expect(result[0]?.candidates).toHaveLength(8);
    expect(result[0]?.candidates.map((candidate) => candidate.id)).toEqual([
      "vendor/candidate-0",
      "vendor/candidate-1",
      "vendor/candidate-2",
      "vendor/candidate-3",
      "vendor/candidate-4",
      "vendor/candidate-5",
      "vendor/candidate-6",
      "vendor/candidate-7",
    ]);
  });
});

describe("Mode A replay", () => {
  let stub: StubProvider;
  let directory: string;
  let store: FsStore;
  let provider: ProviderClient;

  beforeEach(async () => {
    process.env.REPLAY_TEST_API_KEY = fakeKey;
    stub = await startStub();
    directory = await mkdtemp(join(tmpdir(), "rightmodeler-replay-driver-"));
    store = new FsStore(directory);
    provider = createProvider({
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      maxConcurrency: 4,
    });
  });

  afterEach(async () => {
    delete process.env.REPLAY_TEST_API_KEY;
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function run(cases: RecordedCase[], judgeChat = judge()) {
    const catalog = await provider.listModels();
    const candidate = catalog.find((model) => model.id === "acme/small-1");
    if (candidate === undefined) throw new Error("Missing stub candidate");
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 1,
    });
    return replayModeA({
      steps: [step()],
      cases,
      candidates: [{ stepId: "step-1", candidates: [candidate] }],
      provider,
      judgeChat,
      store,
      budget,
      concurrency: 2,
    });
  }

  it("records two attempts but one terminal execution after a one-time 429", async () => {
    const result = await run([
      recordedCase({ headers: { "x-stub-429-once": "retry-case" } }),
    ]);
    const facts = await readFacts(store);
    const attempts = facts.filter((fact) => "attemptId" in fact);
    const executions = facts.filter(
      (fact) => "executionId" in fact && "caseId" in fact,
    );

    expect(result.blocked).toEqual([]);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.logicalCallId)).size).toBe(
      1,
    );
    expect(attempts.map((attempt) => attempt.streamOutcome).sort()).toEqual([
      "completed",
      "provider_error",
    ]);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      terminalOutcome: "success",
      attribution: "ok",
    });
  });

  it("replays the recorded request verbatim with only the model swapped", async () => {
    const delegate = provider;
    const requests: Parameters<ProviderClient["chat"]>[0][] = [];
    provider = {
      listModels: () => delegate.listModels(),
      chat: (request) => {
        requests.push(request);
        return delegate.chat(request);
      },
    };
    const inputCase = recordedCase({
      system: "Exact system",
      messages: [
        { role: "user", content: "Exact user" },
        { role: "assistant", content: "Exact assistant" },
      ],
      temperature: 0.73,
    });

    await run([inputCase]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "acme/small-1",
      messages: [
        { role: "system", content: "Exact system" },
        { role: "user", content: "Exact user" },
        { role: "assistant", content: "Exact assistant" },
      ],
      temperature: 0.73,
      maxOutputTokens: inputCase.maxOutputTokens,
    });
  });

  it("classifies empty output as silent failure and skips judging", async () => {
    const judgeCounter = { calls: 0 };
    await run(
      [recordedCase({ headers: { "x-stub-empty": "true" } })],
      judge(judgeCounter),
    );
    const facts = await readFacts(store);
    const execution = facts.find(
      (fact) => "caseId" in fact && "terminalOutcome" in fact,
    );

    expect(execution).toMatchObject({
      terminalOutcome: "failure",
      finalOutput: "",
      attribution: "silent-failure",
    });
    expect(judgeCounter.calls).toBe(0);
    expect(facts.some((fact) => "assessmentId" in fact)).toBe(false);
  });

  it("resumes without new provider calls or facts", async () => {
    await run([recordedCase()]);
    const hitsAfterFirstRun = stub.getHitCount();
    const factsAfterFirstRun = await readFacts(store);

    const second = await run([recordedCase()]);

    expect(second.skipped).toBe(1);
    expect(stub.getHitCount()).toBe(hitsAfterFirstRun);
    expect(await readFacts(store)).toHaveLength(factsAfterFirstRun.length);
  });

  it("never persists or throws the environment key value", async () => {
    const errors: Error[] = [];
    await run([recordedCase()]);
    try {
      const failingProvider = createProvider({
        baseUrl: `${baseUrl(stub)}/missing`,
        apiKeyEnv: "REPLAY_TEST_API_KEY",
      });
      await failingProvider.chat({
        model: "acme/small-1",
        messages: [{ role: "user", content: "not found" }],
      });
    } catch (error) {
      if (error instanceof Error) errors.push(error);
    }

    const facts = await readFacts(store);
    const serialized = JSON.stringify({
      facts,
      errors: errors.map((error) => ({
        ...error,
        name: error.name,
        message: error.message,
      })),
    });
    expect(serialized).not.toContain(fakeKey);
  });
});
