import { z } from "zod";

const statusSchema = z.object({
  lastRun: z
    .object({
      runId: z.string().min(1),
      type: z.string().min(1),
      status: z.enum(["running", "completed", "failed"]),
    })
    .nullable(),
});

export interface ReplayHandoff {
  readonly runId: string;
  readonly status: "completed" | "failed";
}

export function terminalReplayHandoff(
  status: unknown,
): ReplayHandoff | undefined {
  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) return undefined;
  const run = parsed.data.lastRun;
  if (run === null || run.type !== "replay" || run.status === "running") {
    return undefined;
  }
  return { runId: run.runId, status: run.status };
}
