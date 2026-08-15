import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { z } from "zod";

import { runKey } from "./keys.js";
import type { Store, StoreEntry } from "./store.js";

export const runStatusSchema = z.enum(["running", "completed", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runMetaSchema = z.strictObject({
  runId: z.string().min(1),
  type: z.string().min(1),
  phase: z.string().min(1),
  status: runStatusSchema,
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
});
export type RunMeta = z.infer<typeof runMetaSchema>;

export interface CreateRunInput {
  projectId: string;
  type: string;
  phase: string;
  runId?: string;
  now?: Date;
}

function encodeRun(meta: RunMeta): Buffer {
  return Buffer.from(JSON.stringify(meta), "utf8");
}

function decodeRun(entry: StoreEntry): RunMeta {
  return runMetaSchema.parse(
    JSON.parse(Buffer.from(entry.body).toString("utf8")),
  );
}

function timestamp(now: Date): string {
  return now.toISOString();
}

export async function createRun(
  store: Store,
  input: CreateRunInput,
): Promise<RunMeta> {
  const meta = runMetaSchema.parse({
    runId: input.runId ?? randomUUID(),
    type: input.type,
    phase: input.phase,
    status: "running",
    startedAt: timestamp(input.now ?? new Date()),
    pid: process.pid,
    hostname: hostname(),
  });
  await store.putImmutable(
    runKey(input.projectId, meta.runId),
    encodeRun(meta),
  );
  return meta;
}

async function finishRun(
  store: Store,
  projectId: string,
  runId: string,
  status: Exclude<RunStatus, "running">,
  now: Date,
): Promise<RunMeta> {
  const key = runKey(projectId, runId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Run does not exist: ${runId}`);
    const current = decodeRun(entry);
    if (current.status === status) return current;
    if (current.status !== "running") {
      throw new Error(`Run ${runId} is already ${current.status}`);
    }

    const completed = runMetaSchema.parse({
      ...current,
      status,
      completedAt: timestamp(now),
    });
    const won = await store.compareAndSwap(
      key,
      entry.version,
      encodeRun(completed),
      entry.fenceToken,
    );
    if (won) return completed;
  }
  throw new Error(`Failed to finish run after 3 attempts: ${runId}`);
}

export function completeRun(
  store: Store,
  projectId: string,
  runId: string,
  now = new Date(),
): Promise<RunMeta> {
  return finishRun(store, projectId, runId, "completed", now);
}

export function failRun(
  store: Store,
  projectId: string,
  runId: string,
  now = new Date(),
): Promise<RunMeta> {
  return finishRun(store, projectId, runId, "failed", now);
}
