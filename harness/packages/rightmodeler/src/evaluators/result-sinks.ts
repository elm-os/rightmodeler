import {
  computeRunSpecDigest,
  type Assessment,
  type Execution,
  type JsonValue,
} from "@rightmodeler/core";
import { z } from "zod";

import {
  langfuseExperimentPayload,
  stableLangfuseIdentity,
} from "./langfuse.js";
import {
  apiRoot,
  environmentSecret,
  requireText,
  responseJson,
} from "./shared.js";

export type ResultSinkProvider = "braintrust" | "langfuse";

export type ResultSinkConfig =
  | {
      readonly provider: "braintrust";
      readonly baseUrl: string;
      readonly apiKeyEnv: string;
      readonly projectId: string;
    }
  | {
      readonly provider: "langfuse";
      readonly baseUrl: string;
      readonly apiKeyEnv: string;
      readonly publicKeyEnv: string;
      readonly datasetId: string;
    };

export interface ResultExportTrial {
  readonly execution: Execution;
  readonly assessments: readonly Assessment[];
}

export interface ResultExportInput {
  readonly name: string;
  readonly trials: readonly ResultExportTrial[];
  readonly verdicts: readonly JsonValue[];
}

export interface ResultExportReceipt {
  readonly provider: ResultSinkProvider;
  readonly providerRunId: string;
  readonly exportedTrials: number;
  readonly exportedVerdicts: number;
}

export const resultExportReceiptSchema = z.object({
  provider: z.enum(["braintrust", "langfuse"]),
  providerRunId: z.string().min(1),
  exportedTrials: z.number().int().nonnegative(),
  exportedVerdicts: z.number().int().nonnegative(),
});

const experimentSchema = z.object({ id: z.string().min(1) });
const insertSchema = z.object({ row_ids: z.array(z.string()) });
const otelResponseSchema = z.object({ partialSuccess: z.unknown().optional() });
const scoreResponseSchema = z.object({ id: z.string().min(1) });

export async function exportResults(
  config: ResultSinkConfig,
  input: ResultExportInput,
): Promise<ResultExportReceipt> {
  requireText(input.name, "Result export name");
  requireText(config.baseUrl, "Result sink baseUrl");
  requireText(config.apiKeyEnv, "Result sink apiKeyEnv");
  return config.provider === "braintrust"
    ? exportToBraintrust(config, input)
    : exportToLangfuse(config, input);
}

async function exportToBraintrust(
  config: Extract<ResultSinkConfig, { readonly provider: "braintrust" }>,
  input: ResultExportInput,
): Promise<ResultExportReceipt> {
  requireText(config.projectId, "Braintrust result sink projectId");
  const apiKey = environmentSecret(config.apiKeyEnv, "Result sink API key");
  const request = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(braintrustUrl(config.baseUrl, path), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return responseJson(response, "Braintrust result sink", [apiKey]);
  };
  const experiment = experimentSchema.parse(
    await request("experiment", {
      project_id: config.projectId,
      name: input.name,
    }),
  );
  const events = [
    ...input.trials.map(({ execution, assessments }) => ({
      id: execution.executionId,
      input: trialInput(execution),
      output: execution.finalOutput,
      scores: Object.fromEntries(
        assessments.map(({ metricName, score }) => [metricName, score]),
      ),
      metadata: {
        kind: "rightmodeler_trial",
        assessments: assessments.map(assessmentMetadata),
      },
    })),
    ...input.verdicts.map((verdict) => ({
      id: `verdict-${computeRunSpecDigest(verdict)}`,
      input: { familyId: verdictFamily(verdict) },
      output: verdict,
      metadata: { kind: "rightmodeler_verdict" },
    })),
  ];
  const inserted = insertSchema.parse(
    await request(`experiment/${experiment.id}/insert`, { events }),
  );
  if (inserted.row_ids.length !== events.length) {
    throw new Error(
      `Braintrust result sink inserted ${inserted.row_ids.length} of ${events.length} events`,
    );
  }
  return receipt(config.provider, experiment.id, input);
}

