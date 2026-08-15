import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeRun,
  createRun,
  factSchema,
  factsPrefix,
  FsStore,
  type Fact,
  type JsonValue,
} from "@rightmodeler/core";
import { aggregate, type JudgeChat } from "@rightmodeler/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BlockedError,
  BudgetRefusalError,
  DEFAULT_RESERVATION_STALENESS_WINDOW_MS,
  createBudget,
  createProvider,
  replayModeA,
  shortlist,
  type ModelCatalogEntry,
  type ProviderClient,
  type RecordedCase,
  type ReplayStep,
} from "./index.js";
import { toWireMessages } from "./driver.js";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
  getRequests(): Array<Record<string, unknown>>;
}

interface StubProviderModule {
  startStubProvider(options: {
    port: number;
    malformedJudgeModels?: string[];
  }): Promise<StubProvider>;
}

const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const aiGatewayFixtureUrl = new URL(
  "../../../fixtures/catalogs/ai-gateway-models.json",
  import.meta.url,
);
const aiGatewayChatFixtureUrl = new URL(
  "../../../fixtures/catalogs/ai-gateway-chat-response.json",
  import.meta.url,
);

const projectId = "replay-test";
const runId = "run-1";
const fakeKey = "fake-provider-key-never-persist";

async function startStub(
  options: { malformedJudgeModels?: string[] } = {},
): Promise<StubProvider> {
  const fixture = (await import(stubModuleUrl)) as StubProviderModule;
  return fixture.startStubProvider({ port: 0, ...options });
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
    corpusSplit: "shortlist",
    ...overrides,
  };
}

function recordedCase(overrides: Partial<RecordedCase> = {}): RecordedCase {
  return {
    caseId: "case-1",
    stepId: "step-1",
    trajectoryId: "trajectory-1",
    corpusSplit: "shortlist",
    task: "Summarize the recorded case.",
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
    expect(request.temperature).toBe(0);
    return JSON.stringify({
      verdict: "equivalent",
      score: 1,
      justification: "Equivalent fixture outputs.",
    });
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
      providerId: "stub-provider",
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });

    const catalog = await provider.listModels();

    expect(catalog[0]).toEqual({
      id: "acme/small-1",
      family: "acme",
      contextLength: 0,
      pricing: { input: 0.0000002, output: 0.0000008 },
      supportsTools: false,
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
      providerId: "stub-provider",
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });
    delete process.env.REPLAY_TEST_API_KEY;

    await expect(provider.listModels()).rejects.toThrow("REPLAY_TEST_API_KEY");
  });

  it("rejects internal parts arrays at the strict stub boundary", async () => {
    const response = await fetch(`${baseUrl(stub)}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "acme/small-1",
        messages: [
          {
            role: "user",
            parts: [{ type: "text", content: "not wire-shaped" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("messages[0].parts");
  });
});

describe("AI Gateway catalog", () => {
  beforeEach(() => {
    process.env.REPLAY_TEST_API_KEY = fakeKey;
  });

  afterEach(() => {
    delete process.env.REPLAY_TEST_API_KEY;
    vi.restoreAllMocks();
  });

  async function listFixtureModels(
    fixtureBody?: string,
  ): Promise<ModelCatalogEntry[]> {
    const body = fixtureBody ?? (await readFile(aiGatewayFixtureUrl, "utf8"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    return createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://catalog.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    }).listModels();
  }

  it("normalizes string pricing, context, and capabilities while excluding embeddings", async () => {
    const catalog = await listFixtureModels();

    expect(catalog).toHaveLength(7);
    expect(catalog.find(({ id }) => id === "openai/gpt-4o")).toEqual({
      id: "openai/gpt-4o",
      family: "openai",
      contextLength: 128_000,
      pricing: { input: 0.0000025, output: 0.00001 },
      supportsTools: true,
      supportsStructuredOutput: false,
    });
    expect(catalog.find(({ id }) => id === "sakana/namazu")).toMatchObject({
      supportsTools: true,
      supportsStructuredOutput: true,
    });
    expect(
      catalog.find(({ id }) => id === "google/gemini-2.5-flash-image"),
    ).toMatchObject({ supportsTools: false, supportsStructuredOutput: false });
    expect(
      catalog.some(({ id }) => id === "alibaba/qwen3-embedding-0.6b"),
    ).toBe(false);
  });

  it("marks non-numeric string pricing as unavailable", async () => {
    const fixtureBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const catalog = await listFixtureModels(
      fixtureBody.replace('"input": "0.00000015"', '"input": "unknown"'),
    );

    expect(
      catalog.find(({ id }) => id === "openai/gpt-4o-mini")?.pricing,
    ).toBeNull();
  });

  it("recognizes response_format as structured-output support", async () => {
    const fixtureBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const catalog = await listFixtureModels(
      fixtureBody.replace(',\n        "structured_outputs"', ""),
    );

    expect(
      catalog.find(({ id }) => id === "sakana/namazu")
        ?.supportsStructuredOutput,
    ).toBe(true);
  });

  it("blocks a malformed catalog response with provider diagnostics", async () => {
    const malformedBody = `{"credential":"${fakeKey}`;

    await expect(listFixtureModels(malformedBody)).rejects.toMatchObject({
      name: "BlockedError",
      kind: "provider",
      providerId: "vercel-ai-gateway",
      errorDetail: {
        status: 200,
        bodyExcerpt: '{"credential":"[redacted]',
      },
    });
  });

  it("shortlists cheaper tool-capable chat models for a GPT-4o incumbent", async () => {
    const catalog = await listFixtureModels();
    const result = shortlist(
      [
        step({
          currentModel: "openai/gpt-4o",
          needsTools: true,
          observedContextTokens: 30_000,
        }),
      ],
      catalog,
    );

    expect(result[0]?.candidates.map(({ id }) => id)).toEqual([
      "openai/gpt-4o-mini",
      "alibaba/qwen-3-235b",
      "meta/llama-3.3-70b",
      "sakana/namazu",
    ]);
  });
});

