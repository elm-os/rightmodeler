import { z } from "zod";

import type { FenceToken, Store, StoreEntry, Version } from "./store.js";

export const replayModeSchema = z.enum(["single_shot", "e2e"]);
export type ReplayMode = z.infer<typeof replayModeSchema>;

export const prefixProvenanceSchema = z.enum([
  "external",
  "model_authored",
  "unknown",
]);
export type PrefixProvenance = z.infer<typeof prefixProvenanceSchema>;

export const stepStatusSchema = z.enum([
  "pending",
  "replaying",
  "replayed",
  "error",
]);
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
  observedCostUsd: z.number().nonnegative(),
  downstreamStepIds: z.array(z.string().min(1)),
  candidates: z.array(z.json()),
  analysisHistory: z.array(z.json()),
  status: stepStatusSchema,
  lockedByRunId: z.string().min(1).optional(),
  lockedAt: z.string().min(1).optional(),
  heartbeatAt: z.string().min(1).optional(),
  contentHash: z.string().min(1),
});
export type StepRecord = z.infer<typeof stepRecordSchema>;

export interface StepClaim {
  key: string;
  runId: string;
  record: StepRecord;
  version: Version;
  fenceToken: FenceToken;
}

function encodeStep(record: StepRecord): Buffer {
  return Buffer.from(JSON.stringify(record), "utf8");
}

function decodeStep(entry: StoreEntry): StepRecord {
  return stepRecordSchema.parse(
    JSON.parse(Buffer.from(entry.body).toString("utf8")),
  );
}

function nextFence(fenceToken: FenceToken): FenceToken {
  return fenceToken + 1;
}

function timestamp(now: Date): string {
  return now.toISOString();
}

export async function claimStep(
  store: Store,
  key: string,
  runId: string,
  now = new Date(),
): Promise<StepClaim | null> {
  const entry = await store.get(key);
  if (entry === null) return null;
  const record = decodeStep(entry);
  if (
    (record.status !== "pending" && record.status !== "error") ||
    record.lockedByRunId !== undefined
  ) {
    return null;
  }

  const claimedAt = timestamp(now);
  const fenceToken = nextFence(entry.fenceToken);
  const claimed = stepRecordSchema.parse({
    ...record,
    status: "replaying",
    lockedByRunId: runId,
    lockedAt: claimedAt,
    heartbeatAt: claimedAt,
  });
  const won = await store.compareAndSwap(
    key,
    entry.version,
    encodeStep(claimed),
    fenceToken,
  );
  if (!won) return null;
  return {
    key,
    runId,
    record: claimed,
    version: entry.version + 1,
    fenceToken,
  };
}

export async function heartbeat(
  store: Store,
  claim: StepClaim,
  now = new Date(),
): Promise<StepClaim | null> {
  const entry = await store.get(claim.key);
  if (
    entry === null ||
    entry.version !== claim.version ||
    entry.fenceToken !== claim.fenceToken
  ) {
    return null;
  }
  const record = decodeStep(entry);
  if (record.status !== "replaying" || record.lockedByRunId !== claim.runId)
    return null;

  const updated = stepRecordSchema.parse({
    ...record,
    heartbeatAt: timestamp(now),
  });
  const won = await store.compareAndSwap(
    claim.key,
    claim.version,
    encodeStep(updated),
    claim.fenceToken,
  );
  if (!won) return null;
  return { ...claim, record: updated, version: claim.version + 1 };
}

export async function releaseStep(
  store: Store,
  claim: StepClaim,
  status: Exclude<StepStatus, "replaying"> = "pending",
): Promise<boolean> {
  const entry = await store.get(claim.key);
  if (
    entry === null ||
    entry.version !== claim.version ||
    entry.fenceToken !== claim.fenceToken
  ) {
    return false;
  }
  const record = decodeStep(entry);
  if (record.status !== "replaying" || record.lockedByRunId !== claim.runId)
    return false;

  const released = stepRecordSchema.parse({
    ...record,
    status,
    lockedByRunId: undefined,
    lockedAt: undefined,
    heartbeatAt: undefined,
  });
  return store.compareAndSwap(
    claim.key,
    claim.version,
    encodeStep(released),
    nextFence(claim.fenceToken),
  );
}

export async function reclaimStale(
  store: Store,
  key: string,
  runId: string,
  stalenessWindowMs: number,
  now = new Date(),
): Promise<StepClaim | null> {
  const entry = await store.get(key);
  if (entry === null) return null;
  const record = decodeStep(entry);
  if (
    record.status !== "replaying" ||
    record.lockedByRunId === undefined ||
    record.heartbeatAt === undefined
  ) {
    return null;
  }

  const heartbeatTime = Date.parse(record.heartbeatAt);
  if (Number.isNaN(heartbeatTime))
    throw new Error("Step has an invalid heartbeatAt timestamp");
  if (now.getTime() - heartbeatTime <= stalenessWindowMs) return null;

  const reclaimedAt = timestamp(now);
  const fenceToken = nextFence(entry.fenceToken);
  const reclaimed = stepRecordSchema.parse({
    ...record,
    status: "replaying",
    lockedByRunId: runId,
    lockedAt: reclaimedAt,
    heartbeatAt: reclaimedAt,
  });
  const won = await store.compareAndSwap(
    key,
    entry.version,
    encodeStep(reclaimed),
    fenceToken,
  );
  if (!won) return null;
  return {
    key,
    runId,
    record: reclaimed,
    version: entry.version + 1,
    fenceToken,
  };
}
