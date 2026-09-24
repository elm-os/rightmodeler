import { z } from "zod";

const replayModeSchema = z.enum(["single_shot", "e2e"]);
export type ReplayMode = z.infer<typeof replayModeSchema>;

const prefixProvenanceSchema = z.enum([
  "external",
  "model_authored",
  "unknown",
]);
export type PrefixProvenance = z.infer<typeof prefixProvenanceSchema>;

const stepStatusSchema = z.enum(["pending", "replaying", "replayed", "error"]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepRecordSchema = z.strictObject({
  stepId: z.string().min(1),
  callSite: z.strictObject({
    path: z.string().min(1),
    line: z.number().int().positive(),
    matcherSlug: z.string().min(1),
  }),
  family: z.string().min(1),
  replayMode: replayModeSchema,
  prefixProvenance: prefixProvenanceSchema,
  riskTier: z.string().min(1),
  capabilityRequirements: z.array(z.string()),
  evaluatorLadder: z.array(z.string()),
  currentModel: z.string().min(1).nullable(),
  traceKey: z.string().min(1).optional(),
  observedCostUsd: z.number().nonnegative(),
  downstreamStepIds: z.array(z.string().min(1)),
  candidates: z.array(z.json()),
  analysisHistory: z.array(z.json()),
  status: stepStatusSchema,
  contentHash: z.string().min(1),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;
