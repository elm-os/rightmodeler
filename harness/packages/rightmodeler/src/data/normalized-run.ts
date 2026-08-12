import { z } from "zod";

export const normalizedUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const normalizedStepSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  messages: z.array(z.json()),
  output: z.json(),
  usage: normalizedUsageSchema,
  family: z.string().min(1).optional(),
  trajectoryId: z.string().min(1),
  timestamp: z.string().min(1).optional(),
});

export const normalizedRunSchema = z.strictObject({
  version: z.literal("2"),
  traceId: z.string().min(1),
  sourceFormat: z.string().min(1),
  steps: z.array(normalizedStepSchema),
});

export type NormalizedUsage = z.infer<typeof normalizedUsageSchema>;
export type NormalizedStep = z.infer<typeof normalizedStepSchema>;
export type NormalizedRun = z.infer<typeof normalizedRunSchema>;
