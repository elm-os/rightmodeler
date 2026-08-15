import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { pollEvaluator, preferEvaluatorWhenReachable } from "./braintrust.js";
import { createLangfuseEvaluator } from "./langfuse.js";
import { createLangsmithEvaluator } from "./langsmith.js";
import { createPromptfooEvaluator } from "./promptfoo.js";
import { resolveScoringConfig } from "./shared.js";
import { createBraintrustEvaluator } from "./braintrust.js";
import type { EvaluatorProvider } from "./types.js";

const braintrustStubUrl = new URL(
  "../../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const langfuseStubUrl = new URL(
  "../../../../fixtures/langfuse-eval-stub/server.mjs",
  import.meta.url,
).href;
const langsmithStubUrl = new URL(
  "../../../../fixtures/langsmith-eval-stub/server.mjs",
  import.meta.url,
).href;
const promptfooCommand = fileURLToPath(
  new URL("../../../../fixtures/promptfoo-stub/run.mjs", import.meta.url),
);
const promptfooAssertions = fileURLToPath(
  new URL(
    "../../../../fixtures/promptfoo-stub/assertions.yaml",
    import.meta.url,
  ),
);

const secretEnv = "RIGHTMODELER_EVALUATOR_CONFORMANCE_KEY";
const publicKeyEnv = "RIGHTMODELER_EVALUATOR_CONFORMANCE_PUBLIC_KEY";
const secret = "provider-key-canary-must-never-persist";
const publicKey = "provider-public-key-canary-must-never-persist";

interface Stub {
  readonly port: number;
  close(): Promise<void>;
}

const openStubs: Stub[] = [];

afterEach(async () => {
  delete process.env[secretEnv];
  delete process.env[publicKeyEnv];
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
});

const cases = [
  {
    caseId: "execution-1",
    input: { prompt: "capital" },
    expected: "Paris",
    output: "Paris",
  },
  {
    caseId: "execution-2",
    input: { prompt: "capital" },
    expected: "Paris",
    output: "Parish",
  },
] as const;

const providers: Array<{
  readonly name: string;
  create(): Promise<EvaluatorProvider>;
}> = [
  {
    name: "braintrust",
    async create() {
      const module = (await import(braintrustStubUrl)) as {
        startEvalStub(options: {
          port: number;
          pendingPolls: number;
        }): Promise<Stub>;
      };
      const stub = await module.startEvalStub({ port: 0, pendingPolls: 1 });
      openStubs.push(stub);
      process.env[secretEnv] = secret;
      return createBraintrustEvaluator({
        apiKeyEnv: secretEnv,
        baseUrl: `http://127.0.0.1:${stub.port}`,
        projectId: "00000000-0000-4000-8000-000000000001",
        scorers: ["output_similarity"],
      });
    },
  },
  {
    name: "langfuse",
    async create() {
      const module = (await import(langfuseStubUrl)) as {
        startLangfuseEvalStub(options: {
          port: number;
          pendingPolls: number;
        }): Promise<Stub>;
      };
      const stub = await module.startLangfuseEvalStub({
        port: 0,
        pendingPolls: 1,
      });
      openStubs.push(stub);
      process.env[secretEnv] = secret;
      process.env[publicKeyEnv] = publicKey;
      return createLangfuseEvaluator({
        apiKeyEnv: secretEnv,
        publicKeyEnv,
        baseUrl: `http://127.0.0.1:${stub.port}`,
        scorers: ["output_similarity"],
      });
    },
  },
  {
    name: "langsmith",
    async create() {
      const module = (await import(langsmithStubUrl)) as {
        startLangsmithEvalStub(options: {
          port: number;
          pendingPolls: number;
        }): Promise<Stub>;
      };
      const stub = await module.startLangsmithEvalStub({
        port: 0,
        pendingPolls: 1,
      });
      openStubs.push(stub);
      process.env[secretEnv] = secret;
      return createLangsmithEvaluator({
        apiKeyEnv: secretEnv,
        baseUrl: `http://127.0.0.1:${stub.port}`,
        datasetId: "langsmith-dataset-1",
        scorers: ["output_similarity"],
      });
    },
  },
  {
    name: "promptfoo",
    async create() {
      return createPromptfooEvaluator({
        command: promptfooCommand,
        assertionsPath: promptfooAssertions,
        scorers: ["output_similarity"],
      });
    },
  },
];

