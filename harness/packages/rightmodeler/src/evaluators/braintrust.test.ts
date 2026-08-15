import { afterEach, describe, expect, it } from "vitest";

import { Reporter } from "../protocol.js";
import {
  createBraintrustEvaluator,
  pollEvaluator,
  preferEvaluatorWhenReachable,
  resolveBraintrustEvaluatorConfig,
} from "./braintrust.js";

const stubModuleUrl = new URL(
  "../../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_EVALUATOR_TEST_KEY";
const secret = "evaluator-key-canary-must-never-persist";

interface StubServer {
  readonly port: number;
  getHitCount(method: string, path: string): number;
  close(): Promise<void>;
}

interface StubModule {
  startEvalStub(options: {
    port: number;
    pendingPolls?: number;
    fail?: boolean;
    omitCaseId?: string;
    reflectAuthError?: boolean;
    malformedFetch?: boolean;
    platformPassDecisions?: boolean;
  }): Promise<StubServer>;
}

const openStubs: StubServer[] = [];

afterEach(async () => {
  delete process.env[apiKeyEnv];
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
});

async function startStub(
  options: Omit<Parameters<StubModule["startEvalStub"]>[0], "port"> = {},
): Promise<StubServer> {
  const module = (await import(stubModuleUrl)) as StubModule;
  const stub = await module.startEvalStub({ port: 0, ...options });
  openStubs.push(stub);
  return stub;
}

function evaluator(stub: StubServer, overrides = {}) {
  return createBraintrustEvaluator({
    apiKeyEnv,
    baseUrl: `http://127.0.0.1:${stub.port}`,
    projectId: "00000000-0000-4000-8000-000000000001",
    scorers: ["output_similarity"],
    ...overrides,
  });
}

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

describe("Braintrust evaluator adapter", () => {
  it("detects availability, launches configured scorers, and collects asynchronous metrics", async () => {
    process.env[apiKeyEnv] = secret;
    const stub = await startStub({ pendingPolls: 2 });
    const provider = evaluator(stub, {
      scorers: ["output_similarity", "secondary_similarity"],
      gateMetric: "output_similarity",
    });

    expect(await provider.detectAvailability()).toBe(true);
    const { providerRunId } = await provider.launch({
      experimentName: "adapter-test",
      cases,
    });
    expect(await pollEvaluator(provider, providerRunId)).toBe("complete");
    const results = await provider.collect(providerRunId);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      caseId: "execution-1",
      metrics: [
        {
          metricName: "output_similarity",
          score: 1,
          passed: true,
          rubricVersion: "stub-similarity-v1",
        },
        {
          metricName: "secondary_similarity",
          score: 1,
          passed: true,
          rubricVersion: "stub-similarity-v1",
        },
      ],
      artifactRef: { providerRunId, eventId: "execution-1" },
    });
    expect(
      results[1]?.metrics.find(
        ({ metricName }) => metricName === "output_similarity",
      )?.score,
    ).toBeLessThan(1);
    expect(stub.getHitCount("POST", "/v1/experiment")).toBe(1);
    expect(
      stub.getHitCount("POST", `/v1/experiment/${providerRunId}/insert`),
    ).toBe(1);
    expect(
      stub.getHitCount("GET", `/v1/experiment/${providerRunId}/fetch`),
    ).toBe(3);
  });

  it("defaults the gate metric only when exactly one scorer is configured", () => {
    expect(
      resolveBraintrustEvaluatorConfig({
        apiKeyEnv,
        baseUrl: "https://api.example.test",
        projectId: "project-1",
        scorers: ["quality"],
      }).gateMetric,
    ).toBe("quality");

    expect(() =>
      resolveBraintrustEvaluatorConfig({
        apiKeyEnv,
        baseUrl: "https://api.example.test",
        projectId: "project-1",
        scorers: ["quality", "safety"],
      }),
    ).toThrow(/choose --evaluator-gate-metric from: quality, safety/i);
  });

  it("preserves a missing platform pass decision as null", async () => {
    process.env[apiKeyEnv] = secret;
    const stub = await startStub({
      pendingPolls: 0,
      platformPassDecisions: false,
    });
    const provider = evaluator(stub);
    const { providerRunId } = await provider.launch({
      experimentName: "no-pass-decision",
      cases: cases.slice(0, 1),
    });

    expect(await provider.status(providerRunId)).toBe("complete");
    expect(
      (await provider.collect(providerRunId))[0]?.metrics[0],
    ).toMatchObject({ passed: null });
  });

  it("returns a failed lifecycle without inventing scores", async () => {
    process.env[apiKeyEnv] = secret;
    const stub = await startStub({ fail: true });
    const provider = evaluator(stub);
    const { providerRunId } = await provider.launch({
      experimentName: "failed",
      cases,
    });

    expect(await pollEvaluator(provider, providerRunId)).toBe("failed");
    expect(await provider.collect(providerRunId)).toEqual([]);
  });

  it("bounds polling when an expected event never arrives", async () => {
    process.env[apiKeyEnv] = secret;
    const stub = await startStub({
      pendingPolls: 0,
      omitCaseId: "execution-2",
    });
    const provider = evaluator(stub);
    const { providerRunId } = await provider.launch({
      experimentName: "missing-event",
      cases,
    });

    expect(await pollEvaluator(provider, providerRunId)).toBe(
      "polling_exhausted",
    );
    expect(
      stub.getHitCount("GET", `/v1/experiment/${providerRunId}/fetch`),
    ).toBe(6);
    expect(await provider.collect(providerRunId)).toHaveLength(1);
  });

  it("fails loudly on a malformed successful fetch response", async () => {
    process.env[apiKeyEnv] = secret;
    const stub = await startStub({ malformedFetch: true });
    const provider = evaluator(stub);
    const { providerRunId } = await provider.launch({
      experimentName: "malformed",
      cases: cases.slice(0, 1),
    });

    await expect(provider.status(providerRunId)).rejects.toThrow(/events/i);
  });

  it("redacts a reflected environment-sourced key from request errors", async () => {
    process.env[apiKeyEnv] = secret;
    const stub = await startStub({ reflectAuthError: true });
    const provider = evaluator(stub);

    let message = "";
    try {
      await provider.launch({
        experimentName: "reflected-key",
        cases: cases.slice(0, 1),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(secret);
  });

  it("warns and declines the external evaluator only when availability fails", async () => {
    const warnings: Array<{ code: string; message: string }> = [];
    const selected = await preferEvaluatorWhenReachable(
      {
        id: "unreachable",
        detectAvailability: async () => false,
        launch: async () => ({ providerRunId: "unused" }),
        status: async () => "pending",
        collect: async () => [],
      },
      (code, message) => warnings.push({ code, message }),
    );

    expect(selected).toBeUndefined();
    expect(warnings).toEqual([
      {
        code: "external_evaluator_unreachable",
        message:
          "The configured external evaluator is unreachable; falling back to the built-in judge.",
      },
    ]);
  });

  it("renders evaluator fallback as an explicit human warning", () => {
    let stderr = "";
    const reporter = new Reporter("human", {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    reporter.warning(
      "external_evaluator_unreachable",
      "Falling back to the built-in judge.",
    );

    expect(stderr).toBe("WARNING: Falling back to the built-in judge.\n");
  });
});
