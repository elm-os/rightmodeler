import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assessmentSchema,
  attributionSchema,
  cascadeFindingSchema,
  cascadeFindingVerdictSchema,
  executionSchema,
  factSchema,
  lifecycleEventKindSchema,
  lifecycleEventSchema,
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

const cascadeFinding = {
  cascadeId: "cascade-1",
  familyId: "family-1",
  evidenceQuestionId: "question-1",
  swapSetKey: "classify+lookup",
  verdict: "isolated",
  culprits: [["classify", "lookup"]],
  cascadeSeedStepId: "classify",
  uncertainStepIds: ["lookup"],
  runSetsUsed: 4,
  createdAt: "2026-08-13T12:00:00.000Z",
};

const lifecycleEvent = {
  eventId: "event-1",
  prNumber: null,
  repo: "elm-os/rightmodeler",
  familyIds: ["summarize", "extract"],
  kind: "apply_started",
  evidence: {
    revision: "4c67904ae514c592333d8ccdbbee6c0af6eef8131",
    corpusVersionId: "corpus-3",
    gatePolicyVersion: "gate-2",
  },
  runSpecDigest:
    "4c67904ae514c592333d8ccdbbee6c0af6eef8131d6bde32aba72eb4f31ef6d6",
  createdAt: "2026-08-13T12:00:00.000Z",
  detail: { branch: "rightmodeler/swap-summarize-4c67904a" },
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
  {
    name: "CascadeFinding",
    schema: cascadeFindingSchema,
    value: cascadeFinding,
  },
  {
    name: "LifecycleEvent",
    schema: lifecycleEventSchema,
    value: lifecycleEvent,
  },
];

describe("fact schemas", () => {
  it.each(fixtures)(
    "round-trips a valid $name fixture",
    ({ schema, value }) => {
      const roundTripped = JSON.parse(JSON.stringify(value));
      expect(schema.parse(roundTripped)).toEqual(value);
      expect(factSchema.parse(roundTripped)).toEqual(value);
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
    expect(cascadeFindingVerdictSchema.options).toEqual([
      "confirmed",
      "isolated",
      "inconclusive",
    ]);
    expect(lifecycleEventKindSchema.options).toEqual([
      "apply_started",
      "pr_opened",
      "review_requested",
      "comment_posted",
      "reproof_started",
      "pr_closed_rejected",
      "pr_merged",
      "watch_ended",
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

  it("accepts bounded provider error detail without requiring it on historical attempts", () => {
    expect(requestAttemptSchema.parse(requestAttempt)).toEqual(requestAttempt);
    expect(
      requestAttemptSchema.parse({
        ...requestAttempt,
        streamOutcome: "provider_error",
        errorDetail: {
          status: 400,
          bodyExcerpt: "Invalid messages[0].parts",
        },
      }),
    ).toMatchObject({
      errorDetail: {
        status: 400,
        bodyExcerpt: "Invalid messages[0].parts",
      },
    });
  });

  it("rejects provider error excerpts over 500 characters", () => {
    expect(
      requestAttemptSchema.safeParse({
        ...requestAttempt,
        streamOutcome: "provider_error",
        errorDetail: { status: 400, bodyExcerpt: "x".repeat(501) },
      }).success,
    ).toBe(false);
  });

  it("accepts a null provider status for transport errors", () => {
    expect(
      requestAttemptSchema.parse({
        ...requestAttempt,
        streamOutcome: "provider_error",
        errorDetail: { status: null, bodyExcerpt: "fetch failed" },
      }),
    ).toMatchObject({
      errorDetail: { status: null, bodyExcerpt: "fetch failed" },
    });
  });

  it("rejects invalid cascade counts and timestamps", () => {
    expect(
      cascadeFindingSchema.safeParse({ ...cascadeFinding, runSetsUsed: -1 })
        .success,
    ).toBe(false);
    expect(
      cascadeFindingSchema.safeParse({ ...cascadeFinding, runSetsUsed: 1.5 })
        .success,
    ).toBe(false);
    expect(
      cascadeFindingSchema.safeParse({
        ...cascadeFinding,
        createdAt: "not-a-timestamp",
      }).success,
    ).toBe(false);
  });

  it("accepts a positive pull request number after the pull request opens", () => {
    expect(
      lifecycleEventSchema.parse({
        ...lifecycleEvent,
        kind: "pr_opened",
        prNumber: 42,
      }),
    ).toEqual({ ...lifecycleEvent, kind: "pr_opened", prNumber: 42 });
  });

  it("rejects invalid lifecycle identities, pull numbers, evidence, and timestamps", () => {
    const invalidEvents = [
      { ...lifecycleEvent, eventId: "" },
      { ...lifecycleEvent, prNumber: 0 },
      { ...lifecycleEvent, prNumber: -1 },
      { ...lifecycleEvent, prNumber: 1.5 },
      { ...lifecycleEvent, repo: "" },
      { ...lifecycleEvent, familyIds: [""] },
      { ...lifecycleEvent, kind: "opened" },
      {
        ...lifecycleEvent,
        evidence: { ...lifecycleEvent.evidence, revision: "" },
      },
      {
        ...lifecycleEvent,
        evidence: { ...lifecycleEvent.evidence, corpusVersionId: "" },
      },
      {
        ...lifecycleEvent,
        evidence: { ...lifecycleEvent.evidence, gatePolicyVersion: "" },
      },
      { ...lifecycleEvent, runSpecDigest: "" },
      { ...lifecycleEvent, createdAt: "not-a-timestamp" },
    ];

    for (const event of invalidEvents) {
      expect(lifecycleEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("rejects extra lifecycle evidence fields", () => {
    expect(
      lifecycleEventSchema.safeParse({
        ...lifecycleEvent,
        evidence: { ...lifecycleEvent.evidence, unexpected: true },
      }).success,
    ).toBe(false);
  });
});
