import { createHash, randomUUID } from "node:crypto";

import type { FenceToken, Store, Version } from "@rightmodeler/core";
import { z } from "zod";

const staleAfterMs = 5 * 60 * 1_000;
const availableLockSchema = z.strictObject({ status: z.literal("available") });
const heldLockSchema = z.strictObject({
  status: z.literal("held"),
  ownerId: z.string().min(1),
  lockedAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
});
const watchLockSchema = z.discriminatedUnion("status", [
  availableLockSchema,
  heldLockSchema,
]);

export interface WatchLockClaim {
  readonly key: string;
  readonly ownerId: string;
  readonly version: Version;
  readonly fenceToken: FenceToken;
}

function encode(value: z.infer<typeof watchLockSchema>): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function lockKey(owner: string, repo: string, prNumber: number): string {
  const repository = createHash("sha256")
    .update(`${owner.toLowerCase()}/${repo.toLowerCase()}`)
    .digest("hex");
  return `project/watch-locks/${repository}/pr-${prNumber}.json`;
}

function nextFence(value: FenceToken): FenceToken {
  return value + 1;
}

export async function claimWatchLock({
  store,
  owner,
  repo,
  prNumber,
  now = new Date(),
}: {
  readonly store: Store;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly now?: Date;
}): Promise<WatchLockClaim | null> {
  const key = lockKey(owner, repo, prNumber);
  const entry = await store.get(key);
  const current =
    entry === null
      ? { status: "available" as const }
      : watchLockSchema.parse(
          JSON.parse(Buffer.from(entry.body).toString("utf8")),
        );
  if (current.status === "held") {
    const heartbeat = Date.parse(current.heartbeatAt);
    if (now.getTime() - heartbeat <= staleAfterMs) return null;
  }

  const ownerId = randomUUID();
  const timestamp = now.toISOString();
  const fenceToken = nextFence(entry?.fenceToken ?? 0);
  const won = await store.compareAndSwap(
    key,
    entry?.version ?? 0,
    encode({
      status: "held",
      ownerId,
      lockedAt: timestamp,
      heartbeatAt: timestamp,
    }),
    fenceToken,
  );
  if (!won) return null;
  return {
    key,
    ownerId,
    version: (entry?.version ?? 0) + 1,
    fenceToken,
  };
}

export async function heartbeatWatchLock(
  store: Store,
  claim: WatchLockClaim,
  now = new Date(),
): Promise<WatchLockClaim | null> {
  const entry = await store.get(claim.key);
  if (
    entry === null ||
    entry.version !== claim.version ||
    entry.fenceToken !== claim.fenceToken
  ) {
    return null;
  }
  const lock = watchLockSchema.parse(
    JSON.parse(Buffer.from(entry.body).toString("utf8")),
  );
  if (lock.status !== "held" || lock.ownerId !== claim.ownerId) return null;
  const won = await store.compareAndSwap(
    claim.key,
    claim.version,
    encode({ ...lock, heartbeatAt: now.toISOString() }),
    claim.fenceToken,
  );
  return won ? { ...claim, version: claim.version + 1 } : null;
}

export async function releaseWatchLock(
  store: Store,
  claim: WatchLockClaim,
): Promise<boolean> {
  const entry = await store.get(claim.key);
  if (
    entry === null ||
    entry.version !== claim.version ||
    entry.fenceToken !== claim.fenceToken
  ) {
    return false;
  }
  const lock = watchLockSchema.parse(
    JSON.parse(Buffer.from(entry.body).toString("utf8")),
  );
  if (lock.status !== "held" || lock.ownerId !== claim.ownerId) return false;
  return store.compareAndSwap(
    claim.key,
    claim.version,
    encode({ status: "available" }),
    nextFence(claim.fenceToken),
  );
}
