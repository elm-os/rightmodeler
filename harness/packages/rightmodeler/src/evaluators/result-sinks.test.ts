import {
  assessmentSchema,
  executionSchema,
  type JsonValue,
} from "@rightmodeler/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportResults,
  type ResultExportInput,
  type ResultSinkConfig,
} from "./result-sinks.js";

const braintrustStubUrl = new URL(
  "../../../../fixtures/eval-stub/server.mjs",
  import.meta.url,
).href;
const langfuseStubUrl = new URL(
  "../../../../fixtures/langfuse-eval-stub/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_RESULT_SINK_KEY";
const publicKeyEnv = "RIGHTMODELER_RESULT_SINK_PUBLIC_KEY";
const apiKey = "result-sink-key-canary-must-never-persist";
const publicKey = "result-sink-public-canary-must-never-persist";

interface Stub {
  readonly port: number;
  close(): Promise<void>;
}

const openStubs: Stub[] = [];

afterEach(async () => {
  delete process.env[apiKeyEnv];
  delete process.env[publicKeyEnv];
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
});

const execution = executionSchema.parse({
  executionId: "execution-1",
  evidenceQuestionId: "question-1",
  caseId: "case-1",
  stepId: "step-1",
  candidateId: "candidate-1",
  trajectoryId: "trajectory-1",
  corpusSplit: "holdout",
  selectionStage: "confirmation",
  terminalOutcome: "success",
  finalOutput: "Paris",
  attribution: "ok",
});
const assessment = assessmentSchema.parse({
  assessmentId: "assessment-1",
  executionId: execution.executionId,
  evaluatorId: "langfuse",
  metricName: "quality",
  score: 0.95,
  passed: true,
  rubricVersion: "quality-v1",
  artifactRef: { providerRunId: "source-run" },
});
const verdict: JsonValue = {
  familyId: "qa",
  decision: "recommend",
  worstCaseBound: 0.91,
};
const exportInput: ResultExportInput = {
  name: "rightmodeler-export",
  trials: [{ execution, assessments: [assessment] }],
  verdicts: [verdict],
};

describe("Braintrust result sink", () => {
  it("writes trials and verdicts as experiment events", async () => {
    const { config, stub } = await startBraintrust();

    const receipt = await exportResults(config, exportInput);

    expect(receipt).toEqual({
      provider: "braintrust",
      providerRunId: expect.any(String),
      exportedTrials: 1,
      exportedVerdicts: 1,
    });
    expect(stub.getExperimentEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: execution.executionId }),
        expect.objectContaining({
          output: expect.objectContaining({ familyId: "qa" }),
        }),
      ]),
    );
    expect(JSON.stringify(receipt)).not.toContain(apiKey);
  });

  it("redacts a reflected credential from sink errors", async () => {
    const { config } = await startBraintrust(true);

    const message = await exportError(config);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(apiKey);
  });
});

describe("Langfuse result sink", () => {
  it("writes a dataset run with trial and verdict scores", async () => {
    const { config, stub } = await startLangfuse();

    const receipt = await exportResults(config, exportInput);

    expect(receipt).toEqual({
      provider: "langfuse",
      providerRunId: expect.any(String),
      exportedTrials: 1,
      exportedVerdicts: 1,
    });
    expect(
      stub
        .getHits()
        .filter(({ path }) =>
          ["/api/public/otel/v1/traces", "/api/public/scores"].includes(path),
        ),
    ).toHaveLength(3);
    expect(stub.getCreatedScores()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          traceId: expect.any(String),
          name: "quality",
          value: 0.95,
        }),
        expect.objectContaining({
          datasetRunId: receipt.providerRunId,
          name: "rightmodeler.verdict.qa",
          value: 1,
        }),
      ]),
    );
    expect(JSON.stringify(receipt)).not.toContain(apiKey);
    expect(JSON.stringify(receipt)).not.toContain(publicKey);
  });

  it("redacts reflected credentials from sink errors", async () => {
    const { config } = await startLangfuse(true);

    const message = await exportError(config);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(publicKey);
    expect(message).not.toContain(
      Buffer.from(`${publicKey}:${apiKey}`, "utf8").toString("base64"),
    );
  });
});

async function startBraintrust(reflectAuthError = false): Promise<{
  config: ResultSinkConfig;
  stub: Stub & { getExperimentEvents(): readonly unknown[] };
}> {
  const module = (await import(braintrustStubUrl)) as {
    startEvalStub(options: {
      port: number;
      reflectAuthError: boolean;
    }): Promise<Stub & { getExperimentEvents(): readonly unknown[] }>;
  };
  const stub = await module.startEvalStub({ port: 0, reflectAuthError });
  openStubs.push(stub);
  process.env[apiKeyEnv] = apiKey;
  return {
    stub,
    config: {
      provider: "braintrust",
      baseUrl: `http://127.0.0.1:${stub.port}`,
      apiKeyEnv,
      projectId: "00000000-0000-4000-8000-000000000001",
    },
  };
}

async function startLangfuse(reflectAuthError = false): Promise<{
  config: ResultSinkConfig;
  stub: Stub & {
    getHits(): readonly { readonly path: string }[];
    getCreatedScores(): readonly unknown[];
  };
}> {
  const module = (await import(langfuseStubUrl)) as {
    startLangfuseEvalStub(options: {
      port: number;
      reflectAuthError: boolean;
    }): Promise<
      Stub & {
        getHits(): readonly { readonly path: string }[];
        getCreatedScores(): readonly unknown[];
      }
    >;
  };
  const stub = await module.startLangfuseEvalStub({
    port: 0,
    reflectAuthError,
  });
  openStubs.push(stub);
  process.env[apiKeyEnv] = apiKey;
  process.env[publicKeyEnv] = publicKey;
  return {
    stub,
    config: {
      provider: "langfuse",
      baseUrl: `http://127.0.0.1:${stub.port}`,
      apiKeyEnv,
      publicKeyEnv,
      datasetId: "langfuse-dataset-1",
    },
  };
}

async function exportError(config: ResultSinkConfig): Promise<string> {
  try {
    await exportResults(config, exportInput);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
