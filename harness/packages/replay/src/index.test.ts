import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  budgetKey,
  completeRun,
  createRun,
  factSchema,
  factsPrefix,
  FsStore,
  runKey,
  type Fact,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import {
  aggregate,
  judgeExecution,
  pickJudges,
  type JudgeChat,
  type JudgeChatRequest,
  type JudgeChatResult,
} from "@rightmodeler/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdaptiveLimiter,
  BlockedError,
  BudgetRefusalError,
  CatalogReferenceError,
  DEFAULT_RESERVATION_STALENESS_WINDOW_MS,
  createBudget,
  createProvider,
  estimateInputTokens,
  isUsageLimit,
  ProviderRequestError,
  ProviderResponseError,
  replayModeA,
  shortlist,
  type Budget,
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

interface StubOptions {
  catalogPageSize?: number;
  malformedJudgeModels?: string[];
  servedModels?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

interface StubProviderModule {
  startStubProvider(
    options: StubOptions & { port: number },
  ): Promise<StubProvider>;
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
const envoyFixtureUrl = new URL(
  "../../../fixtures/catalogs/envoy-models.json",
  import.meta.url,
);
const aiGatewayFastTiersFixtureUrl = new URL(
  "../../../fixtures/catalogs/ai-gateway-fast-tiers.json",
  import.meta.url,
);
const bifrostModelsFixtureUrl = new URL(
  "../../../fixtures/catalogs/bifrost-models.json",
  import.meta.url,
);
const anthropicModelsFixtureUrl = new URL(
  "../../../fixtures/catalogs/anthropic-models.json",
  import.meta.url,
);
const openaiModelsFixtureUrl = new URL(
  "../../../fixtures/catalogs/openai-models.json",
  import.meta.url,
);
const bifrostChatFixtureUrl = new URL(
  "../../../fixtures/gateways/bifrost/chat.json",
  import.meta.url,
);

const projectId = "replay-test";
const runId = "run-1";
const fakeKey = "fake-provider-key-never-persist";
const unpricedJudgeLimits = {
  pricing: { input: 0, output: 0 },
  maxOutputTokens: 512,
};

async function startStub(options: StubOptions = {}): Promise<StubProvider> {
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
    return judgeReply(
      JSON.stringify({
        verdict: "equivalent",
        score: 1,
        justification: "Equivalent fixture outputs.",
      }),
    );
  };
}

function judgeReply(content: string): JudgeChatResult {
  return {
    content,
    costUsd: 0.000001,
    costIsEstimate: true,
    usage: { inputTokens: 1, outputTokens: 1 },
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

function countingStore(inner: Store, key: string): Store & { reads(): number } {
  let readCount = 0;
  return {
    async get(candidateKey) {
      if (candidateKey === key) readCount += 1;
      return inner.get(candidateKey);
    },
    list: (prefix) => inner.list(prefix),
    putImmutable: (candidateKey, body) =>
      inner.putImmutable(candidateKey, body),
    compareAndSwap: (candidateKey, expectedVersion, body, fenceToken) =>
      inner.compareAndSwap(candidateKey, expectedVersion, body, fenceToken),
    reads: () => readCount,
  };
}

describe("adaptive limiter", () => {
  it("halves once per back-off epoch and never below the floor", async () => {
    const limiter = new AdaptiveLimiter(16);
    const storm = (size: number) =>
      Promise.all(
        Array.from({ length: size }, () =>
          limiter.run(async (ticket) => {
            limiter.rateLimited(ticket);
          }),
        ),
      );

    await storm(16);
    expect(limiter.currentCap).toBe(8);
    await storm(8);
    expect(limiter.currentCap).toBe(4);
    await storm(4);
    expect(limiter.currentCap).toBe(4);
  });
});

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
      contextLength: 128_000,
      pricing: { input: 0.0000002, output: 0.0000008 },
      supportsTools: false,
      supportsStructuredOutput: false,
      releasedAt: null,
      maxOutputTokens: 16_384,
      outputModalities: [],
      requiresReasoning: false,
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

  it("walks a paginated stub catalog", async () => {
    await stub.close();
    stub = await startStub({ catalogPageSize: 4 });
    const provider = createProvider({
      providerId: "stub-provider",
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });

    const catalog = await provider.listModels();

    expect(catalog).toHaveLength(6);
    expect(catalog.at(-1)?.id).toBe("yotta/judge-2");
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

  it("sends configured headers on catalog, chat and model-info requests and keeps authorization last", async () => {
    const sent: Array<{ url: string; headers: Headers }> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        sent.push({ url, headers: new Headers(init?.headers) });
        const body = url.endsWith("/models")
          ? { data: [{ id: "acme/small-1", context_length: 128_000 }] }
          : url.endsWith("/model/info")
            ? {
                data: [
                  {
                    model_name: "acme/small-1",
                    model_info: {
                      input_cost_per_token: 0.000001,
                      output_cost_per_token: 0.000002,
                    },
                  },
                ],
              }
            : {
                model: "acme/small-1",
                choices: [
                  {
                    message: { role: "assistant", content: "ok" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 4, completion_tokens: 1 },
              };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    try {
      const provider = createProvider({
        providerId: "header-gateway",
        baseUrl: "https://gateway.example/v1",
        apiKeyEnv: "REPLAY_TEST_API_KEY",
        headers: {
          "x-portkey-provider": "openai",
          authorization: "must-not-win",
        },
      });
      await provider.listModels();
      await provider.chat({
        model: "acme/small-1",
        messages: [{ role: "user", content: "hello" }],
        headers: { "x-portkey-provider": "recorded" },
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(sent.map(({ url }) => url)).toEqual([
      "https://gateway.example/v1/models",
      "https://gateway.example/model/info",
      "https://gateway.example/v1/chat/completions",
    ]);
    for (const { headers } of sent) {
      expect(headers.get("x-portkey-provider")).toBe("openai");
      expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
    }
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

  it("names the provider and the reset time of a plan usage limit", () => {
    const limited = new BlockedError({
      kind: "usage-limit",
      providerId: "claude-login",
      resetsAt: "2026-09-25T20:00:00.000Z",
      detail: "five-hour limit",
    });
    const unknownReset = new BlockedError({
      kind: "usage-limit",
      providerId: "codex-login",
      resetsAt: null,
      detail: "out of credits",
    });

    expect(limited.message).toBe(
      "claude-login reached its plan's usage limit (resets 2026-09-25T20:00:00.000Z): five-hour limit",
    );
    expect(unknownReset.message).toBe(
      "codex-login reached its plan's usage limit: out of credits",
    );
    expect([
      limited.providerId,
      limited.resetsAt,
      unknownReset.resetsAt,
    ]).toEqual(["claude-login", "2026-09-25T20:00:00.000Z", null]);
    expect(isUsageLimit(limited)).toBe(true);
    expect(
      isUsageLimit(
        new BlockedError({
          kind: "rate-limit",
          status: 429,
          observedCeiling: 2,
        }),
      ),
    ).toBe(false);
    expect(isUsageLimit(new Error("usage limit"))).toBe(false);
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
    options: {
      modelInfoBody?: string;
      modelInfoStatus?: number;
      warning?: (code: string, message: string) => void;
    } = {},
  ): Promise<ModelCatalogEntry[]> {
    const body = fixtureBody ?? (await readFile(aiGatewayFixtureUrl, "utf8"));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(
          String(input).endsWith("/models")
            ? body
            : (options.modelInfoBody ?? JSON.stringify({ data: [] })),
          {
            status: String(input).endsWith("/models")
              ? 200
              : (options.modelInfoStatus ?? 200),
            headers: { "content-type": "application/json" },
          },
        ),
    );
    return createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://catalog.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      ...(options.warning === undefined ? {} : { warning: options.warning }),
    }).listModels();
  }

  async function fixtureWithoutPricing(): Promise<string> {
    const fixture = JSON.parse(await readFile(aiGatewayFixtureUrl, "utf8")) as {
      data: Array<Record<string, unknown>>;
    };
    for (const model of fixture.data) delete model.pricing;
    return JSON.stringify(fixture);
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
      releasedAt: null,
      maxOutputTokens: 16_384,
      outputModalities: [],
      requiresReasoning: false,
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

  it("never ranks a Vercel -fast service tier as a judge while its base model is listed", async () => {
    const catalog = await listFixtureModels(
      await readFile(aiGatewayFastTiersFixtureUrl, "utf8"),
    );

    expect(
      pickJudges(catalog, {
        candidateFamily: "inclusionai",
        referenceFamily: "alibaba",
      }),
    ).toEqual([
      "openai/gpt-6-astra",
      "openai/gpt-6-sol",
      "anthropic/claude-opus-5.5",
      "zai/glm-5.3",
      "spacexai/grok-4.1-fast-non-reasoning",
      "openai/gpt-4.1-nano",
      "morph/morph-v3-fast",
    ]);
  });

  it("never shortlists a Vercel -fast service tier while its base model is listed", async () => {
    const catalog = await listFixtureModels(
      await readFile(aiGatewayFastTiersFixtureUrl, "utf8"),
    );

    const result = shortlist(
      [step({ currentModel: "anthropic/claude-opus-5.5" })],
      catalog,
      { top: 20 },
    );

    expect(result[0]?.candidates.map(({ id }) => id)).toEqual([
      "inclusionai/ling-3.0-flash",
      "alibaba/qwen3.7-flash",
      "openai/gpt-4.1-nano",
      "spacexai/grok-4.1-fast-non-reasoning",
      "morph/morph-v3-fast",
      "zai/glm-5.3",
      "openai/gpt-6-sol",
    ]);
  });

  it("still resolves a -fast current model and offers its base model", async () => {
    const catalog = await listFixtureModels(
      await readFile(aiGatewayFastTiersFixtureUrl, "utf8"),
    );

    const result = shortlist(
      [step({ currentModel: "openai/gpt-4.1-nano-fast" })],
      catalog,
      { top: 20 },
    );

    expect(result[0]?.abstention).toBeUndefined();
    expect(result[0]?.candidates.map(({ id }) => id)).toEqual([
      "inclusionai/ling-3.0-flash",
      "alibaba/qwen3.7-flash",
      "openai/gpt-4.1-nano",
      "spacexai/grok-4.1-fast-non-reasoning",
    ]);
  });

  it("normalizes AI Gateway output ceilings", async () => {
    const catalog = await listFixtureModels();

    expect(
      catalog.find(({ id }) => id === "meta/llama-3.3-70b")?.maxOutputTokens,
    ).toBe(8_192);
    expect(
      catalog.find(({ id }) => id === "sakana/namazu")?.maxOutputTokens,
    ).toBe(256_000);
  });

  it("normalizes OpenRouter release, output, modality, and reasoning fields", async () => {
    const [model] = await listFixtureModels(
      JSON.stringify({
        data: [
          {
            id: "openai/example",
            created: 1_788_285_838,
            context_length: 200_000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
            top_provider: { max_completion_tokens: 128_000 },
            architecture: { output_modalities: ["text"] },
            reasoning: { mandatory: true },
          },
        ],
      }),
    );

    expect(model).toMatchObject({
      releasedAt: 1_788_285_838,
      maxOutputTokens: 128_000,
      outputModalities: ["text"],
      requiresReasoning: true,
    });
  });

  it("marks variable-priced router models as unpriceable", async () => {
    const catalog = await listFixtureModels(
      JSON.stringify({
        data: [
          {
            id: "openai/example",
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
          {
            id: "openrouter/auto",
            pricing: { prompt: "-1", completion: "-1" },
          },
        ],
      }),
    );

    expect(catalog).toHaveLength(2);
    expect(
      catalog.find(({ id }) => id === "openrouter/auto")?.pricing,
    ).toBeNull();
  });

  it("applies pricing overrides without fetching another endpoint", async () => {
    const body = await fixtureWithoutPricing();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const catalog = await createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://catalog.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      pricingOverrides: {
        "openai/gpt-4o": {
          input: 0.001,
          output: 0.002,
          maxOutputTokens: 32_768,
        },
      },
    }).listModels();

    expect(catalog.find(({ id }) => id === "openai/gpt-4o")).toMatchObject({
      pricing: { input: 0.001, output: 0.002 },
      maxOutputTokens: 32_768,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("fills an unpriced catalog from LiteLLM model info", async () => {
    const catalog = await listFixtureModels(await fixtureWithoutPricing(), {
      modelInfoBody: JSON.stringify({
        data: [
          {
            model_name: "openai/gpt-4o",
            model_info: {
              input_cost_per_token: 0.000001,
              output_cost_per_token: 0.000002,
              max_output_tokens: 32_768,
            },
          },
          {
            model_name: "meta/llama-3.3-70b",
            model_info: {
              input_cost_per_token: 0.0000003,
              output_cost_per_token: 0.0000004,
              max_tokens: 12_345,
            },
          },
        ],
      }),
    });

    expect(
      catalog
        .filter(({ pricing }) => pricing !== null)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["meta/llama-3.3-70b", "openai/gpt-4o"]);
    expect(catalog.find(({ id }) => id === "openai/gpt-4o")).toMatchObject({
      pricing: { input: 0.000001, output: 0.000002 },
      maxOutputTokens: 32_768,
    });
    expect(catalog.find(({ id }) => id === "meta/llama-3.3-70b")).toMatchObject(
      {
        pricing: { input: 0.0000003, output: 0.0000004 },
        maxOutputTokens: 12_345,
      },
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://catalog.example/model/info",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("warns when LiteLLM model info is unavailable", async () => {
    const warning = vi.fn();
    const catalog = await listFixtureModels(await fixtureWithoutPricing(), {
      modelInfoStatus: 401,
      warning,
    });

    expect(catalog.every(({ pricing }) => pricing === null)).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "catalog_pricing_unavailable",
      expect.stringContaining("vercel-ai-gateway"),
    );
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

  it("warns when total_count exceeds the collected entries", async () => {
    const fixture = JSON.parse(await readFile(aiGatewayFixtureUrl, "utf8")) as {
      data: unknown[];
    };
    const warning = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [fixture.data[0]],
          total_count: 3,
          links: { next: null },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://catalog.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      warning,
    }).listModels();

    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "catalog_truncated",
      expect.stringContaining("1 of 3"),
    );
  });

  it("stops after twenty pages", async () => {
    const fixture = JSON.parse(await readFile(aiGatewayFixtureUrl, "utf8")) as {
      data: unknown[];
    };
    const warning = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [fixture.data[0]],
            links: { next: "/v1/models?offset=1" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://catalog.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      warning,
    }).listModels();

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("never follows a next link to another origin", async () => {
    const fixture = JSON.parse(await readFile(aiGatewayFixtureUrl, "utf8")) as {
      data: unknown[];
    };
    const warning = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [fixture.data[0]],
          links: { next: "https://elsewhere.example/v1/models" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://catalog.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      warning,
    }).listModels();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  async function listWithReference(
    gatewayBody: string,
    catalogReference: string,
    options: {
      warning?: (code: string, message: string) => void;
      pricingOverrides?: Record<string, { input: number; output: number }>;
    } = {},
  ): Promise<ModelCatalogEntry[]> {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(gatewayBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    return createProvider({
      providerId: "envoy-ai-gateway",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      catalogReference,
      ...options,
    }).listModels();
  }

  it("fills an Envoy declared-id catalog from the upstream's catalog reference", async () => {
    const warning = vi.fn();
    const catalog = await listWithReference(
      await readFile(envoyFixtureUrl, "utf8"),
      fileURLToPath(aiGatewayFixtureUrl),
      { warning },
    );

    expect(catalog.map(({ id }) => id)).toEqual([
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "my-fast-model",
    ]);
    expect(catalog.find(({ id }) => id === "openai/gpt-4o-mini")).toEqual({
      id: "openai/gpt-4o-mini",
      family: "openai",
      contextLength: 128_000,
      pricing: { input: 0.00000015, output: 0.0000006 },
      supportsTools: true,
      supportsStructuredOutput: false,
      releasedAt: 1_721_260_800,
      maxOutputTokens: 16_384,
      outputModalities: [],
      requiresReasoning: false,
    });
    expect(
      catalog.find(({ id }) => id === "my-fast-model")?.pricing,
    ).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "catalog_reference_unmatched",
      "1 model(s) in the envoy-ai-gateway catalog have no price after joining the catalog reference, for example my-fast-model. Declare replay models under the ids the reference lists, or pass --pricing-file.",
    );
  });

  it("joins a gateway id that adds a provider prefix to the reference id", async () => {
    const gateway = JSON.stringify({
      data: [
        {
          id: "vercel/openai/gpt-4o-mini",
          context_length: 128_000,
          owned_by: "openai",
        },
      ],
    });
    const [prefixed] = await listWithReference(
      gateway,
      fileURLToPath(aiGatewayFixtureUrl),
    );

    expect(prefixed).toMatchObject({
      id: "vercel/openai/gpt-4o-mini",
      family: "openai",
      contextLength: 128_000,
      pricing: { input: 0.00000015, output: 0.0000006 },
      supportsTools: true,
    });

    vi.restoreAllMocks();
    const directory = await mkdtemp(join(tmpdir(), "rightmodeler-reference-"));
    try {
      const reference = join(directory, "reference.json");
      await writeFile(
        reference,
        JSON.stringify({
          data: [
            { id: "gpt-4o-mini", pricing: { input: "0.1", output: "0.2" } },
            {
              id: "openai/gpt-4o-mini",
              pricing: { input: "0.3", output: "0.4" },
            },
          ],
        }),
      );
      const [longest] = await listWithReference(gateway, reference);

      expect(longest?.pricing).toEqual({ input: 0.3, output: 0.4 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("takes a three-segment id's family from its vendor segment", async () => {
    const catalog = await listFixtureModels(
      await readFile(bifrostModelsFixtureUrl, "utf8"),
    );

    for (const [id, family] of [
      ["vercel/amazon/nova-micro", "amazon"],
      ["vercel/openai/gpt-4o-mini", "openai"],
      ["openrouter/openai/gpt-4o-mini", "openai"],
    ] as const) {
      expect(catalog.find((model) => model.id === id)?.family, id).toBe(family);
    }
  });

  it("never offers a model whose declared output is not text", async () => {
    const fixture = JSON.parse(
      await readFile(bifrostModelsFixtureUrl, "utf8"),
    ) as { data: Array<Record<string, unknown>> };
    const embedding = fixture.data.find(({ architecture }) =>
      (
        architecture as { output_modalities?: string[] } | undefined
      )?.output_modalities?.includes("embeddings"),
    );
    fixture.data.push({
      id: "openrouter/google/gemini-2.5-flash-image",
      context_length: 32_768,
      architecture: { output_modalities: ["text", "image"] },
      pricing: { prompt: "0.0000003", completion: "0.0000025" },
    });

    const ids = (await listFixtureModels(JSON.stringify(fixture))).map(
      ({ id }) => id,
    );

    expect(embedding?.id).toBe("openrouter/baai/bge-base-en-v1.5");
    expect(ids).not.toContain(embedding?.id);
    expect(ids).toContain("openrouter/google/gemini-2.5-flash-image");
  });

  it("joins Bifrost's custom-provider ids to the upstream's catalog by suffix", async () => {
    const catalog = await listWithReference(
      await readFile(bifrostModelsFixtureUrl, "utf8"),
      fileURLToPath(aiGatewayFixtureUrl),
    );

    expect(
      catalog.find(({ id }) => id === "vercel/openai/gpt-4o-mini"),
    ).toMatchObject({
      family: "openai",
      contextLength: 128_000,
      pricing: { input: 0.00000015, output: 0.0000006 },
      supportsTools: true,
      supportsStructuredOutput: false,
    });
    expect(
      catalog.find(({ id }) => id === "openrouter/openai/gpt-4o-mini"),
    ).toMatchObject({
      family: "openai",
      pricing: { input: 0.00000015, output: 0.0000006 },
      supportsTools: true,
      supportsStructuredOutput: true,
    });
  });

  it("never overwrites a price, limit or capability the gateway declares", async () => {
    const [declared] = await listWithReference(
      JSON.stringify({
        data: [
          {
            id: "openai/gpt-4o-mini",
            pricing: { prompt: "0.000001", completion: "0.000002" },
            context_length: 64_000,
            max_tokens: 4_096,
            supported_parameters: [],
            reasoning: { mandatory: true },
          },
        ],
      }),
      fileURLToPath(aiGatewayFixtureUrl),
    );

    expect(declared).toMatchObject({
      pricing: { input: 0.000001, output: 0.000002 },
      contextLength: 64_000,
      maxOutputTokens: 4_096,
      supportsTools: false,
      supportsStructuredOutput: false,
      requiresReasoning: true,
    });
  });

  it("takes a model's release date from the reference over the date the gateway declares", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rightmodeler-reference-"));
    try {
      const reference = join(directory, "reference.json");
      await writeFile(
        reference,
        JSON.stringify({
          data: [
            {
              id: "openai/gpt-6-astra",
              created: 1_755_815_280,
              released: 1_788_480_000,
              pricing: { input: "0.00001", output: "0.00005" },
            },
            {
              id: "acme/undated",
              pricing: { input: "0.000001", output: "0.000002" },
            },
          ],
        }),
      );
      const catalog = await listWithReference(
        JSON.stringify({
          data: [
            {
              id: "vercel/openai/gpt-6-astra",
              created: 1_755_815_280,
              context_length: 1_050_000,
            },
            {
              id: "vercel/acme/undated",
              created: 1_721_260_800,
              context_length: 8_192,
            },
          ],
        }),
        reference,
      );

      expect(catalog.map(({ id, releasedAt }) => [id, releasedAt])).toEqual([
        ["vercel/openai/gpt-6-astra", 1_788_480_000],
        ["vercel/acme/undated", 1_721_260_800],
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ranks judges through a Bifrost catalog as it ranks them on the upstream", async () => {
    const upstream = await readFile(aiGatewayFastTiersFixtureUrl, "utf8");
    const families = {
      candidateFamily: "inclusionai",
      referenceFamily: "alibaba",
    };
    const direct = pickJudges(await listFixtureModels(upstream), families);
    vi.restoreAllMocks();
    const bifrost = JSON.stringify({
      data: (
        JSON.parse(upstream) as { data: Array<Record<string, unknown>> }
      ).data.map(({ id, created, owned_by, context_window }) => ({
        id: `vercel/${String(id)}`,
        created,
        owned_by,
        context_length: context_window,
      })),
    });

    const throughBifrost = pickJudges(
      await listWithReference(
        bifrost,
        fileURLToPath(aiGatewayFastTiersFixtureUrl),
      ),
      families,
    );

    expect(throughBifrost).toEqual(direct.map((id) => `vercel/${id}`));
  });

  it("lets --pricing-file override the reference", async () => {
    const warning = vi.fn();
    const catalog = await listWithReference(
      await readFile(envoyFixtureUrl, "utf8"),
      fileURLToPath(aiGatewayFixtureUrl),
      {
        warning,
        pricingOverrides: {
          "openai/gpt-4o-mini": { input: 0.001, output: 0.002 },
          "my-fast-model": { input: 0.0001, output: 0.0002 },
        },
      },
    );

    expect(catalog.find(({ id }) => id === "openai/gpt-4o-mini")).toMatchObject(
      { pricing: { input: 0.001, output: 0.002 }, contextLength: 128_000 },
    );
    expect(catalog.find(({ id }) => id === "my-fast-model")?.pricing).toEqual({
      input: 0.0001,
      output: 0.0002,
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it("fetches a URL reference without the gateway's key or headers", async () => {
    const referenceUrl = "https://reference.example/v1/models";
    const referenceBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const gatewayBody = await readFile(envoyFixtureUrl, "utf8");
    const sent: Array<{ url: string; headers: Headers }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      sent.push({ url, headers: new Headers(init?.headers) });
      return new Response(url === referenceUrl ? referenceBody : gatewayBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const catalog = await createProvider({
      providerId: "portkey",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      headers: { "x-portkey-provider": "openai" },
      catalogReference: referenceUrl,
    }).listModels();

    expect(sent.map(({ url }) => url)).toEqual([
      "https://gateway.example/v1/models",
      referenceUrl,
    ]);
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
    expect(sent[0]?.headers.get("x-portkey-provider")).toBe("openai");
    expect([...sent[1]!.headers.keys()]).toEqual([]);
    expect(catalog.find(({ id }) => id === "openai/gpt-4o")?.pricing).toEqual({
      input: 0.0000025,
      output: 0.00001,
    });
  });

  it("stops with a named error when the reference cannot be read", async () => {
    const gatewayBody = await readFile(envoyFixtureUrl, "utf8");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://down.example/")) {
        throw new TypeError("fetch failed", {
          cause: new Error("getaddrinfo ENOTFOUND down.example"),
        });
      }
      return url.startsWith("https://gone.example/")
        ? new Response("not found", { status: 404 })
        : new Response(gatewayBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    });
    const directory = await mkdtemp(join(tmpdir(), "rightmodeler-reference-"));
    try {
      const missing = join(directory, "missing.json");
      const malformed = join(directory, "malformed.json");
      await writeFile(malformed, JSON.stringify({ models: [] }));

      for (const [catalogReference, message] of [
        [
          "https://gone.example/v1/models",
          "Catalog reference https://gone.example/v1/models answered HTTP 404",
        ],
        [
          "https://down.example/v1/models",
          "Catalog reference https://down.example/v1/models could not be fetched: fetch failed (getaddrinfo ENOTFOUND down.example)",
        ],
        [
          missing,
          `Catalog reference ${missing} could not be read: ENOENT: no such file or directory, open '${missing}'`,
        ],
        [
          malformed,
          `Catalog reference ${malformed} is not an OpenAI-compatible /models document: model catalog data must be an array`,
        ],
      ] as const) {
        const rejection = createProvider({
          providerId: "envoy-ai-gateway",
          baseUrl: "https://gateway.example/v1",
          apiKeyEnv: "REPLAY_TEST_API_KEY",
          catalogReference,
        }).listModels();
        await expect(rejection).rejects.toBeInstanceOf(CatalogReferenceError);
        await expect(rejection).rejects.toMatchObject({
          name: "CatalogReferenceError",
          message,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

describe("Anthropic catalog", () => {
  const firstPage = "https://api.anthropic.com/v1/models";
  const secondPage =
    "https://api.anthropic.com/v1/models?after_id=claude-opus-5&limit=1000";

  beforeEach(() => {
    process.env.REPLAY_TEST_API_KEY = fakeKey;
  });

  afterEach(() => {
    delete process.env.REPLAY_TEST_API_KEY;
    vi.restoreAllMocks();
  });

  async function listAnthropicModels(
    options: {
      headers?: Record<string, string>;
      catalogReference?: string;
    } = {},
  ): Promise<{
    catalog: ModelCatalogEntry[];
    requests: Array<{ url: string; anthropicVersion: string | null }>;
  }> {
    const [page1, page2] = JSON.parse(
      await readFile(anthropicModelsFixtureUrl, "utf8"),
    ) as unknown[];
    const requests: Array<{ url: string; anthropicVersion: string | null }> =
      [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        anthropicVersion: new Headers(init?.headers).get("anthropic-version"),
      });
      const body =
        url === firstPage ? page1 : url === secondPage ? page2 : undefined;
      return new Response(JSON.stringify(body ?? {}), {
        status: body === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    const catalog = await createProvider({
      providerId: "anthropic-direct",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      ...options,
    }).listModels();
    return { catalog, requests };
  }

  async function withReference<T>(
    models: ReadonlyArray<Record<string, unknown>>,
    use: (reference: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "rightmodeler-anthropic-"));
    try {
      const reference = join(directory, "reference.json");
      await writeFile(reference, JSON.stringify({ data: models }));
      return await use(reference);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const referenceModel = (id: string, input: string, output: string) => ({
    id,
    type: "language",
    context_window: 1_000_000,
    pricing: { input, output },
    supported_parameters: ["tools", "response_format"],
  });
  const anthropicReference = [
    referenceModel("anthropic/claude-opus-5", "0.000005", "0.000025"),
    referenceModel("anthropic/claude-haiku-4.5", "0.000001", "0.000005"),
  ];

  it("keeps Anthropic's type model entries with their context and release date", async () => {
    const { catalog } = await listAnthropicModels();

    expect(catalog.map(({ id }) => id)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(catalog[0]).toMatchObject({
      releasedAt: 1_784_851_200,
      contextLength: 0,
    });
    expect(catalog[1]).toMatchObject({
      contextLength: 200_000,
      maxOutputTokens: 64_000,
      releasedAt: null,
    });
  });

  it("walks has_more pages with after_id on the same origin", async () => {
    const { requests } = await listAnthropicModels();

    expect(
      requests.map(({ url }) => url).filter((url) => url.startsWith(firstPage)),
    ).toEqual([firstPage, secondPage]);
  });

  it("sends anthropic-version unless the user sets it", async () => {
    const { requests } = await listAnthropicModels();

    expect(requests.length).toBeGreaterThan(0);
    expect([
      ...new Set(requests.map(({ anthropicVersion }) => anthropicVersion)),
    ]).toEqual(["2023-06-01"]);

    vi.restoreAllMocks();
    const custom = await listAnthropicModels({
      headers: { "anthropic-version": "2099-01-01" },
    });

    expect(custom.requests.length).toBeGreaterThan(0);
    expect([
      ...new Set(
        custom.requests.map(({ anthropicVersion }) => anthropicVersion),
      ),
    ]).toEqual(["2099-01-01"]);
  });

  it("never claims structured output through Anthropic's OpenAI compatibility", async () => {
    const { catalog } = await withReference(anthropicReference, (reference) =>
      listAnthropicModels({ catalogReference: reference }),
    );

    expect(
      catalog.map(({ id, supportsTools, supportsStructuredOutput }) => [
        id,
        supportsTools,
        supportsStructuredOutput,
      ]),
    ).toEqual([
      ["claude-opus-5", true, false],
      ["claude-haiku-4-5-20251001", true, false],
    ]);
  });

  it("joins bare and dated ids to a vendor-prefixed catalog reference within their vendor", async () => {
    const { catalog } = await withReference(
      [
        ...anthropicReference,
        referenceModel(
          "anthropic/claude-opus-5-20260724",
          "0.00001",
          "0.00005",
        ),
        referenceModel("zeta/claude-haiku-4.5", "0.0000002", "0.0000008"),
      ],
      (reference) => listAnthropicModels({ catalogReference: reference }),
    );

    expect(
      catalog.map(({ id, family, pricing }) => [id, family, pricing]),
    ).toEqual([
      ["claude-opus-5", "anthropic", { input: 0.000005, output: 0.000025 }],
      [
        "claude-haiku-4-5-20251001",
        "anthropic",
        { input: 0.000001, output: 0.000005 },
      ],
    ]);
  });
});

describe("OpenAI direct catalog", () => {
  beforeEach(() => {
    process.env.REPLAY_TEST_API_KEY = fakeKey;
  });

  afterEach(() => {
    delete process.env.REPLAY_TEST_API_KEY;
    vi.restoreAllMocks();
  });

  async function listOpenAIModels(
    baseUrl: string,
  ): Promise<ModelCatalogEntry[]> {
    const body = await readFile(openaiModelsFixtureUrl, "utf8");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) =>
        new Response(String(input).endsWith("/models") ? body : "{}", {
          status: String(input).endsWith("/models") ? 200 : 404,
          headers: { "content-type": "application/json" },
        }),
    );
    return createProvider({
      providerId: "openai-direct",
      baseUrl,
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    }).listModels();
  }

  it("gives bare ids from api.openai.com the openai family", async () => {
    const catalog = await listOpenAIModels("https://api.openai.com/v1");

    expect(catalog.map(({ id, family }) => [id, family])).toEqual([
      ["gpt-6-sol", "openai"],
      ["gpt-6-luna", "openai"],
      ["text-embedding-3-small", "openai"],
    ]);
  });

  it("leaves bare ids from an unknown host vendorless", async () => {
    const catalog = await listOpenAIModels("https://gateway.example/v1");

    expect(catalog.map(({ id, family }) => [id, family])).toEqual([
      ["gpt-6-sol", "gpt-6-sol"],
      ["gpt-6-luna", "gpt-6-luna"],
      ["text-embedding-3-small", "text-embedding-3-small"],
    ]);
  });

  it("sends anthropic-version to no host other than api.anthropic.com", async () => {
    for (const baseUrl of [
      "https://api.openai.com/v1",
      "https://gateway.example/v1",
      "https://anthropic.example.com/v1",
    ]) {
      vi.restoreAllMocks();
      await listOpenAIModels(baseUrl);
      const versions = vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([, init]) =>
          new Headers(init?.headers).get("anthropic-version"),
        );

      expect(versions.length, baseUrl).toBeGreaterThan(0);
      expect(new Set(versions), baseUrl).toEqual(new Set([null]));
    }
  });

  it("asks api.openai.com for max_completion_tokens and every other host for max_tokens", async () => {
    const catalogBody = await readFile(openaiModelsFixtureUrl, "utf8");
    const chatBody = JSON.stringify({
      id: "chatcmpl-052",
      object: "chat.completion",
      model: "gpt-6-luna",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
    const sentBody = async (baseUrl: string) => {
      vi.restoreAllMocks();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async (input) =>
            new Response(
              String(input).endsWith("/models") ? catalogBody : chatBody,
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        );
      await createProvider({
        providerId: "openai-direct",
        baseUrl,
        apiKeyEnv: "REPLAY_TEST_API_KEY",
        pricingOverrides: {
          "gpt-6-luna": { input: 0.0000001, output: 0.0000005 },
        },
      }).chat({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "Reply with ok." }],
        maxOutputTokens: 40,
      });
      const [, init] = fetchMock.mock.calls.find(([input]) =>
        String(input).endsWith("/chat/completions"),
      )!;
      return JSON.parse(String(init?.body)) as Record<string, unknown>;
    };

    const direct = await sentBody("https://api.openai.com/v1");
    expect(Object.keys(direct)).toEqual([
      "model",
      "messages",
      "max_completion_tokens",
      "stream",
    ]);
    expect(direct.max_completion_tokens).toBe(40);

    for (const baseUrl of [
      "https://gateway.example/v1",
      "https://api.anthropic.com/v1",
      "https://openai.example.com/v1",
    ]) {
      const other = await sentBody(baseUrl);
      expect(Object.keys(other), baseUrl).toEqual([
        "model",
        "messages",
        "max_tokens",
        "stream",
      ]);
      expect(other.max_tokens, baseUrl).toBe(40);
    }
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
      finishReason: "stop",
      providerResponseId: "gen_01KZYSK582PZST0T79EP0DJ1FJ",
      servedModel: "openai/gpt-4o-mini",
    });
  });

  it("reads a Bifrost usage.cost object as the billed cost", async () => {
    const captured = JSON.parse(
      await readFile(bifrostChatFixtureUrl, "utf8"),
    ) as {
      requestedModel: string;
      body: { usage: { cost: { total_cost: number } } };
    };
    const catalogBody = await readFile(bifrostModelsFixtureUrl, "utf8");
    const chat = (body: unknown) => {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input) =>
          new Response(
            String(input).endsWith("/models")
              ? catalogBody
              : JSON.stringify(body),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      return createProvider({
        providerId: "bifrost",
        baseUrl: "https://bifrost.example/v1",
        apiKeyEnv: "REPLAY_TEST_API_KEY",
      }).chat({
        model: captured.requestedModel,
        messages: [{ role: "user", content: "Say the single word OK." }],
        maxOutputTokens: 64,
        estimatedInputTokens: 8,
      });
    };

    const response = await chat(captured.body);
    expect(response).toMatchObject({
      costUsd: captured.body.usage.cost.total_cost,
      costIsEstimate: false,
    });
    expect(response.costUsd).toBeGreaterThan(0);
    await expect(
      chat({
        ...captured.body,
        usage: { ...captured.body.usage, cost: { total_cost: "abc" } },
      }),
    ).rejects.toThrow(/^Invalid chat response: usage\.cost\.total_cost /);
  });

  it("records the served model and flags a response that names another model", async () => {
    const fixture = JSON.parse(
      await readFile(aiGatewayChatFixtureUrl, "utf8"),
    ) as { model: string };
    fixture.model = "openai/gpt-4.1-nano";

    await expect(
      chatFromFixture(JSON.stringify(fixture)),
    ).resolves.toMatchObject({
      content: "Ok!",
      servedModel: "openai/gpt-4.1-nano",
      substitution: {
        kind: "model",
        evidence: "served openai/gpt-4.1-nano for requested openai/gpt-4o-mini",
      },
    });
  });

  it("falls back to the response id without a generation id", async () => {
    const fixture = JSON.parse(
      await readFile(aiGatewayChatFixtureUrl, "utf8"),
    ) as { generationId?: string };
    delete fixture.generationId;

    const response = await chatFromFixture(JSON.stringify(fixture));

    expect(response.providerResponseId).toBe("chatcmpl-SANITIZED");
  });

  it("carries finish_reason onto the response", async () => {
    const fixtureBody = await readFile(aiGatewayChatFixtureUrl, "utf8");
    const response = await chatFromFixture(
      fixtureBody.replace(
        '"finish_reason": "stop"',
        '"finish_reason": "length"',
      ),
    );

    expect(response.finishReason).toBe("length");
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

  it("retries a 200 body whose first choice finished with error", async () => {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const chatBody = await readFile(aiGatewayChatFixtureUrl, "utf8");
    const fixture = JSON.parse(chatBody) as {
      choices: Array<{
        finish_reason: string;
        message: { content: string };
      }>;
    };
    fixture.choices[0]!.finish_reason = "error";
    fixture.choices[0]!.message.content = "partial";
    const onAttempt = vi.fn();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
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
    expect(onAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outcome: "provider_error",
        errorDetail: {
          status: 200,
          bodyExcerpt: expect.stringContaining("partial"),
        },
      }),
    );
  });

  it("gives up after five error bodies", async () => {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const onAttempt = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              id: "gen-1",
              error: { code: 502, message: "upstream failed" },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "retry-after": "0",
              },
            },
          ),
      );
    const response = createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://chat.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    }).chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say okay." }],
      onAttempt,
    });

    await expect(response).rejects.toMatchObject({
      name: "BlockedError",
      kind: "rate-limit",
    });
    expect(onAttempt).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("retries a thrown connection error with backoff", async () => {
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
      .mockRejectedValueOnce(new TypeError("fetch failed"))
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
        errorDetail: { status: null, bodyExcerpt: "fetch failed" },
      }),
    );
  });

  it("gives up after five connection failures", async () => {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const onAttempt = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValue(new TypeError("fetch failed"));
    const response = createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://chat.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    }).chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say okay." }],
      onAttempt,
    });

    await expect(response).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(response).rejects.toThrow("fetch failed");
    expect(onAttempt).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    [401, "credentials"],
    [403, "credentials"],
    [402, "credits"],
  ] as const)("blocks once on HTTP %s", async (status, kind) => {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const onAttempt = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("denied", { status }));
    const response = createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://chat.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    }).chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say okay." }],
      onAttempt,
    });

    await expect(response).rejects.toMatchObject({
      name: "BlockedError",
      kind,
      providerId: "vercel-ai-gateway",
      errorDetail: { status, bodyExcerpt: "denied" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it("sheds load on a 5xx storm", async () => {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementation(
        async () =>
          new Response("", {
            status: 500,
            headers: { "retry-after": "0" },
          }),
      );
    const provider = createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://chat.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });

    await expect(
      provider.chat({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say okay." }],
      }),
    ).rejects.toMatchObject({
      name: "BlockedError",
      kind: "rate-limit",
      observedCeiling: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("keeps a 429 storm above the serial floor", async () => {
    const catalogBody = await readFile(aiGatewayFixtureUrl, "utf8");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(catalogBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementation(
        async () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": "0" },
          }),
      );
    const provider = createProvider({
      providerId: "vercel-ai-gateway",
      baseUrl: "https://chat.example/v1",
      apiKeyEnv: "REPLAY_TEST_API_KEY",
    });

    await expect(
      provider.chat({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Say okay." }],
      }),
    ).rejects.toMatchObject({
      name: "BlockedError",
      kind: "rate-limit",
      observedCeiling: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([408, 409, 429, 500])(
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

  it("keeps spend when its reservation was reclaimed before the refund", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    try {
      const budget = createBudget({
        store,
        projectId,
        runId,
        authorizedTotalUsd: 0.01,
      });
      const reservation = await budget.reserveExecution({
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
      expect(await resumedBudget.state()).toMatchObject({
        spentUsd: 0,
        reservedUsd: 0,
      });

      await reservation.refund(0.004);
      expect(await budget.state()).toMatchObject({
        spentUsd: 0.004,
        reservedUsd: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the owner run once per prune and never on heartbeat or refund", async () => {
    const counting = countingStore(store, runKey(projectId, runId));
    const budget = createBudget({
      store: counting,
      projectId,
      runId,
      authorizedTotalUsd: 1,
    });
    await budget.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 0,
      pricing: { input: 0.001, output: 0 },
    });
    await budget.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 0,
      pricing: { input: 0.001, output: 0 },
    });

    const readsBeforeThird = counting.reads();
    const third = await budget.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 0,
      pricing: { input: 0.001, output: 0 },
    });
    expect(counting.reads() - readsBeforeThird).toBe(1);

    const readsBeforeMaintenance = counting.reads();
    await third.heartbeat();
    await third.refund(0);
    expect(counting.reads() - readsBeforeMaintenance).toBe(0);
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

  const worstCase = (usd: number) => ({
    contextTokens: 1,
    maxOutputTokens: 0,
    pricing: { input: usd, output: 0 },
  });

  it("settles the same spend and cap decision whichever order refunds land in", async () => {
    for (const costs of [
      [0.1, 0.2, 0.3],
      [0.3, 0.2, 0.1],
    ]) {
      const budget = createBudget({
        store,
        projectId,
        runId: `run-${costs.join("-")}`,
        authorizedTotalUsd: 0.7,
      });
      const reservations = [];
      for (const cost of costs) {
        reservations.push(await budget.reserveExecution(worstCase(cost)));
      }
      expect((await budget.state()).reservedUsd).toBe(0.6);
      for (const [index, reservation] of reservations.entries()) {
        await reservation.refund(costs[index]!);
      }

      expect((await budget.state()).spentUsd).toBe(0.6);
      const next = await budget.reserveExecution(worstCase(0.1));
      expect(next.reservedUsd).toBe(0.1);
      // The grid keeps sub-nano-dollar costs that cheap per-token prices produce.
      await next.refund(0.000000000375);
      expect((await budget.state()).spentUsd).toBe(0.600000000375);
    }
  });

  it("admits an execution whose worst case exactly fills the cap", async () => {
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.3,
    });
    const first = await budget.reserveExecution(worstCase(0.1));
    await first.refund(0.1);

    const fill = await budget.reserveExecution(worstCase(0.2));
    expect(fill.reservedUsd).toBe(0.2);
    // The same fit held back only by an in-flight reservation waits for it,
    // rather than asking for a higher cap.
    await expect(budget.reserveExecution(worstCase(0.2))).rejects.toMatchObject(
      { requiredCapUsd: 0.3, causedByReservations: true },
    );
    await fill.refund(0);

    await budget.reserveExecution(worstCase(0.1));
    await expect(
      budget.reserveExecution(worstCase(0.1)),
    ).resolves.toMatchObject({ reservedUsd: 0.1 });
  });

  it("admits an exact fit under a cap just below its grid point", async () => {
    // 0.3.0 printed its remedy unsnapped: $0.10 spent plus a $0.70 worst case
    // asked for --max-cost-usd 0.7999999999999999.
    const budget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.1 + 0.7,
    });
    const first = await budget.reserveExecution(worstCase(0.1));
    await first.refund(0.1);
    const held = await budget.reserveExecution(worstCase(0.1));

    await expect(budget.reserveExecution(worstCase(0.7))).rejects.toMatchObject(
      { requiredCapUsd: 0.8, causedByReservations: true },
    );
    await held.refund(0);
    await expect(
      budget.reserveExecution(worstCase(0.7)),
    ).resolves.toMatchObject({ reservedUsd: 0.7 });
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

  it("resolves a bare recorded model id to one gateway slug", () => {
    const result = shortlist(
      [step({ currentModel: "gpt-4o" })],
      [
        { ...catalog[0]!, id: "openai/gpt-4o", family: "openai" },
        { ...catalog[1]!, id: "openai/gpt-4o-mini", family: "openai" },
      ],
    );

    expect(result[0]).toMatchObject({
      resolvedCurrentModelId: "openai/gpt-4o",
      candidates: [{ id: "openai/gpt-4o-mini" }],
    });
  });

  it("abstains when a bare recorded model id matches more than one slug", () => {
    const result = shortlist(
      [step({ currentModel: "gpt-4o" })],
      [
        { ...catalog[0]!, id: "openai/gpt-4o", family: "openai" },
        { ...catalog[0]!, id: "azure/gpt-4o", family: "azure" },
      ],
    );

    expect(result[0]).toMatchObject({
      candidates: [],
      droppedByOutputCeiling: 0,
      abstention: {
        kind: "current-model-ambiguous",
        message:
          "Recorded model gpt-4o matches more than one catalog model: azure/gpt-4o, openai/gpt-4o",
      },
    });
  });

  it("resolves a dated recorded id to the dotted catalog id", () => {
    const result = shortlist(
      [step({ currentModel: "claude-haiku-4-5-20251001" })],
      [
        {
          ...catalog[0]!,
          id: "anthropic/claude-haiku-4.5",
          family: "anthropic",
        },
        {
          ...catalog[1]!,
          id: "anthropic/claude-lite-1",
          family: "anthropic",
        },
      ],
    );

    expect(result[0]).toMatchObject({
      resolvedCurrentModelId: "anthropic/claude-haiku-4.5",
      candidates: [{ id: "anthropic/claude-lite-1" }],
    });
  });

  it("keeps a canonical match inside the recorded vendor", () => {
    const result = shortlist(
      [step({ currentModel: "acme/x-1" })],
      [{ ...catalog[0]!, id: "zeta/x.1", family: "zeta" }],
    );

    expect(result[0]).toMatchObject({
      candidates: [],
      abstention: { kind: "current-model-absent" },
    });
  });

  it("drops candidates below the recorded output ceiling", () => {
    const result = shortlist(
      [
        step({
          currentModel: "openai/gpt-4o",
          recordedMaxOutputTokens: 16_384,
        }),
      ],
      [
        {
          ...catalog[0]!,
          id: "openai/gpt-4o",
          family: "openai",
          maxOutputTokens: 16_384,
        },
        {
          ...catalog[1]!,
          id: "meta/llama-3.3-70b",
          family: "meta",
          maxOutputTokens: 8_192,
        },
      ],
    );

    expect(result[0]).toMatchObject({
      candidates: [],
      droppedByOutputCeiling: 1,
    });
  });

  it("names an all-null pricing catalog", () => {
    const result = shortlist(
      [step({ currentModel: "openai/gpt-4o" })],
      [
        {
          ...catalog[0]!,
          id: "openai/gpt-4o",
          family: "openai",
          pricing: null,
        },
        {
          ...catalog[1]!,
          id: "meta/llama-3.3-70b",
          family: "meta",
          pricing: null,
        },
      ],
    );

    expect(result[0]).toMatchObject({
      candidates: [],
      abstention: { kind: "no-priced-candidates" },
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

  it("refuses a recorded assistant message that carries tool calls", () => {
    const toolCall = {
      id: "call-1",
      type: "function",
      function: { name: "lookup", arguments: "{}" },
    };
    expect(() =>
      toWireMessages([
        { role: "assistant", content: "", tool_calls: [toolCall] },
      ]),
    ).toThrow(/carries tool calls/);
    expect(
      toWireMessages([{ role: "assistant", content: "", tool_calls: [] }]),
    ).toEqual([{ role: "assistant", content: "" }]);
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
    rankedModels = [
      { judgeModel, supportsStructuredOutput: true, ...unpricedJudgeLimits },
    ],
    warning?: (code: string, message: string) => void,
    authorizedTotalUsd = 1,
    wrapBudget = (budget: Budget) => budget,
    judgeProviderId?: string,
  ) {
    const catalog = await provider.listModels();
    const candidate = catalog.find((model) => model.id === "acme/small-1");
    if (candidate === undefined) throw new Error("Missing stub candidate");
    const budget = wrapBudget(
      createBudget({
        store,
        projectId,
        runId,
        authorizedTotalUsd,
      }),
    );
    return replayModeA({
      steps: [step()],
      cases,
      candidates: [
        {
          stepId: "step-1",
          candidates: [candidate],
          droppedByTop: 0,
          droppedFreeModels: 0,
          droppedByOutputCeiling: 0,
        },
      ],
      provider,
      judge: {
        chat: judgeChat,
        rankedModels,
        ...(warning === undefined ? {} : { warning }),
        ...(judgeProviderId === undefined
          ? {}
          : { providerId: judgeProviderId }),
      },
      store,
      budget,
      concurrency,
    });
  }

  const providerJudge: JudgeChat = async (request) =>
    provider.chat({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      maxOutputTokens: 256,
      responseFormat: request.responseFormat as JsonValue,
    });

  async function restartStub(options: StubOptions): Promise<void> {
    await stub.close();
    stub = await startStub(options);
    provider = createProvider({
      providerId: "stub-provider",
      baseUrl: baseUrl(stub),
      apiKeyEnv: "REPLAY_TEST_API_KEY",
      maxConcurrency: 4,
    });
  }

  const rankedJudges = [
    {
      judgeModel: "zeta/judge-1",
      supportsStructuredOutput: true,
      ...unpricedJudgeLimits,
    },
    {
      judgeModel: "yotta/judge-2",
      supportsStructuredOutput: false,
      ...unpricedJudgeLimits,
    },
  ];

  function numberedCases(count: number, first = 1): RecordedCase[] {
    return Array.from({ length: count }, (_, index) =>
      recordedCase({
        caseId: `case-${first + index}`,
        trajectoryId: `trajectory-${first + index}`,
      }),
    );
  }

  function planUsageLimit(): BlockedError {
    return new BlockedError({
      kind: "usage-limit",
      providerId: "plan-route",
      resetsAt: "2026-09-25T20:00:00.000Z",
      detail: "fixture plan limit",
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
        .filter((event) => event.actor === "judge")
        .reduce((total, event) => total + event.costUsd, 0),
    ).toBeGreaterThan(0);
    expect(
      spend
        .filter((event) => event.actor === "replay-driver")
        .reduce((total, event) => total + event.costUsd, 0),
    ).toBeGreaterThan(0);
  });

  it("retries a 200 body carrying an error and scores only the retried completion", async () => {
    const result = await run([
      recordedCase({
        headers: { "x-stub-error-body-once": "error-body-case" },
      }),
    ]);
    const facts = await readFacts(store);
    const attempts = facts.filter((fact) => "attemptId" in fact);
    const executions = facts.filter(
      (fact) => "executionId" in fact && "caseId" in fact,
    );
    const providerError = attempts.find(
      (attempt) => attempt.streamOutcome === "provider_error",
    );

    expect(result.blocked).toEqual([]);
    expect(attempts.map((attempt) => attempt.streamOutcome).sort()).toEqual([
      "completed",
      "provider_error",
    ]);
    expect(providerError).toMatchObject({
      errorDetail: {
        status: 200,
        bodyExcerpt: expect.stringContaining("after generation started"),
      },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ terminalOutcome: "success" });
  });

  it("persists the provider response id and finish reason on the attempt fact", async () => {
    await run([recordedCase()]);
    const facts = await readFacts(store);
    const completedAttempt = facts.find(
      (fact) => "attemptId" in fact && fact.streamOutcome === "completed",
    );

    expect(completedAttempt).toMatchObject({
      providerResponseId: expect.stringMatching(/^stub-/),
      finishReason: "stop",
    });
  });

  it("writes a candidate answered by another model as substituted and never judges it", async () => {
    await restartStub({ servedModels: { "acme/small-1": "acme/large-1" } });
    const counter = { calls: 0 };
    const substitution = {
      kind: "model",
      evidence: "served acme/large-1 for requested acme/small-1",
    };

    const result = await run([recordedCase()], judge(counter));
    const facts = await readFacts(store);
    const executions = facts.filter(
      (fact) => "executionId" in fact && "caseId" in fact,
    );

    expect(result).toMatchObject({
      completed: 1,
      blocked: [],
      substituted: [{ candidateId: "acme/small-1", substitution }],
    });
    expect(result.substituted).toHaveLength(1);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      candidateId: "acme/small-1",
      terminalOutcome: "abstain",
      attribution: "substituted",
      finalOutput: expect.stringMatching(/^Deterministic reply /),
    });
    expect(
      facts.find(
        (fact) => "attemptId" in fact && fact.streamOutcome === "completed",
      ),
    ).toMatchObject({ servedModel: "acme/large-1", substitution });
    expect(counter.calls).toBe(0);
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(0);
  });

  it("writes a cache hit as substituted", async () => {
    await restartStub({
      responseHeaders: { "x-portkey-cache-status": "HIT" },
    });
    const counter = { calls: 0 };

    const result = await run([recordedCase()], judge(counter));
    const facts = await readFacts(store);

    expect(result.substituted).toEqual([
      {
        candidateId: "acme/small-1",
        substitution: {
          kind: "cache",
          evidence: "x-portkey-cache-status: HIT",
        },
      },
    ]);
    expect(
      facts.find((fact) => "executionId" in fact && "caseId" in fact),
    ).toMatchObject({ terminalOutcome: "abstain", attribution: "substituted" });
    expect(
      facts.find(
        (fact) => "attemptId" in fact && fact.streamOutcome === "completed",
      ),
    ).toMatchObject({
      servedModel: "acme/small-1",
      substitution: { kind: "cache" },
    });
    expect(counter.calls).toBe(0);
  });

  it("stamps every completed attempt with a measured latency", async () => {
    await run([recordedCase()]);
    const facts = await readFacts(store);
    const latencies = facts.flatMap((fact) =>
      "attemptId" in fact && fact.streamOutcome === "completed"
        ? [fact.latencyMs]
        : [],
    );

    expect(latencies.length).toBeGreaterThan(0);
    for (const latencyMs of latencies) {
      expect(typeof latencyMs).toBe("number");
      expect(latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses kernel judge provenance and records position-swap evidence", async () => {
    const requests: Parameters<JudgeChat>[0][] = [];
    await run([recordedCase()], async (request) => {
      requests.push(request);
      return judgeReply(
        JSON.stringify({
          verdict: "equivalent",
          score: 1,
          justification: "Equivalent fixture outputs.",
        }),
      );
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
        ...unpricedJudgeLimits,
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

  it("judges executions concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowJudge: JudgeChat = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight -= 1;
      return judgeReply(
        JSON.stringify({
          verdict: "equivalent",
          score: 1,
          justification: "Equivalent fixture outputs.",
        }),
      );
    };
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index + 1}`,
        trajectoryId: `trajectory-${index + 1}`,
      }),
    );

    const result = await run(cases, slowJudge, 4);

    expect(result.completed).toBe(4);
    expect(maxInFlight).toBeGreaterThan(2);
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
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
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
    expect([6, 8]).toContain(
      requests.filter(({ model }) => model === "zeta/judge-1").length,
    );
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
          return judgeReply('{"verdict":');
        }
        return judgeReply(
          JSON.stringify({
            verdict: "equivalent",
            score: 1,
            justification: "Equivalent fixture outputs.",
          }),
        );
      },
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
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
    expect([6, 8]).toContain(
      judgeModels.filter((model) => model === "zeta/judge-1").length,
    );
    expect(
      judgeModels.filter((model) => model === "yotta/judge-2"),
    ).toHaveLength(8);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("fails over from a judge whose responses name another model", async () => {
    await restartStub({ servedModels: { "zeta/judge-1": "acme/large-1" } });
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
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
      ],
      warning,
    );
    const facts = await readFacts(store);
    const assessments = facts.filter((fact) => "assessmentId" in fact);
    const substitutedJudgeSpend = facts.filter(
      (fact) =>
        "actor" in fact &&
        fact.actor === "judge" &&
        typeof fact.reconcilableTo === "object" &&
        fact.reconcilableTo !== null &&
        !Array.isArray(fact.reconcilableTo) &&
        fact.reconcilableTo.judgeModel === "zeta/judge-1" &&
        fact.reconcilableTo.invocation !== undefined,
    );

    expect(result).toMatchObject({
      completed: 4,
      blocked: [],
      substituted: [],
    });
    expect(warning).toHaveBeenCalledWith(
      "judge_unusable",
      expect.stringContaining("zeta/judge-1"),
    );
    expect(assessments).toHaveLength(4);
    expect(
      assessments.every((fact) => fact.evaluatorId === "yotta/judge-2"),
    ).toBe(true);
    expect(substitutedJudgeSpend.length).toBeGreaterThanOrEqual(1);
    expect(
      substitutedJudgeSpend.every(
        (fact) => "costUsd" in fact && fact.costUsd > 0,
      ),
    ).toBe(true);
    expect(
      facts.filter(
        (fact) =>
          "attemptId" in fact &&
          fact.streamOutcome === "provider_error" &&
          fact.errorDetail?.bodyExcerpt ===
            "served acme/large-1 for requested zeta/judge-1",
      ).length,
    ).toBe(substitutedJudgeSpend.length);
  });

  it("tries at most four systematically malformed judges", async () => {
    const warning = vi.fn();
    const judgeModels: string[] = [];
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
        return judgeReply('{"verdict":');
      },
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "xray/judge-3",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "whiskey/judge-4",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "unused/judge-5",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
      ],
      warning,
    );
    const facts = await readFacts(store);

    expect(result).toMatchObject({ completed: 4, blocked: [] });
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(0);
    expect(
      facts.filter((fact) => "executionId" in fact && "caseId" in fact),
    ).toHaveLength(4);
    expect([6, 8]).toContain(
      judgeModels.filter((model) => model === "zeta/judge-1").length,
    );
    expect([6, 8]).toContain(
      judgeModels.filter((model) => model === "yotta/judge-2").length,
    );
    expect([6, 8]).toContain(
      judgeModels.filter((model) => model === "xray/judge-3").length,
    );
    expect([6, 8]).toContain(
      judgeModels.filter((model) => model === "whiskey/judge-4").length,
    );
    expect(judgeModels).not.toContain("unused/judge-5");
    expect(Array.from(new Set(judgeModels))).toEqual([
      "zeta/judge-1",
      "yotta/judge-2",
      "xray/judge-3",
      "whiskey/judge-4",
    ]);
    expect(warning).toHaveBeenCalledTimes(4);
    expect(warning).toHaveBeenNthCalledWith(
      4,
      "judge_unusable",
      "Judge whiskey/judge-4 is unusable after three consecutive terminal failures; no eligible fallback judge remains.",
    );
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
        throw new BlockedError({
          kind: "rate-limit",
          status: 429,
          observedCeiling: 2,
        });
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

  it("heartbeats the reservation while a cell is in flight", async () => {
    vi.useFakeTimers();
    const candidate: ModelCatalogEntry = {
      id: "vendor/candidate",
      family: "vendor",
      contextLength: 100,
      pricing: { input: 0.006, output: 0.004 },
      supportsTools: false,
      supportsStructuredOutput: false,
    };
    const inner = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 1,
    });
    let heartbeats = 0;
    const budget: Budget = {
      ...inner,
      reserveExecution: async (request) => {
        const reservation = await inner.reserveExecution(request);
        return {
          ...reservation,
          heartbeat: async () => {
            heartbeats += 1;
            await reservation.heartbeat();
          },
        };
      },
    };
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gatedProvider: ProviderClient = {
      providerId: "gated-provider",
      listModels: async () => [candidate],
      chat: async (request) => {
        resolveStarted();
        await gate;
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

    try {
      const running = replayModeA({
        steps: [step()],
        cases: [recordedCase({ contextTokens: 1, maxOutputTokens: 1 })],
        candidates: [
          {
            stepId: "step-1",
            candidates: [candidate],
            droppedByTop: 0,
            droppedFreeModels: 0,
            droppedByOutputCeiling: 0,
          },
        ],
        provider: gatedProvider,
        store,
        budget,
        concurrency: 1,
      });
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeats).toBeGreaterThanOrEqual(1);
      releaseGate();
      await expect(running).resolves.toMatchObject({ completed: 1 });
      expect(await inner.state()).toMatchObject({ reservedUsd: 0 });
    } finally {
      releaseGate();
      vi.useRealTimers();
    }
  });

  it("backs off instead of spinning while a predecessor's reservation holds the cap", async () => {
    const predecessorBudget = createBudget({
      store,
      projectId,
      runId,
      authorizedTotalUsd: 0.01,
    });
    const predecessor = await predecessorBudget.reserveExecution({
      contextTokens: 1,
      maxOutputTokens: 0,
      pricing: { input: 0.01, output: 0 },
    });
    const counting = countingStore(store, budgetKey(projectId, runId));
    const budget = createBudget({
      store: counting,
      projectId,
      runId,
      authorizedTotalUsd: 0.01,
    });
    const candidate: ModelCatalogEntry = {
      id: "vendor/candidate",
      family: "vendor",
      contextLength: 100,
      pricing: { input: 0.006, output: 0.004 },
      supportsTools: false,
      supportsStructuredOutput: false,
    };
    const immediateProvider: ProviderClient = {
      providerId: "immediate-provider",
      listModels: async () => [candidate],
      chat: async (request) => {
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
    const running = replayModeA({
      steps: [step()],
      cases: [recordedCase({ contextTokens: 1, maxOutputTokens: 1 })],
      candidates: [
        {
          stepId: "step-1",
          candidates: [candidate],
          droppedByTop: 0,
          droppedFreeModels: 0,
          droppedByOutputCeiling: 0,
        },
      ],
      provider: immediateProvider,
      store: counting,
      budget,
      concurrency: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const readsWhileBlocked = counting.reads();
    await predecessor.refund(0);
    await expect(running).resolves.toMatchObject({ completed: 1, blocked: [] });
    expect(readsWhileBlocked).toBeLessThanOrEqual(12);
  });

  it("settles in-flight workers and stops idle workers before rethrowing a worker failure", async () => {
    const candidate: ModelCatalogEntry = {
      id: "vendor/candidate",
      family: "vendor",
      contextLength: 100,
      pricing: { input: 0.006, output: 0.004 },
      supportsTools: false,
      supportsStructuredOutput: false,
    };
    let providerCalls = 0;
    const settlingProvider: ProviderClient = {
      providerId: "settling-provider",
      listModels: async () => [candidate],
      chat: async (request) => {
        providerCalls += 1;
        if (request.messages.at(-1)?.content === "boom") {
          throw new Error("store exploded");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
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
      authorizedTotalUsd: 1,
    });
    const cases = ["boom", "slow-1", "slow-2", "slow-3"].map((content, index) =>
      recordedCase({
        caseId: `case-${index + 1}`,
        trajectoryId: `trajectory-${index + 1}`,
        contextTokens: 1,
        maxOutputTokens: 1,
        messages: [{ role: "user", content }],
      }),
    );

    await expect(
      replayModeA({
        steps: [step()],
        cases,
        candidates: [
          {
            stepId: "step-1",
            candidates: [candidate],
            droppedByTop: 0,
            droppedFreeModels: 0,
            droppedByOutputCeiling: 0,
          },
        ],
        provider: settlingProvider,
        store,
        budget,
        concurrency: 2,
      }),
    ).rejects.toThrow("store exploded");
    const executions = (await readFacts(store)).filter(
      (fact) => "caseId" in fact && "terminalOutcome" in fact,
    );

    expect(providerCalls).toBe(2);
    expect(executions).toHaveLength(1);
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
          droppedByOutputCeiling: 0,
        },
      ],
      provider: delayedProvider,
      judge: {
        chat: judge(),
        rankedModels: [
          {
            judgeModel: "neutral/judge",
            supportsStructuredOutput: true,
            ...unpricedJudgeLimits,
          },
        ],
      },
      store,
      budget,
      concurrency: 2,
    });

    expect(result).toMatchObject({ completed: 2, blocked: [] });
    expect(await budget.state()).toMatchObject({
      spentUsd: 0.002004,
      reservedUsd: 0,
    });
  });

  const pricedJudge = {
    judgeModel: "neutral/judge",
    supportsStructuredOutput: true,
    pricing: { input: 0.00001, output: 0.00001 },
    maxOutputTokens: 512,
  };
  const ledgerState = () => createBudget({ store, projectId, runId }).state();

  it("holds judge spend inside the cap and blocks the judge cells the cap cannot cover", async () => {
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index}`,
        trajectoryId: `trajectory-${index}`,
      }),
    );

    const result = await run(
      cases,
      async (request) => ({ ...(await judge()(request)), costUsd: 0.003 }),
      2,
      pricedJudge.judgeModel,
      [pricedJudge],
      undefined,
      0.01,
    );
    const facts = await readFacts(store);

    expect((await ledgerState()).spentUsd).toBeLessThanOrEqual(0.01);
    expect(result.blocked.length).toBeGreaterThan(0);
    for (const blocked of result.blocked) {
      expect(blocked).toMatchObject({
        kind: "budget",
        message: expect.stringMatching(/raise it to at least/),
      });
    }
    expect(
      facts.filter((fact) => "caseId" in fact && "terminalOutcome" in fact),
    ).toHaveLength(4);
    expect(facts.filter((fact) => "assessmentId" in fact).length).toBeLessThan(
      4,
    );
    expect(
      facts.some(
        (fact) =>
          "actor" in fact &&
          typeof fact.reconcilableTo === "object" &&
          fact.reconcilableTo !== null &&
          !Array.isArray(fact.reconcilableTo) &&
          fact.reconcilableTo.judgeFailureKind !== undefined,
      ),
    ).toBe(false);
  });

  it("books the judge's actual cost when its reservation is refunded", async () => {
    await run(
      [recordedCase()],
      async (request) => ({ ...(await judge()(request)), costUsd: 0.0004 }),
      2,
      pricedJudge.judgeModel,
      [pricedJudge],
    );
    const candidateCostUsd = (await readFacts(store))
      .filter((fact) => "actor" in fact)
      .filter((event) => event.actor === "replay-driver")
      .reduce((total, event) => total + event.costUsd, 0);
    const state = await ledgerState();

    expect(candidateCostUsd).toBeGreaterThan(0);
    expect(state.spentUsd).toBeCloseTo(candidateCostUsd + 2 * 0.0004, 12);
    expect(state.reservedUsd).toBe(0);
  });

  it("waits for an in-flight judge reservation instead of refusing", async () => {
    const delegate = provider;
    provider = {
      providerId: delegate.providerId,
      listModels: () => delegate.listModels(),
      chat: async (request) => {
        const response = {
          content: "candidate output",
          usage: { inputTokens: 1, outputTokens: 1 },
          costUsd: 0.000001,
          costIsEstimate: true,
        };
        await request.onAttempt?.({ outcome: "completed", ...response });
        return response;
      },
    };
    const captured: JudgeChatRequest[] = [];
    await judgeExecution({
      chat: async (request) => {
        captured.push(request);
        return judge()(request);
      },
      judgeModel: pricedJudge.judgeModel,
      supportsStructuredOutput: true,
      task: recordedCase().task,
      reference: "Accepted summary",
      candidate: "candidate output",
    });
    const inputTokens = estimateInputTokens(captured[0]!.messages);
    const cap =
      (inputTokens * pricedJudge.pricing.input +
        pricedJudge.maxOutputTokens * pricedJudge.pricing.output) *
      1.5;
    const calls: { inputTokens: number; start: number; end: number }[] = [];

    const result = await run(
      [recordedCase()],
      async (request) => {
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 20));
        calls.push({
          inputTokens: estimateInputTokens(request.messages),
          start,
          end: performance.now(),
        });
        return judge()(request);
      },
      2,
      pricedJudge.judgeModel,
      [pricedJudge],
      undefined,
      cap,
    );
    const facts = await readFacts(store);

    expect(result.blocked).toEqual([]);
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(1);
    expect(calls.map((call) => call.inputTokens)).toEqual([
      inputTokens,
      inputTokens,
    ]);
    expect(calls[1]!.start).toBeGreaterThanOrEqual(calls[0]!.end);
  });

  it("never counts a budget refusal toward judge failover", async () => {
    const warning = vi.fn();
    const judgeModels: string[] = [];
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
        return judge()(request);
      },
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
          pricing: { input: 1, output: 1 },
          maxOutputTokens: 512,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
      ],
      warning,
      0.01,
    );

    expect(result.blocked.length).toBeGreaterThan(0);
    expect(result.blocked.every(({ kind }) => kind === "budget")).toBe(true);
    expect(warning).not.toHaveBeenCalledWith(
      "judge_unusable",
      expect.anything(),
    );
    expect(judgeModels).not.toContain("yotta/judge-2");
  });

  it("sends a judge nothing more after its first model substitution and cancels its calls waiting for budget", async () => {
    await restartStub({
      servedModels: { "zeta/judge-1": "zeta/judge-1-base" },
    });
    const warning = vi.fn();
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index}`,
        trajectoryId: `trajectory-${index}`,
      }),
    );
    let zetaReservations = 0;

    const result = await run(
      cases,
      providerJudge,
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
          pricing: { input: 0, output: 0.001 },
          maxOutputTokens: 512,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          pricing: { input: 0, output: 0.0009 },
          maxOutputTokens: 512,
        },
      ],
      warning,
      0.8,
      (budget) => ({
        ...budget,
        reserveExecution: async (reservation) => {
          const granted = await budget.reserveExecution(reservation);
          if (reservation.pricing.output === 0.001) zetaReservations += 1;
          return granted;
        },
      }),
    );
    const facts = await readFacts(store);
    const judgeNotes = facts.flatMap((fact) =>
      "actor" in fact &&
      fact.actor === "judge" &&
      typeof fact.reconcilableTo === "object" &&
      fact.reconcilableTo !== null &&
      !Array.isArray(fact.reconcilableTo)
        ? [{ costUsd: fact.costUsd, reconcilableTo: fact.reconcilableTo }]
        : [],
    );
    const zetaFailures = judgeNotes.filter(
      ({ reconcilableTo }) =>
        reconcilableTo.judgeModel === "zeta/judge-1" &&
        reconcilableTo.judgeFailureKind !== undefined,
    );
    const unusableNotes = judgeNotes.filter(
      ({ reconcilableTo }) => reconcilableTo.judgeStatus === "unusable",
    );
    const assessments = facts.filter((fact) => "assessmentId" in fact);
    const requestedModels = stub.getRequests().map(({ model }) => model);

    expect(
      requestedModels.filter((model) => model === "zeta/judge-1"),
    ).toHaveLength(1);
    expect(
      requestedModels.filter((model) => model === "yotta/judge-2"),
    ).toHaveLength(8);
    expect(zetaReservations).toBe(1);
    expect(zetaFailures.length).toBeLessThanOrEqual(1);
    expect(
      zetaFailures.every(
        ({ reconcilableTo }) =>
          reconcilableTo.judgeFailureKind === "provider_error",
      ),
    ).toBe(true);
    expect(result).toMatchObject({ completed: 4, blocked: [] });
    expect(assessments).toHaveLength(4);
    expect(
      assessments.every((fact) => fact.evaluatorId === "yotta/judge-2"),
    ).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "judge_unusable",
      "Judge zeta/judge-1 is unusable: it answered as another model (served zeta/judge-1-base for requested zeta/judge-1); switching to yotta/judge-2.",
    );
    expect(unusableNotes).toHaveLength(1);
    expect(unusableNotes[0]).toMatchObject({
      costUsd: 0,
      reconcilableTo: {
        judgeModel: "zeta/judge-1",
        judgeStatus: "unusable",
        note: "model_substituted",
        substitution: "served zeta/judge-1-base for requested zeta/judge-1",
      },
    });
    expect((await ledgerState()).reservedUsd).toBe(0);
  });

  it("never sends a judge call whose reservation is granted after its judge was retired", async () => {
    await restartStub({
      servedModels: { "zeta/judge-1": "zeta/judge-1-base" },
    });
    let releaseGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let judgeReservations = 0;
    let gatedGranted = false;

    await run(
      [recordedCase()],
      async (request) => {
        const response = await providerJudge(request);
        if (request.model === "zeta/judge-1") setTimeout(releaseGate, 20);
        return response;
      },
      2,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
      ],
      undefined,
      1,
      (budget) => ({
        ...budget,
        reserveExecution: async (reservation) => {
          const gated =
            reservation.maxOutputTokens ===
              unpricedJudgeLimits.maxOutputTokens && ++judgeReservations === 2;
          if (!gated) return budget.reserveExecution(reservation);
          await gate;
          const granted = await budget.reserveExecution(reservation);
          gatedGranted = true;
          return granted;
        },
      }),
    );
    const requestedModels = stub.getRequests().map(({ model }) => model);

    expect(gatedGranted).toBe(true);
    expect(
      requestedModels.filter((model) => model === "zeta/judge-1"),
    ).toHaveLength(1);
    expect(
      requestedModels.filter((model) => model === "yotta/judge-2"),
    ).toHaveLength(2);
    expect(
      (await readFacts(store))
        .filter((fact) => "assessmentId" in fact)
        .map((fact) => fact.evaluatorId),
    ).toEqual(["yotta/judge-2"]);
    expect((await ledgerState()).reservedUsd).toBe(0);
  });

  it("keeps a judge whose response came from a cache, which is not a model substitution", async () => {
    const warning = vi.fn();
    const judgeModels: string[] = [];
    let cacheHitSent = false;
    const cases = Array.from({ length: 4 }, (_, index) =>
      recordedCase({
        caseId: `case-${index}`,
        trajectoryId: `trajectory-${index}`,
      }),
    );

    await run(
      cases,
      async (request) => {
        judgeModels.push(request.model);
        const response = await judge()(request);
        if (cacheHitSent) return response;
        cacheHitSent = true;
        return {
          ...response,
          substitution: {
            kind: "cache",
            evidence: "x-portkey-cache-status: HIT",
          },
        };
      },
      4,
      "zeta/judge-1",
      [
        {
          judgeModel: "zeta/judge-1",
          supportsStructuredOutput: true,
          ...unpricedJudgeLimits,
        },
        {
          judgeModel: "yotta/judge-2",
          supportsStructuredOutput: false,
          ...unpricedJudgeLimits,
        },
      ],
      warning,
    );

    expect(warning).not.toHaveBeenCalled();
    expect(judgeModels).not.toContain("yotta/judge-2");
    expect(
      judgeModels.filter((model) => model === "zeta/judge-1"),
    ).toHaveLength(8);
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
          droppedByOutputCeiling: 0,
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

  it("re-judges an execution whose judge failed on a later run", async () => {
    const first = await run(
      [recordedCase()],
      async () => {
        throw new Error("judge offline");
      },
      1,
    );
    expect(first.completed).toBe(1);
    expect(
      (await readFacts(store)).some((fact) => "assessmentId" in fact),
    ).toBe(false);
    const hitsAfterFirstRun = stub.getHitCount();

    const second = await run([recordedCase()]);
    const assessments = (await readFacts(store)).filter(
      (fact) => "assessmentId" in fact,
    );

    expect(second).toMatchObject({ completed: 0, skipped: 1 });
    expect(stub.getHitCount()).toBe(hitsAfterFirstRun);
    expect(assessments).toHaveLength(1);
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

  it("records the judge route's provider on judge spend, judge failures, retirement notes and assessments", async () => {
    const equivalent = judge();
    let zetaCalls = 0;
    const chat: JudgeChat = async (request) => {
      if (request.model !== "zeta/judge-1") return equivalent(request);
      zetaCalls += 1;
      if (zetaCalls === 1) {
        throw new ProviderResponseError("Fixture judge rejection", {
          status: 400,
          bodyExcerpt: "fixture judge rejection",
        });
      }
      return judgeReply('{"verdict":');
    };

    await run(
      numberedCases(3),
      chat,
      1,
      "zeta/judge-1",
      rankedJudges,
      undefined,
      1,
      undefined,
      "judge-route",
    );
    const facts = await readFacts(store);
    const spend = facts.filter((fact) => "actor" in fact);
    const attempts = facts.filter((fact) => "attemptId" in fact);
    const assessments = facts.filter((fact) => "assessmentId" in fact);
    const reconciled = (
      fact: (typeof spend)[number],
    ): { readonly [key: string]: JsonValue | undefined } =>
      typeof fact.reconcilableTo === "object" &&
      fact.reconcilableTo !== null &&
      !Array.isArray(fact.reconcilableTo)
        ? fact.reconcilableTo
        : {};
    const attemptSpend = (attemptId: string) =>
      spend.filter(
        (fact) =>
          fact.actor === "replay-driver" &&
          reconciled(fact).attemptId === attemptId,
      );
    const rejected = attempts.find(
      (attempt) =>
        attempt.streamOutcome === "provider_error" &&
        attempt.errorDetail?.bodyExcerpt === "fixture judge rejection",
    );
    const completedAttempts = attempts.filter(
      (attempt) => attempt.streamOutcome === "completed",
    );
    if (rejected === undefined) {
      throw new Error("Expected the judge's rejected attempt");
    }

    expect(
      spend.filter((fact) => reconciled(fact).judgeFailureKind !== undefined),
    ).not.toHaveLength(0);
    expect(
      spend.filter((fact) => reconciled(fact).judgeStatus === "unusable"),
    ).toHaveLength(1);
    expect(
      new Set(
        spend
          .filter(({ actor }) => actor === "judge")
          .map(({ provider }) => provider),
      ),
    ).toEqual(new Set(["judge-route"]));
    expect(
      attemptSpend(rejected.attemptId).map(({ provider }) => provider),
    ).toEqual(["judge-route"]);
    expect(completedAttempts).toHaveLength(3);
    expect(
      new Set(
        completedAttempts
          .flatMap(({ attemptId }) => attemptSpend(attemptId))
          .map(({ provider }) => provider),
      ),
    ).toEqual(new Set(["stub-provider"]));
    expect(assessments).toHaveLength(3);
    for (const assessment of assessments) {
      expect(assessment).toMatchObject({
        artifactRef: { judgeProvider: "judge-route" },
      });
    }
  });

  it("keeps a stored judge retirement to the provider that recorded it", async () => {
    const equivalent = judge();
    const called: string[] = [];
    const chat: JudgeChat = async (request) => {
      called.push(request.model);
      return request.model === "zeta/judge-1"
        ? judgeReply('{"verdict":')
        : equivalent(request);
    };
    const runOn = (cases: RecordedCase[], judgeProviderId: string) =>
      run(
        cases,
        chat,
        1,
        "zeta/judge-1",
        rankedJudges,
        undefined,
        1,
        undefined,
        judgeProviderId,
      );

    await runOn(numberedCases(3), "route-a");
    called.length = 0;
    await runOn(numberedCases(1, 4), "route-b");

    expect(called).toContain("zeta/judge-1");

    called.length = 0;
    await runOn(numberedCases(1, 5), "route-a");

    expect(called).not.toContain("zeta/judge-1");
  });

  it("retires a rate-limited judge for the rest of its run and tries it again on the next run", async () => {
    const equivalent = judge();
    const called: string[] = [];
    const chat: JudgeChat = async (request) => {
      called.push(request.model);
      if (request.model === "zeta/judge-1") {
        throw new BlockedError({
          kind: "rate-limit",
          status: 429,
          observedCeiling: 1,
        });
      }
      return equivalent(request);
    };
    const runWith = (cases: RecordedCase[], wrapBudget?: () => Budget) =>
      run(
        cases,
        chat,
        1,
        "zeta/judge-1",
        rankedJudges,
        undefined,
        1,
        wrapBudget,
        "judge-route",
      );

    await runWith(numberedCases(4));
    const facts = await readFacts(store);
    const spend = facts.filter((fact) => "actor" in fact);
    const reconciled = (
      fact: (typeof spend)[number],
    ): { readonly [key: string]: JsonValue | undefined } =>
      typeof fact.reconcilableTo === "object" &&
      fact.reconcilableTo !== null &&
      !Array.isArray(fact.reconcilableTo)
        ? fact.reconcilableTo
        : {};
    const assessments = facts.filter((fact) => "assessmentId" in fact);
    const failures = spend.filter(
      (fact) => reconciled(fact).judgeFailureKind !== undefined,
    );
    const notes = spend.filter(
      (fact) => reconciled(fact).judgeStatus === "unusable",
    );

    expect(assessments).toHaveLength(4);
    expect(
      assessments.every(({ evaluatorId }) => evaluatorId === "yotta/judge-2"),
    ).toBe(true);
    expect(failures).not.toHaveLength(0);
    expect(
      failures.every(
        (fact) => reconciled(fact).judgeFailureKind === "provider_error",
      ),
    ).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      provider: "judge-route",
      reconcilableTo: {
        judgeModel: "zeta/judge-1",
        judgeStatus: "unusable",
        note: "rate_limited",
        runId: "run-1",
        consecutiveAssessments: 3,
      },
    });

    called.length = 0;
    await runWith(numberedCases(1, 5));

    expect(called).not.toContain("zeta/judge-1");

    called.length = 0;
    await runWith(numberedCases(1, 6), () =>
      createBudget({
        store,
        projectId,
        runId: "run-2",
        authorizedTotalUsd: 1,
      }),
    );

    expect(called[0]).toBe("zeta/judge-1");
  });

  it("stops the run at a plan usage limit from a candidate call, keeps the cells already written and replays only the rest next time", async () => {
    const delegate = provider;
    let calls = 0;
    let delegated = 0;
    let limited = true;
    provider = {
      providerId: delegate.providerId,
      listModels: () => delegate.listModels(),
      chat: async (request) => {
        calls += 1;
        if (limited && calls > 2) throw planUsageLimit();
        delegated += 1;
        return delegate.chat(request);
      },
    };

    await expect(run(numberedCases(5), judge(), 1)).rejects.toMatchObject({
      name: "BlockedError",
      kind: "usage-limit",
    });
    const executions = (await readFacts(store)).filter(
      (fact) => "executionId" in fact && "caseId" in fact,
    );

    expect(executions.map(({ caseId }) => caseId).sort()).toEqual([
      "case-1",
      "case-2",
    ]);

    limited = false;

    await expect(run(numberedCases(5), judge(), 1)).resolves.toMatchObject({
      completed: 3,
      skipped: 2,
      blocked: [],
    });
    expect(delegated).toBe(5);
  });

  it("stops the run at a plan usage limit from a judge call without counting a judge failure", async () => {
    await expect(
      run(
        numberedCases(3),
        async () => {
          throw planUsageLimit();
        },
        1,
        "zeta/judge-1",
        rankedJudges,
      ),
    ).rejects.toMatchObject({ kind: "usage-limit" });
    const facts = await readFacts(store);

    expect(
      facts.filter((fact) => "executionId" in fact && "caseId" in fact),
    ).not.toHaveLength(0);
    expect(facts.filter((fact) => "assessmentId" in fact)).toHaveLength(0);
    expect(
      facts.filter(
        (fact) =>
          "actor" in fact &&
          typeof fact.reconcilableTo === "object" &&
          fact.reconcilableTo !== null &&
          !Array.isArray(fact.reconcilableTo) &&
          (fact.reconcilableTo.judgeFailureKind !== undefined ||
            fact.reconcilableTo.judgeStatus !== undefined),
      ),
    ).toHaveLength(0);
  });

  it("reassesses the executions a judge usage limit left unassessed, with the same judge, on the next run", async () => {
    await expect(
      run(
        numberedCases(4),
        async () => {
          throw planUsageLimit();
        },
        1,
        "zeta/judge-1",
        rankedJudges,
      ),
    ).rejects.toMatchObject({ kind: "usage-limit" });

    await run(numberedCases(4), judge(), 1, "zeta/judge-1", rankedJudges);
    const facts = await readFacts(store);
    const executions = facts.filter(
      (fact) => "executionId" in fact && "caseId" in fact,
    );
    const assessments = facts.filter((fact) => "assessmentId" in fact);

    expect(executions).toHaveLength(4);
    for (const { executionId } of executions) {
      expect(
        assessments.filter(
          (assessment) => assessment.executionId === executionId,
        ),
      ).toHaveLength(1);
    }
    expect(
      assessments.every(({ evaluatorId }) => evaluatorId === "zeta/judge-1"),
    ).toBe(true);
    expect(stub.getHitCount()).toBe(4);
  });

  async function retirementNotes(): Promise<
    Record<string, JsonValue | undefined>
  > {
    const notes: Record<string, JsonValue | undefined> = {};
    for (const fact of await readFacts(store)) {
      if (
        "actor" in fact &&
        typeof fact.reconcilableTo === "object" &&
        fact.reconcilableTo !== null &&
        !Array.isArray(fact.reconcilableTo) &&
        fact.reconcilableTo.judgeStatus === "unusable"
      ) {
        notes[String(fact.reconcilableTo.judgeModel)] =
          fact.reconcilableTo.note;
      }
    }
    return notes;
  }

  it("records a lasting retirement when a success ended the judge's earlier rate-limited failures", async () => {
    const equivalent = judge();
    let releaseAfterFailure = (): void => undefined;
    const failureRecorded = new Promise<void>((resolve) => {
      releaseAfterFailure = resolve;
    });
    let releaseAfterAssessment = (): void => undefined;
    const assessmentRecorded = new Promise<void>((resolve) => {
      releaseAfterAssessment = resolve;
    });
    const putImmutable = store.putImmutable.bind(store);
    vi.spyOn(store, "putImmutable").mockImplementation(async (key, body) => {
      await putImmutable(key, body);
      const written = Buffer.from(body).toString("utf8");
      if (written.includes('"judgeFailureKind"')) releaseAfterFailure();
      if (written.includes('"assessmentId"')) releaseAfterAssessment();
    });
    const chat: JudgeChat = async (request) => {
      if (request.model !== "zeta/judge-1") return equivalent(request);
      const prompt = JSON.stringify(request.messages);
      if (prompt.includes("for case-1")) {
        throw new BlockedError({
          kind: "rate-limit",
          status: 429,
          observedCeiling: 1,
        });
      }
      await failureRecorded;
      if (prompt.includes("for case-2")) return equivalent(request);
      await assessmentRecorded;
      return judgeReply('{"verdict":');
    };

    await run(
      numberedCases(5).map((recorded) => ({
        ...recorded,
        referenceOutput: `Accepted summary for ${recorded.caseId}`,
      })),
      chat,
      1,
      "zeta/judge-1",
      rankedJudges,
    );

    expect(await retirementNotes()).toEqual({
      "zeta/judge-1": "three_consecutive_terminal_failures",
    });
  });

  it("records a lasting retirement for the next judge after a judge retired for rate limits", async () => {
    const chat: JudgeChat = async (request) => {
      if (request.model === "zeta/judge-1") {
        throw new BlockedError({
          kind: "rate-limit",
          status: 429,
          observedCeiling: 1,
        });
      }
      return judgeReply('{"verdict":');
    };

    await run(numberedCases(3), chat, 1, "zeta/judge-1", rankedJudges);

    expect(await retirementNotes()).toEqual({
      "zeta/judge-1": "rate_limited",
      "yotta/judge-2": "three_consecutive_terminal_failures",
    });
  });
});