describe("AI Gateway chat", () => {
  beforeEach(() => {
    process.env.REPLAY_TEST_API_KEY = fakeKey;
  });

  afterEach(() => {
    delete process.env.REPLAY_TEST_API_KEY;
    vi.restoreAllMocks();
  });

  async function chatFromFixture(
    chatBody: string,
    maxOutputTokens = 32,
  ): Promise<Awaited<ReturnType<ProviderClient["chat"]>>> {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(chatBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    return createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://chat.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    }).chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say okay." }],
      maxOutputTokens,
      estimatedInputTokens: 10,
    });
  }

  it("parses the sanitized response usage and BYOK market cost", async () => {
    const fixtureBody = await readFile(aiGatewayChatFixtureUrl, "utf8");

    await expect(chatFromFixture(fixtureBody)).resolves.toEqual({
      content: "Ok!",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.0000033,
      costIsEstimate: false,
    });
  });

  it("uses upstream inference cost when BYOK market cost is absent", async () => {
    const fixture = JSON.parse(
      await readFile(aiGatewayChatFixtureUrl, "utf8"),
    ) as {
      usage: Record<string, unknown>;
    };
    delete fixture.usage.market_cost;

    const response = await chatFromFixture(JSON.stringify(fixture));

    expect(response).toMatchObject({
      costUsd: 0.0000033,
      costIsEstimate: false,
    });
  });

  it("prefers BYOK market cost over upstream inference cost", async () => {
    const fixture = JSON.parse(
      await readFile(aiGatewayChatFixtureUrl, "utf8"),
    ) as {
      usage: {
        cost_details: Record<string, unknown>;
      };
    };
    fixture.usage.cost_details.upstream_inference_cost = 0.0000099;

    const response = await chatFromFixture(JSON.stringify(fixture));

    expect(response).toMatchObject({
      costUsd: 0.0000033,
      costIsEstimate: false,
    });
  });

  it("estimates usage and cost when non-empty content has zero usage", async () => {
    const fixture = JSON.parse(
      await readFile(aiGatewayChatFixtureUrl, "utf8"),
    ) as {
      usage: Record<string, unknown>;
    };
    fixture.usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    const response = await chatFromFixture(JSON.stringify(fixture));

    expect(response).toMatchObject({
      content: "Ok!",
      usage: {
        inputTokens: 10,
        outputTokens: 1,
        status: "usage_unreported",
      },
      costIsEstimate: true,
    });
    expect(response.costUsd).toBeCloseTo(0.0000021);
  });

  it("clamps max_tokens to the gateway minimum", async () => {
    const fixtureBody = await readFile(aiGatewayChatFixtureUrl, "utf8");

    await chatFromFixture(fixtureBody, 1);

    const request = vi.mocked(globalThis.fetch).mock.calls[1]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ max_tokens: 16 });
  });

  it("returns typed diagnostics for malformed non-streaming JSON", async () => {
    const malformedBody = `{"credential":"${fakeKey}`;

    await expect(chatFromFixture(malformedBody)).rejects.toMatchObject({
      name: "ProviderResponseError",
      status: 200,
      bodyExcerpt: '{"credential":"[redacted]',
      redacted: true,
    });
  });

  it.each([429, 500])(
    "retries a malformed HTTP %s body by status",
    async (status) => {
      const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
      const chatBody = await readFile(aiGatewayChatFixtureUrl, "utf8");
      const onAttempt = vi.fn();
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(catalogBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response("", {
            status,
            headers: { "retry-after": "0" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(chatBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      const response = await createProvider({
        providerId: "vercel-ai-gateway",
        baseUrl: "https://chat.example/v1",
        apiKeyEnv: "REPLAY_TEST_API_KEY",
      }).chat({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say okay." }],
        onAttempt,
      });

      expect(response.content).toBe("Ok!");
      expect(onAttempt).toHaveBeenCalledTimes(2);
      expect(onAttempt).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          outcome: "provider_error",
          errorDetail: { status, bodyExcerpt: "" },
        }),
      );
      expect(onAttempt).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ outcome: "completed" }),
      );
    },
  );
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

    expect(refusal?.requiredCapUsd).toBeCloseTo(0.005);
    expect(refusal?.causedByReservations).toBe(true);
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

  it("reclaims a reservation after its host dies mid-case", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    try {
      const killedHostBudget = createBudget({
        store,
        projectId,
        runId,
        authorizedTotalUsd: 0.01,
      });
      await killedHostBudget.reserveExecution({
        contextTokens: 1,
        maxOutputTokens: 0,
        pricing: { input: 0.01, output: 0 },
      });

      vi.advanceTimersByTime(DEFAULT_RESERVATION_STALENESS_WINDOW_MS + 1);
      const resumedBudget = createBudget({
        store,
        projectId,
        runId,
        authorizedTotalUsd: 0.01,
      });
      const resumed = await resumedBudget.reserveExecution({
        contextTokens: 1,
        maxOutputTokens: 0,
        pricing: { input: 0.01, output: 0 },
      });

      expect(await resumedBudget.state()).toMatchObject({
        spentUsd: 0,
        reservedUsd: 0.01,
      });
      await resumed.refund(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims a reservation when its owning run is terminal", async () => {
    await createRun(store, {
      projectId,
      runId,
      type: "replay",
      phase: "confirm",
    });
    const active = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.01,
    });
    await active.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 0,
      pricing: { input: 0.01, output: 0 },
    });
    await completeRun(store, projectId, runId);

    expect(await active.state()).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0,
    });
  });

  it("adopts a raised cap when a stored ledger resumes", async () => {
    const initial = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.005,
    });
    const first = await initial.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 1,
      pricing: { input: 0.002, output: 0.003 },
    });
    await first.refund(0.001);

    const raised = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.02,
    });
    const second = await raised.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 1,
      pricing: { input: 0.004, output: 0.006 },
    });

    expect(await raised.state()).toMatchObject({
      authorizedTotalUsd: 0.02,
      reservedUsd: 0.01,
    });
    await second.refund(0.002);
  });

  it("refuses only when spent plus the next worst case exceeds the cap", async () => {
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.01,
    });
    const first = await budget.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 1,
      pricing: { input: 0.003, output: 0.003 },
    });
    await first.refund(0.006);

    await expect(
      budget.reserveExecution({
        contextTokens: 1,
        maxOutputTokens: 1,
        pricing: { input: 0.002, output: 0.003 },
      }),
    ).rejects.toMatchObject({
      requiredCapUsd: 0.011,
      causedByReservations: false,
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
    expect(result[0]?.droppedByTop).toBe(2);
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

  it("excludes explicitly free models by default and reports the exclusion", () => {
    const result = shortlist(
      [step({ currentModel: "vendor/current" })],
      [
        ...catalog,
        {
          ...catalog[1]!,
          id: "vendor/free",
          pricing: { input: 0, output: 0 },
        },
        { ...catalog[1]!, id: "vendor/unpriced", pricing: null },
      ],
    );

    expect(
      result[0]?.candidates.map((candidate) => candidate.id),
    ).not.toContain("vendor/free");
    expect(result[0]?.droppedFreeModels).toBe(1);
    expect(
      result[0]?.candidates.map((candidate) => candidate.id),
    ).not.toContain("vendor/unpriced");
  });

  it("includes explicitly free models only when opted in", () => {
    const result = shortlist(
      [step({ currentModel: "vendor/current" })],
      [
        ...catalog,
        {
          ...catalog[1]!,
          id: "vendor/free",
          pricing: { input: 0, output: 0 },
        },
      ],
      { includeFreeModels: true },
    );

    expect(result[0]?.candidates.map((candidate) => candidate.id)).toContain(
      "vendor/free",
    );
    expect(result[0]?.droppedFreeModels).toBe(0);
  });
});