async function exportToLangfuse(
  config: Extract<ResultSinkConfig, { readonly provider: "langfuse" }>,
  input: ResultExportInput,
): Promise<ResultExportReceipt> {
  requireText(config.publicKeyEnv, "Langfuse result sink publicKeyEnv");
  requireText(config.datasetId, "Langfuse result sink datasetId");
  const publicKey = environmentSecret(
    config.publicKeyEnv,
    "Result sink public key",
  );
  const apiKey = environmentSecret(config.apiKeyEnv, "Result sink API key");
  const encoded = Buffer.from(`${publicKey}:${apiKey}`, "utf8").toString(
    "base64",
  );
  const secrets = [publicKey, apiKey, encoded, `Basic ${encoded}`];
  const request = async (path: string, body: unknown): Promise<unknown> => {
    const response = await fetch(apiRoot(config.baseUrl, path), {
      method: "POST",
      headers: {
        authorization: `Basic ${encoded}`,
        "content-type": "application/json",
        ...(path.includes("otel")
          ? { "x-langfuse-ingestion-version": "4" }
          : {}),
      },
      body: JSON.stringify(body),
    });
    return responseJson(response, "Langfuse result sink", secrets);
  };
  const providerRunId = computeRunSpecDigest({
    name: input.name,
    datasetId: config.datasetId,
    trialIds: input.trials.map(({ execution }) => execution.executionId),
    verdicts: [...input.verdicts],
  });
  const cases = input.trials.map(({ execution }) => ({
    caseId: execution.executionId,
    input: trialInput(execution),
    expected: null,
    output: execution.finalOutput,
  }));
  const identities = new Map(
    cases.map(({ caseId }) => [
      caseId,
      stableLangfuseIdentity({ providerRunId, caseId }),
    ]),
  );
  otelResponseSchema.parse(
    await request(
      "/api/public/otel/v1/traces",
      langfuseExperimentPayload({
        providerRunId,
        experimentName: input.name,
        datasetId: config.datasetId,
        cases,
        identities,
      }),
    ),
  );
  for (const { execution, assessments } of input.trials) {
    const identity = identities.get(execution.executionId)!;
    for (const assessment of assessments) {
      scoreResponseSchema.parse(
        await request("/api/public/scores", {
          id: computeRunSpecDigest({
            providerRunId,
            assessmentId: assessment.assessmentId,
          }),
          traceId: identity.traceId,
          observationId: identity.observationId,
          name: assessment.metricName,
          value: assessment.score,
          dataType: "NUMERIC",
          metadata: assessmentMetadata(assessment),
        }),
      );
    }
  }
  for (const verdict of input.verdicts) {
    const familyId = verdictFamily(verdict);
    scoreResponseSchema.parse(
      await request("/api/public/scores", {
        id: computeRunSpecDigest({ providerRunId, familyId, verdict }),
        datasetRunId: providerRunId,
        name: `rightmodeler.verdict.${familyId}`,
        value: verdictRecommended(verdict) ? 1 : 0,
        dataType: "BOOLEAN",
        metadata: { verdict },
      }),
    );
  }
  return receipt(config.provider, providerRunId, input);
}

function receipt(
  provider: ResultSinkProvider,
  providerRunId: string,
  input: ResultExportInput,
): ResultExportReceipt {
  return {
    provider,
    providerRunId,
    exportedTrials: input.trials.length,
    exportedVerdicts: input.verdicts.length,
  };
}

function trialInput(execution: Execution): JsonValue {
  return {
    executionId: execution.executionId,
    evidenceQuestionId: execution.evidenceQuestionId,
    caseId: execution.caseId,
    stepId: execution.stepId,
    candidateId: execution.candidateId,
    trajectoryId: execution.trajectoryId,
    corpusSplit: execution.corpusSplit,
    selectionStage: execution.selectionStage,
  };
}

function assessmentMetadata(assessment: Assessment): JsonValue {
  return {
    assessmentId: assessment.assessmentId,
    evaluatorId: assessment.evaluatorId,
    passed: assessment.passed,
    rubricVersion: assessment.rubricVersion,
    artifactRef: assessment.artifactRef,
  };
}

function verdictFamily(verdict: JsonValue): string {
  return typeof verdict === "object" &&
    verdict !== null &&
    !Array.isArray(verdict) &&
    typeof verdict.familyId === "string"
    ? verdict.familyId
    : computeRunSpecDigest(verdict).slice(0, 12);
}

function verdictRecommended(verdict: JsonValue): boolean {
  return (
    typeof verdict === "object" &&
    verdict !== null &&
    !Array.isArray(verdict) &&
    verdict.decision === "recommend"
  );
}

function braintrustUrl(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  const versioned = root.endsWith("/v1") ? root : `${root}/v1`;
  return `${versioned}/${path}`;
}
