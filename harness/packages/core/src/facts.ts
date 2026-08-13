import { z } from "zod";

const requiredStringSchema = z.string().min(1);

export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

export const terminalOutcomeSchema = z.enum(["success", "failure", "abstain"]);
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>;

export const streamOutcomeSchema = z.enum([
  "completed",
  "provider_error",
  "client_cancelled",
  "truncated",
]);
export type StreamOutcome = z.infer<typeof streamOutcomeSchema>;

export const attributionSchema = z.enum([
  "ok",
  "ambiguous",
  "lost",
  "silent-failure",
]);
export type Attribution = z.infer<typeof attributionSchema>;

export const executionSchema = z
  .strictObject({
    executionId: requiredStringSchema,
    evidenceQuestionId: requiredStringSchema,
    caseId: requiredStringSchema,
    stepId: requiredStringSchema,
    candidateId: requiredStringSchema,
    trajectoryId: requiredStringSchema,
    corpusSplit: requiredStringSchema,
    selectionStage: requiredStringSchema,
    terminalOutcome: terminalOutcomeSchema,
    finalOutput: jsonValueSchema,
    attribution: attributionSchema,
  })
  .readonly();
export type Execution = z.infer<typeof executionSchema>;

export const requestAttemptSchema = z
  .strictObject({
    attemptId: requiredStringSchema,
    logicalCallId: requiredStringSchema,
    executionId: requiredStringSchema,
    streamOutcome: streamOutcomeSchema,
    usage: jsonValueSchema,
    costUsd: z.number().nonnegative(),
    costIsEstimate: z.boolean(),
  })
  .readonly();
export type RequestAttempt = z.infer<typeof requestAttemptSchema>;

export const assessmentSchema = z
  .strictObject({
    assessmentId: requiredStringSchema,
    executionId: requiredStringSchema,
    evaluatorId: requiredStringSchema,
    metricName: requiredStringSchema,
    score: z.number(),
    passed: z.boolean(),
    rubricVersion: requiredStringSchema,
    artifactRef: jsonValueSchema,
  })
  .readonly();
export type Assessment = z.infer<typeof assessmentSchema>;

export const spendEventSchema = z
  .strictObject({
    actor: requiredStringSchema,
    phase: requiredStringSchema,
    costUsd: z.number().nonnegative(),
    provider: requiredStringSchema,
    reconcilableTo: jsonValueSchema,
  })
  .readonly();
export type SpendEvent = z.infer<typeof spendEventSchema>;

export const cascadeFindingVerdictSchema = z.enum([
  "confirmed",
  "isolated",
  "inconclusive",
]);
export type CascadeFindingVerdict = z.infer<typeof cascadeFindingVerdictSchema>;

export const cascadeFindingSchema = z
  .strictObject({
    cascadeId: requiredStringSchema,
    familyId: requiredStringSchema,
    evidenceQuestionId: requiredStringSchema,
    swapSetKey: requiredStringSchema,
    verdict: cascadeFindingVerdictSchema,
    culprits: z.array(z.array(requiredStringSchema)),
    cascadeSeedStepId: requiredStringSchema.nullable(),
    uncertainStepIds: z.array(requiredStringSchema),
    runSetsUsed: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .readonly();
export type CascadeFinding = z.infer<typeof cascadeFindingSchema>;

export const factSchema = z.union([
  executionSchema,
  requestAttemptSchema,
  assessmentSchema,
  spendEventSchema,
  cascadeFindingSchema,
]);
export type Fact = z.infer<typeof factSchema>;
