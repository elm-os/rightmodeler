import { z } from "zod";

export const harnessInputSchema = z.strictObject({
  repo: z.string().min(1),
  store: z.string().min(1).optional(),
});

export const replayStartInputSchema = harnessInputSchema.extend({
  traces: z.string().min(1).optional(),
  modeBConfig: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
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
  runId: z.string().regex(/^replay-[0-9a-f]{64}$/u),
});

export const openSwapPrInputSchema = harnessInputSchema.extend({
  owner: z.string().min(1).optional(),
  githubBaseUrl: z.string().url().optional(),
  githubTokenEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .optional(),
  dryRun: z.boolean().optional(),
});

export type ReplayStartToolInput = z.infer<typeof replayStartInputSchema>;
export type OpenSwapPrToolInput = z.infer<typeof openSwapPrInputSchema>;

export interface ReplayStartInput extends ReplayStartToolInput {
  readonly traces: string;
  readonly baseUrl: string;
}