describe.each(providers)("$name evaluator conformance", ({ create }) => {
  it("prefers a reachable evaluator and preserves its lifecycle, metrics, and artifact", async () => {
    const provider = await create();
    const warnings: Array<{ code: string; message: string }> = [];

    const selected = await preferEvaluatorWhenReachable(
      provider,
      (code, message) => warnings.push({ code, message }),
    );
    expect(selected).toBe(provider);
    expect(warnings).toEqual([]);

    const { providerRunId } = await provider.launch({
      experimentName: "conformance",
      cases,
    });
    expect(await pollEvaluator(provider, providerRunId)).toBe("complete");
    const results = await provider.collect(providerRunId);

    expect(results.map(({ caseId }) => caseId).sort()).toEqual([
      "execution-1",
      "execution-2",
    ]);
    expect(results[0]?.metrics).toEqual([
      expect.objectContaining({
        metricName: "output_similarity",
        score: 1,
        passed: true,
        rubricVersion: expect.any(String),
      }),
    ]);
    expect(results[0]?.artifactRef).toEqual(expect.any(Object));
    expect(JSON.stringify({ providerRunId, results, warnings })).not.toContain(
      secret,
    );
    expect(JSON.stringify({ providerRunId, results, warnings })).not.toContain(
      publicKey,
    );
  });
});

describe("shared evaluator behavior", () => {
  it("keeps Braintrust gate metric and threshold semantics for every provider", () => {
    expect(
      resolveScoringConfig({
        scorers: ["quality"],
        gateThreshold: 0.9,
      }),
    ).toEqual({
      scorers: ["quality"],
      gateMetric: "quality",
      gateThreshold: 0.9,
    });
    expect(() =>
      resolveScoringConfig({ scorers: ["quality", "safety"] }),
    ).toThrow(/choose --evaluator-gate-metric from: quality, safety/i);
  });

  it("redacts reflected Langfuse credentials from errors", async () => {
    const module = (await import(langfuseStubUrl)) as {
      startLangfuseEvalStub(options: {
        port: number;
        reflectAuthError: boolean;
      }): Promise<Stub>;
    };
    const stub = await module.startLangfuseEvalStub({
      port: 0,
      reflectAuthError: true,
    });
    openStubs.push(stub);
    process.env[secretEnv] = secret;
    process.env[publicKeyEnv] = publicKey;
    const provider = createLangfuseEvaluator({
      apiKeyEnv: secretEnv,
      publicKeyEnv,
      baseUrl: `http://127.0.0.1:${stub.port}`,
      scorers: ["output_similarity"],
    });

    const message = await launchError(provider);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(publicKey);
    expect(message).not.toContain(
      Buffer.from(`${publicKey}:${secret}`, "utf8").toString("base64"),
    );
  });

  it("redacts a reflected LangSmith credential from errors", async () => {
    const module = (await import(langsmithStubUrl)) as {
      startLangsmithEvalStub(options: {
        port: number;
        reflectAuthError: boolean;
      }): Promise<Stub>;
    };
    const stub = await module.startLangsmithEvalStub({
      port: 0,
      reflectAuthError: true,
    });
    openStubs.push(stub);
    process.env[secretEnv] = secret;
    const provider = createLangsmithEvaluator({
      apiKeyEnv: secretEnv,
      baseUrl: `http://127.0.0.1:${stub.port}`,
      datasetId: "langsmith-dataset-1",
      scorers: ["output_similarity"],
    });

    const message = await launchError(provider);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(secret);
  });

  it("fails loudly on malformed successful provider responses", async () => {
    const langfuseModule = (await import(langfuseStubUrl)) as {
      startLangfuseEvalStub(options: {
        port: number;
        malformedScores: boolean;
      }): Promise<Stub>;
    };
    const langsmithModule = (await import(langsmithStubUrl)) as {
      startLangsmithEvalStub(options: {
        port: number;
        malformedRuns: boolean;
      }): Promise<Stub>;
    };
    const langfuseStub = await langfuseModule.startLangfuseEvalStub({
      port: 0,
      malformedScores: true,
    });
    const langsmithStub = await langsmithModule.startLangsmithEvalStub({
      port: 0,
      malformedRuns: true,
    });
    openStubs.push(langfuseStub, langsmithStub);
    process.env[secretEnv] = secret;
    process.env[publicKeyEnv] = publicKey;
    const langfuse = createLangfuseEvaluator({
      apiKeyEnv: secretEnv,
      publicKeyEnv,
      baseUrl: `http://127.0.0.1:${langfuseStub.port}`,
      scorers: ["output_similarity"],
    });
    const langsmith = createLangsmithEvaluator({
      apiKeyEnv: secretEnv,
      baseUrl: `http://127.0.0.1:${langsmithStub.port}`,
      datasetId: "langsmith-dataset-1",
      scorers: ["output_similarity"],
    });

    const langfuseRun = await langfuse.launch({
      experimentName: "malformed",
      cases: cases.slice(0, 1),
    });
    const langsmithRun = await langsmith.launch({
      experimentName: "malformed",
      cases: cases.slice(0, 1),
    });

    await expect(langfuse.status(langfuseRun.providerRunId)).rejects.toThrow(
      /data/i,
    );
    await expect(langsmith.status(langsmithRun.providerRunId)).rejects.toThrow(
      /runs/i,
    );
  });
});

async function launchError(provider: EvaluatorProvider): Promise<string> {
  try {
    await provider.launch({
      experimentName: "reflected-key",
      cases: cases.slice(0, 1),
    });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
