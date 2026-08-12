import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assessmentSchema,
  attributionSchema,
  executionSchema,
  requestAttemptSchema,
  spendEventSchema,
  streamOutcomeSchema,
  terminalOutcomeSchema,
} from "./facts.js";

const execution = {
  executionId: "execution-1",
  evidenceQuestionId: "question-1",
  caseId: "case-1",
  stepId: "step-1",
  candidateId: "candidate-1",
  trajectoryId: "trajectory-1",
  corpusSplit: "validation",
  selectionStage: "replay",
  terminalOutcome: "success",
  finalOutput: { answer: "done", citations: [1, 2] },
  attribution: "ok",
};

const requestAttempt = {
  attemptId: "attempt-1",
  logicalCallId: "call-1",
  executionId: "execution-1",
  streamOutcome: "completed",
  usage: { inputTokens: 100, outputTokens: 25 },
  costUsd: 0.0025,
  costIsEstimate: false,
};

const assessment = {
  assessmentId: "assessment-1",
  executionId: "execution-1",
  evaluatorId: "evaluator-1",
  metricName: "correctness",
  score: 0.95,
  passed: true,
  rubricVersion: "rubric-2",
  artifactRef: {
    providerRunId: "provider-run-1",
    path: "artifacts/result.json",
  },
};

const spendEvent = {
  actor: "judge",
  phase: "revalidate",
  costUsd: 0.04,
  provider: "provider-1",
  reconcilableTo: { executionId: "execution-1" },
};

const fixtures: ReadonlyArray<{
  name: string;
  schema: z.ZodType;
  value: Record<string, unknown>;
}> = [
  { name: "Execution", schema: executionSchema, value: execution },
  {
    name: "RequestAttempt",
    schema: requestAttemptSchema,
    value: requestAttempt,
  },
  { name: "Assessment", schema: assessmentSchema, value: assessment },
  { name: "SpendEvent", schema: spendEventSchema, value: spendEvent },
];

describe("fact schemas", () => {
  it.each(fixtures)(
    "round-trips a valid $name fixture",
    ({ schema, value }) => {
      const roundTripped = JSON.parse(JSON.stringify(value));
      expect(schema.parse(roundTripped)).toEqual(value);
    },
  );

  it.each(fixtures)(
    "rejects every missing $name field",
    ({ schema, value }) => {
      for (const key of Object.keys(value)) {
        const incomplete = { ...value };
        delete incomplete[key];
        expect(schema.safeParse(incomplete).success, `missing ${key}`).toBe(
          false,
        );
      }
    },
  );

  it.each(fixtures)("rejects extra $name fields", ({ schema, value }) => {
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(
      false,
    );
  });

  it.each(fixtures)(
    "parses $name as an immutable value object",
    ({ schema, value }) => {
      expect(Object.isFrozen(schema.parse(value))).toBe(true);
    },
  );

  it("defines the ledger outcome enums", () => {
    expect(terminalOutcomeSchema.options).toEqual([
      "success",
      "failure",
      "abstain",
    ]);
    expect(streamOutcomeSchema.options).toEqual([
      "completed",
      "provider_error",
      "client_cancelled",
      "truncated",
    ]);
    expect(attributionSchema.options).toEqual([
      "ok",
      "ambiguous",
      "lost",
      "silent-failure",
    ]);
  });

  it("rejects negative costs", () => {
    expect(
      requestAttemptSchema.safeParse({ ...requestAttempt, costUsd: -0.01 })
        .success,
    ).toBe(false);
    expect(
      spendEventSchema.safeParse({ ...spendEvent, costUsd: -0.01 }).success,
    ).toBe(false);
  });
});