describe("toWireMessages", () => {
  it("prepends the recorded system prompt and converts internal text parts", () => {
    expect(
      toWireMessages(
        [
          {
            role: "user",
            parts: [{ type: "text", content: "Summarize this case." }],
          },
        ],
        "Follow the recorded instruction.",
      ),
    ).toEqual([
      { role: "system", content: "Follow the recorded instruction." },
      { role: "user", content: "Summarize this case." },
    ]);
  });

  it("joins multiple text parts with newlines", () => {
    expect(
      toWireMessages([
        {
          role: "assistant",
          parts: [
            { type: "text", content: "First" },
            { type: "text", content: "Second" },
          ],
        },
      ]),
    ).toEqual([{ role: "assistant", content: "First\nSecond" }]);
  });

  it("preserves an already-wire tool message", () => {
    expect(
      toWireMessages([
        { role: "tool", tool_call_id: "call-1", content: "delivered" },
      ]),
    ).toEqual([{ role: "tool", tool_call_id: "call-1", content: "delivered" }]);
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
      providerId: "stub-provider",
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

  async function run(
    cases: RecordedCase[],
    judgeChat = judge(),
    concurrency = 2,
    judgeModel = "neutral/judge",
    rankedModels = [{ judgeModel, supportsStructuredOutput: true }],
    warning?: (code: string, message: string) => void,
  ) {
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
      candidates: [
        {
          stepId: "step-1",
          candidates: [candidate],
          droppedByTop: 0,
          droppedFreeModels: 0,
        },
      ],
      provider,
      judge: {
        chat: judgeChat,
        rankedModels,
        ...(warning === undefined ? {} : { warning }),
      },
      store,
      budget,
      concurrency,
    });
  }

  const providerJudge: JudgeChat = async (request) =>
    (
      await provider.chat({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature,
        maxOutputTokens: 256,
        responseFormat: request.responseFormat as JsonValue,
      })
    ).content;

  it("records two attempts but one terminal execution after a one-time 429", async () => {
    const result = await run([
      recordedCase({ headers: { "x-stub-429-once": "retry-case" } }),
    ]);
    const facts = await readFacts(store);
    const attempts = facts.filter((fact) => "attemptId" in fact);
    const executions = facts.filter(
      (fact) => "executionId" in fact && "caseId" in fact,
    );
    const spend = facts.filter((fact) => "actor" in fact);

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
    expect(
      spend.filter((event) => event.actor === "replay-driver"),
    ).toHaveLength(2);
    expect(spend.filter((event) => event.actor === "judge")).toHaveLength(2);
    expect(
      spend
        .filter((event) => event.actor === "replay-driver")
        .reduce((total, event) => total + event.costUsd, 0),
    ).toBeGreaterThan(0);
  });

  it("uses kernel judge provenance and records position-swap evidence", async () => {
    const requests: Parameters<JudgeChat>[0][] = [];
    await run([recordedCase()], async (request) => {
      requests.push(request);
      return JSON.stringify({
        verdict: "equivalent",
        score: 1,
        justification: "Equivalent fixture outputs.",
      });
    });
    const facts = await readFacts(store);
    const assessment = facts.find((fact) => "assessmentId" in fact);

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.model === "neutral/judge")).toBe(
      true,
    );
    expect(assessment).toMatchObject({
      evaluatorId: "neutral/judge",
      metricName: "replacement-quality",
      rubricVersion: "position-swap-v1",
      passed: true,
      artifactRef: {
        verdict: "equivalent",
        judgeModel: "neutral/judge",
        orderConsistent: true,
      },
    });
  });

  it("passes the exact judge response format through to the provider", async () => {
    await run([recordedCase()], providerJudge, 1, "zeta/judge-1", [
      {
        judgeModel: "zeta/judge-1",
        supportsStructuredOutput: true,
      },
    ]);

    const judgeRequests = stub
      .getRequests()
      .filter(({ model }) => model === "zeta/judge-1");
    expect(judgeRequests).toHaveLength(2);
    expect(judgeRequests[0]?.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "verdict",
        strict: true,
        schema: {
          type: "object",
          properties: {
            verdict: {
              type: "string",
              enum: ["equivalent", "minor_drift", "divergent"],
            },
            score: { type: "number", minimum: 0, maximum: 1 },
            justification: { type: "string" },
          },
          required: ["verdict", "score", "justification"],
          additionalProperties: false,
        },
      },
    });
  });

  it("switches after three malformed assessments and rejudges only affected cells", async () => {
    await stub.close();
    stub = await startStub({
      malformedJudgeModels: ["zeta/judge-1"],
    });
    provider = createProvider({
      providerId: "stub-provider",
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      maxConcurrency: 4,
    });
    const warning = vi.fn();
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index}`,
        trajectoryId: `trajectory-${index}`,
      }),
    );

    const result = await run(
      cases,
      providerJudge,
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
        },
      ],
      warning,
    );
    const facts = await readFacts(store);
    const requests = stub.getRequests();
    const notes = facts.filter(
      (fact) =>
        "actor" in fact &&
        typeof fact.reconcilableTo === "object" &&
        fact.reconcilableTo !== null &&
        !Array.isArray(fact.reconcilableTo) &&
        fact.reconcilableTo.judgeStatus === "unusable",
    );

    expect(result).toMatchObject({ completed: 4, blocked: [] });
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(4);
    expect(
      facts
        .filter((fact) => "assessmentId" in fact)
        .every((fact) => fact.evaluatorId === "yotta/judge-2"),
    ).toBe(true);
    expect(
      requests.filter(({ model }) => model === "acme/small-1"),
    ).toHaveLength(4);
    expect(
      requests.filter(({ model }) => model === "zeta/judge-1"),
    ).toHaveLength(3);
    expect(
      requests.filter(({ model }) => model === "yotta/judge-2"),
    ).toHaveLength(8);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[1]).toContain("zeta/judge-1");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      reconcilableTo: {
        judgeModel: "zeta/judge-1",
        judgeStatus: "unusable",
        note: "three_consecutive_terminal_failures",
        consecutiveAssessments: 3,
      },
    });
  });

  it("counts mixed malformed and provider judge failures toward failover", async () => {
    const warning = vi.fn();
    const judgeModels: string[] = [];
    const failures = ["malformed", "provider_error", "malformed"] as const;
    let failureIndex = 0;
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index}`,
        trajectoryId: `trajectory-${index}`,
      }),
    );

    const result = await run(
      cases,
      async (request) => {
        judgeModels.push(request.model);
        if (request.model === "zeta/judge-1") {
          const failure = failures[failureIndex];
          failureIndex += 1;
          if (failure === "provider_error") {
            throw new Error("Terminal provider failure");
          }
          return '{"verdict":';
        }
        return JSON.stringify({
          verdict: "equivalent",
          score: 1,
          justification: "Equivalent fixture outputs.",
        });
      },
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
        },
      ],
      warning,
    );
    const facts = await readFacts(store);

    expect(result).toMatchObject({ completed: 4, blocked: [] });
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(4);
    expect(
      facts
        .filter((fact) => "assessmentId" in fact)
        .every((fact) => fact.evaluatorId === "yotta/judge-2"),
    ).toBe(true);
    expect(
      judgeModels.filter((model) => model === "zeta/judge-1"),
    ).toHaveLength(3);
    expect(
      judgeModels.filter((model) => model === "yotta/judge-2"),
    ).toHaveLength(8);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("tries at most two systematically malformed judges", async () => {
    await stub.close();
    stub = await startStub({
      malformedJudgeModels: ["zeta/judge-1", "yotta/judge-2"],
    });
    provider = createProvider({
      providerId: "stub-provider",
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      maxConcurrency: 4,
    });
    const warning = vi.fn();
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index}`,
        trajectoryId: `trajectory-${index}`,
      }),
    );

    const result = await run(
      cases,
      providerJudge,
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
        },
        {
          judgeModel: "unused/judge-3",
          supportsStructuredOutput: false,
        },
      ],
      warning,
    );
    const facts = await readFacts(store);
    const requests = stub.getRequests();

    expect(result).toMatchObject({ completed: 4, blocked: [] });
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(0);
    expect(
      facts.filter((fact) => "executionId" in fact && "caseId" in fact),
    ).toHaveLength(4);
    expect(
      requests.filter(({ model }) => model === "acme/small-1"),
    ).toHaveLength(4);
    expect(
      requests.filter(({ model }) => model === "zeta/judge-1"),
    ).toHaveLength(3);
    expect(
      requests.filter(({ model }) => model === "yotta/judge-2"),
    ).toHaveLength(3);
    expect(requests.some(({ model }) => model === "unused/judge-3")).toBe(
      false,
    );
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("bounds judge failure forensics to 300 characters", async () => {
    const message = "x".repeat(400);

    await run(
      [recordedCase()],
      async () => {
        throw new Error(message);
      },
      1,
    );

    const facts = await readFacts(store);
    const forensic = facts.find(
      (fact) =>
        "actor" in fact &&
        typeof fact.reconcilableTo === "object" &&
        fact.reconcilableTo !== null &&
        !Array.isArray(fact.reconcilableTo) &&
        fact.reconcilableTo.judgeFailureKind === "provider_error",
    );
    expect(forensic).toMatchObject({
      reconcilableTo: {
        errorDetail: {
          message: message.slice(0, 300),
          judgeModel: "neutral/judge",
        },
      },
    });
  });

  it("records a provider 400 as lost rather than a scored failure", async () => {
    const result = await run([
      recordedCase({ headers: { "x-stub-echo-auth": "true" } }),
    ]);
    const facts = await readFacts(store);
    const execution = facts.find(
      (fact) => "caseId" in fact && "terminalOutcome" in fact,
    );

    expect(result.completed).toBe(1);
    expect(execution).toMatchObject({
      terminalOutcome: "failure",
      finalOutput: null,
      attribution: "lost",
    });
    expect(facts.some((fact) => "assessmentId" in fact)).toBe(false);
  });

  it.each([
    ["empty", "x-stub-empty-body", ""],
    ["truncated", "x-stub-truncated-json", '{"id":"stub-'],
  ])(
    "records one %s non-streaming response error and continues sibling cells",
    async (_fault, header, expectedExcerpt) => {
      const result = await run([
        recordedCase({
          caseId: "malformed-case",
          headers: { [header]: "true" },
        }),
        recordedCase({ caseId: "healthy-case" }),
      ]);
      const facts = await readFacts(store);
      const attempts = facts.filter((fact) => "attemptId" in fact);
      const executions = facts.filter(
        (fact) => "caseId" in fact && "terminalOutcome" in fact,
      );
      const malformedAttempt = attempts.find(
        (attempt) => attempt.streamOutcome === "provider_error",
      );

      expect(result).toMatchObject({ completed: 2, blocked: [] });
      expect(stub.getHitCount()).toBe(2);
      expect(attempts).toHaveLength(2);
      expect(
        attempts.filter(
          (attempt) => attempt.streamOutcome === "provider_error",
        ),
      ).toHaveLength(1);
      expect(malformedAttempt).toMatchObject({
        streamOutcome: "provider_error",
        errorDetail: {
          status: 200,
        },
      });
      if (
        malformedAttempt === undefined ||
        !("attemptId" in malformedAttempt)
      ) {
        throw new Error("Expected a malformed provider attempt");
      }
      expect(
        malformedAttempt.errorDetail?.bodyExcerpt.length,
      ).toBeLessThanOrEqual(500);
      if (expectedExcerpt.length === 0) {
        expect(malformedAttempt.errorDetail?.bodyExcerpt).toBe("");
      } else {
        expect(malformedAttempt.errorDetail?.bodyExcerpt).toContain(
          expectedExcerpt,
        );
      }
      expect(executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: "malformed-case",
            terminalOutcome: "failure",
            finalOutput: null,
            attribution: "lost",
          }),
          expect.objectContaining({
            caseId: "healthy-case",
            terminalOutcome: "success",
            attribution: "ok",
          }),
        ]),
      );
      expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(1);
    },
  );

  it.each([
    ["empty", "STUB_JUDGE_EMPTY_OUTPUT", "response_malformed"],
    ["truncated JSON", "STUB_JUDGE_TRUNCATED_JSON", "response_malformed"],
    ["non-JSON prose", "STUB_JUDGE_NON_JSON", "response_malformed"],
    ["provider 500", "STUB_JUDGE_PROVIDER_ERROR", "provider_error"],
  ] as const)(
    "mutation: removing the judge boundary rethrows; %s is excluded and the next cell runs",
    async (_fault, marker, judgeFailureKind) => {
      const result = await run(
        [
          recordedCase({ caseId: "judge-failed", task: marker }),
          recordedCase({ caseId: "healthy-case", task: "HEALTHY_JUDGE" }),
        ],
        providerJudge,
        1,
        "zeta/judge-1",
      );
      const facts = await readFacts(store);
      const executions = facts.filter(
        (fact) => "caseId" in fact && "terminalOutcome" in fact,
      );
      const assessments = facts.filter((fact) => "assessmentId" in fact);
      const failedExecution = executions.find(
        (execution) => execution.caseId === "judge-failed",
      );
      const healthyExecution = executions.find(
        (execution) => execution.caseId === "healthy-case",
      );
      const forensic = facts.find(
        (fact) =>
          "actor" in fact &&
          typeof fact.reconcilableTo === "object" &&
          fact.reconcilableTo !== null &&
          !Array.isArray(fact.reconcilableTo) &&
          fact.reconcilableTo.judgeFailureKind === judgeFailureKind,
      );

      expect(result).toMatchObject({ completed: 2, blocked: [] });
      expect(executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            caseId: "judge-failed",
            terminalOutcome: "success",
            attribution: "ok",
          }),
          expect.objectContaining({
            caseId: "healthy-case",
            terminalOutcome: "success",
            attribution: "ok",
          }),
        ]),
      );
      expect(assessments).toHaveLength(1);
      expect(assessments[0]).toMatchObject({
        executionId: healthyExecution?.executionId,
      });
      expect(forensic).toMatchObject({
        actor: "judge",
        reconcilableTo: {
          executionId: failedExecution?.executionId,
          judgeModel: "zeta/judge-1",
          judgeFailureKind,
          errorDetail: {
            judgeModel: "zeta/judge-1",
          },
        },
      });
      if (
        forensic === undefined ||
        !("actor" in forensic) ||
        typeof forensic.reconcilableTo !== "object" ||
        forensic.reconcilableTo === null ||
        Array.isArray(forensic.reconcilableTo) ||
        typeof forensic.reconcilableTo.errorDetail !== "object" ||
        forensic.reconcilableTo.errorDetail === null ||
        Array.isArray(forensic.reconcilableTo.errorDetail)
      ) {
        throw new Error("Expected judge failure forensics");
      }
      expect(forensic.reconcilableTo.errorDetail.message).toEqual(
        expect.any(String),
      );
      expect(
        String(forensic.reconcilableTo.errorDetail.message).length,
      ).toBeLessThanOrEqual(300);

      const expectedAssignments = executions.map((execution) => ({
        caseId: execution.caseId,
        stratumId: "family-1",
        evaluatorKind: "judge",
      }));
      const [verdict] = aggregate(
        executions.map((execution) => {
          const assessment = assessments.find(
            (assessment) => assessment.executionId === execution.executionId,
          );
          return {
            execution,
            assessment,
            gatePolicyVersion: "test-policy",
            familyId: "family-1",
            candidateFamily: "acme",
            evaluatorKind: "judge",
            candidateCostUsd: 0.1,
            referenceCeilingMultiplier: 1,
            unsafeSubstitution: false,
            evidenceCovered: true,
            expectedEvaluatorAssignments: expectedAssignments,
            stratumId: "family-1",
            requiredAbstention: false,
            requiresDeterministicEvidence: false,
            hasDeterministicEvidence: false,
            ...(assessment === undefined
              ? {}
              : { judgeModel: "zeta/judge-1", orderConsistent: true }),
          };
        }),
        {
          gatePolicyVersion: "test-policy",
          qualityFloor: 0.75,
          availabilityFloor: 0.95,
        },
      );
      expect(verdict).toMatchObject({
        excludedExecutions: 1,
        assessmentAbsentReasons: [
          { reason: "judge_evidence_incomplete", count: 1 },
        ],
      });
    },
  );

  it("replays only cases assigned to the step corpus split", async () => {
    const result = await run([
      recordedCase({ caseId: "shortlist-case", corpusSplit: "shortlist" }),
      recordedCase({ caseId: "holdout-case", corpusSplit: "holdout" }),
    ]);
    const facts = await readFacts(store);
    const executions = facts.filter(
      (fact) => "caseId" in fact && "terminalOutcome" in fact,
    );

    expect(result.completed).toBe(1);
    expect(executions.map((execution) => execution.caseId)).toEqual([
      "shortlist-case",
    ]);
  });

  it("carries the observed rate-limit ceiling onto a blocked cell", async () => {
    const delegate = provider;
    provider = {
      providerId: delegate.providerId,
      listModels: () => delegate.listModels(),
      chat: async () => {
        throw new BlockedError(429, 2);
      },
    };

    const result = await run([recordedCase()]);

    expect(result.blocked).toEqual([
      expect.objectContaining({
        kind: "rate-limit",
        observedCeiling: 2,
      }),
    ]);
  });

  it("waits for a refund before retrying reservation-limited concurrency", async () => {
    const candidate: ModelCatalogEntry = {
      id: "vendor/candidate",
      family: "vendor",
      contextLength: 100,
      pricing: { input: 0.006, output: 0.004 },
      supportsTools: false,
      supportsStructuredOutput: false,
    };
    const delayedProvider: ProviderClient = {
      providerId: "delayed-provider",
      listModels: async () => [candidate],
      chat: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const response = {
          content: "candidate output",
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0.001,
          costIsEstimate: true,
        };
        await request.onAttempt?.({ outcome: "completed", ...response });
        return response;
      },
    };
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.0111,
    });

    const result = await replayModeA({
      steps: [step()],
      cases: [
        recordedCase({
          caseId: "case-1",
          contextTokens: 1,
          maxOutputTokens: 1,
        }),
        recordedCase({
          caseId: "case-2",
          trajectoryId: "trajectory-2",
          contextTokens: 1,
          maxOutputTokens: 1,
        }),
      ],
      candidates: [
        {
          stepId: "step-1",
          candidates: [candidate],
          droppedByTop: 0,
          droppedFreeModels: 0,
        },
      ],
      provider: delayedProvider,
      judge: {
        chat: judge(),
        rankedModels: [
          {
            judgeModel: "neutral/judge",
            supportsStructuredOutput: true,
          },
        ],
      },
      store,
      budget,
      concurrency: 2,
    });

    expect(result).toMatchObject({ completed: 2, blocked: [] });
    expect(await budget.state()).toMatchObject({
      spentUsd: 0.002,
      reservedUsd: 0,
    });
  });

  it("converts the recorded request to provider wire messages with only the model swapped", async () => {
    const delegate = provider;
    const requests: Parameters<ProviderClient["chat"]>[0][] = [];
    provider = {
      providerId: delegate.providerId,
      listModels: () => delegate.listModels(),
      chat: (request) => {
        requests.push(request);
        return delegate.chat(request);
      },
    };
    const inputCase = recordedCase({
      system: "Exact system",
      messages: [
        {
          role: "user",
          parts: [{ type: "text", content: "Exact user" }],
        },
        {
          role: "assistant",
          parts: [
            { type: "text", content: "Exact" },
            { type: "text", content: "assistant" },
          ],
        },
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
        { role: "assistant", content: "Exact\nassistant" },
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

  it("classifies whitespace output with zero usage as silent failure", async () => {
    const delegate = provider;
    provider = {
      providerId: delegate.providerId,
      listModels: () => delegate.listModels(),
      chat: async (request) => {
        const response = {
          content: " \n ",
          usage: { inputTokens: 64, outputTokens: 0 },
          costUsd: 0.0000128,
          costIsEstimate: true,
        };
        await request.onAttempt?.({ outcome: "completed", ...response });
        return response;
      },
    };
    const judgeCounter = { calls: 0 };

    await run([recordedCase()], judge(judgeCounter));
    const facts = await readFacts(store);

    expect(facts).toContainEqual(
      expect.objectContaining({
        terminalOutcome: "failure",
        attribution: "silent-failure",
      }),
    );
    expect(judgeCounter.calls).toBe(0);
  });

  it("includes non-empty output when provider usage is unreported", async () => {
    const delegate = provider;
    provider = {
      providerId: delegate.providerId,
      listModels: () => delegate.listModels(),
      chat: async (request) => {
        const response = {
          content: "candidate output",
          usage: {
            inputTokens: 64,
            outputTokens: 4,
            status: "usage_unreported" as const,
          },
          costUsd: 0.000016,
          costIsEstimate: true,
        };
        await request.onAttempt?.({ outcome: "completed", ...response });
        return response;
      },
    };

    await run([recordedCase()]);
    const facts = await readFacts(store);

    expect(facts).toContainEqual(
      expect.objectContaining({
        terminalOutcome: "success",
        attribution: "ok",
      }),
    );
    expect(facts).toContainEqual(
      expect.objectContaining({
        streamOutcome: "completed",
        usage: expect.objectContaining({ status: "usage_unreported" }),
        costIsEstimate: true,
      }),
    );
    expect(facts.some((fact) => "assessmentId" in fact)).toBe(true);
  });

  it("records a successful execution without built-in judging when no judge is configured", async () => {
    const catalog = await provider.listModels();
    const candidate = catalog.find((model) => model.id === "acme/small-1");
    if (candidate === undefined) throw new Error("Missing stub candidate");
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 1,
    });

    const result = await replayModeA({
      steps: [step()],
      cases: [recordedCase()],
      candidates: [
        {
          stepId: "step-1",
          candidates: [candidate],
          droppedByTop: 0,
          droppedFreeModels: 0,
        },
      ],
      provider,
      store,
      budget,
      concurrency: 1,
    });
    const facts = await readFacts(store);

    expect(result).toMatchObject({ completed: 1, blocked: [] });
    expect(facts).toContainEqual(
      expect.objectContaining({
        caseId: "case-1",
        terminalOutcome: "success",
        attribution: "ok",
      }),
    );
    expect(facts.some((fact) => "assessmentId" in fact)).toBe(false);
    expect(
      facts.some((fact) => "actor" in fact && fact.actor === "judge"),
    ).toBe(false);
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

  it("persists a bounded provider 400 excerpt with the authorization key redacted", async () => {
    await run([recordedCase({ headers: { "x-stub-echo-auth": "true" } })]);
    const facts = await readFacts(store);
    const attempt = facts.find(
      (fact) => "attemptId" in fact && fact.streamOutcome === "provider_error",
    );
    expect(attempt).toMatchObject({
      errorDetail: {
        status: 400,
        bodyExcerpt: expect.stringContaining("[redacted]"),
      },
    });
    if (attempt === undefined || !("attemptId" in attempt)) {
      throw new Error("Expected a provider error attempt");
    }
    expect(attempt.errorDetail?.bodyExcerpt.length).toBeLessThanOrEqual(500);
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain(fakeKey);
  });
});
