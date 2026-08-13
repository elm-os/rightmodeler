import { z } from "zod";

export const harnessInputSchema = z.strictObject({
  repo: z.string().min(1),
  store: z.string().min(1).optional(),
});

export const replayStartInputSchema = harnessInputSchema.extend({
  traces: z.string().min(1),
  modeBConfig: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .optional(),
  maxCostUsd: z.number().positive().optional(),
  evaluator: z
    .strictObject({
      provider: z.literal("braintrust"),
      baseUrl: z.string().url().optional(),
      apiKeyEnv: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
        .optional(),
      projectId: z.string().min(1).optional(),
      scorers: z.array(z.string().min(1)).min(1).optional(),
      gateMetric: z.string().min(1).optional(),
      gateThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export const replayStatusInputSchema = harnessInputSchema.extend({
  runId: z.string().regex(/^replay_[0-9a-f]{64}$/u),
});

export const openSwapPrInputSchema = harnessInputSchema.extend({
  owner: z.string().min(1),
  githubBaseUrl: z.string().url(),
  githubTokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  dryRun: z.boolean().optional(),
});

export type ReplayStartInput = z.infer<typeof replayStartInputSchema>;
