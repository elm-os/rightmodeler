import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { FsStore } from "./store.js";
import {
  claimStep,
  heartbeat,
  reclaimStale,
  releaseStep,
  type StepClaim,
  type StepRecord,
  stepRecordSchema,
} from "./steps.js";

const temporaryDirectories: string[] = [];
const stepKey = "project/steps/step-1.json";

function pendingStep(): StepRecord {
  return {
    stepId: "step-1",
    callSite: { path: "src/agent.ts", line: 42, matcherSlug: "model-call" },
    family: "support",
    replayMode: "single_shot",
    prefixProvenance: "external",
    riskTier: "normal",
    capabilityRequirements: ["text"],
    evaluatorLadder: ["deterministic", "judge"],
    currentModel: "provider/current",
    observedCostUsd: 0.04,
    downstreamStepIds: [],
    candidates: [],
    analysisHistory: [],
    status: "pending",
    contentHash: "content-hash",
  };
}

async function makeStore(): Promise<FsStore> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-core-steps-"));
  temporaryDirectories.push(directory);
  const store = new FsStore(directory);
  await store.putImmutable(stepKey, Buffer.from(JSON.stringify(pendingStep())));
  return store;
}

async function storedStep(store: FsStore): Promise<StepRecord> {
  const entry = await store.get(stepKey);
  return stepRecordSchema.parse(
    JSON.parse(Buffer.from(entry!.body).toString("utf8")),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("step locking", () => {
  it("returns exactly one claim from a simultaneous two-worker race", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(fc.uuid(), fc.uuid())
          .filter(([first, second]) => first !== second),
        async ([first, second]) => {
          const store = await makeStore();
          const claims = await Promise.all([
            claimStep(new FsStore(store.root), stepKey, first),
            claimStep(new FsStore(store.root), stepKey, second),
          ]);

          expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
          const winner = claims.find((claim) => claim !== null)!;
          expect((await storedStep(store)).lockedByRunId).toBe(winner.runId);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("maintains at most one valid claim through random worker interleavings", async () => {
    const actions = fc.array(
      fc.constantFrom(
        "claim-a",
        "claim-b",
        "heartbeat-a",
        "heartbeat-b",
        "reclaim-a",
        "reclaim-b",
        "release-a",
        "release-b",
        "advance",
      ),
      { minLength: 1, maxLength: 35 },
    );

    await fc.assert(
      fc.asyncProperty(actions, async (commands) => {
        const store = await makeStore();
        const current: Record<"a" | "b", StepClaim | null> = {
          a: null,
          b: null,
        };
        const issued: StepClaim[] = [];
        let clock = Date.UTC(2026, 0, 1);
        const staleAfterMs = 25;

        for (const command of commands) {
          const worker = command.endsWith("-a")
            ? "a"
            : command.endsWith("-b")
              ? "b"
              : null;
          const runId = worker === null ? "" : `run-${worker}`;
          if (command === "advance") {
            clock += staleAfterMs + 1;
          } else if (command.startsWith("claim-") && worker !== null) {
            const claim = await claimStep(
              store,
              stepKey,
              runId,
              new Date(clock),
            );
            if (claim !== null) {
              current[worker] = claim;
              issued.push(claim);
            }
          } else if (command.startsWith("heartbeat-") && worker !== null) {
            const claim = current[worker];
            if (claim !== null) {
              const updated = await heartbeat(store, claim, new Date(clock));
              if (updated !== null) {
                current[worker] = updated;
                issued.push(updated);
              }
            }
          } else if (command.startsWith("reclaim-") && worker !== null) {
            const claim = await reclaimStale(
              store,
              stepKey,
              runId,
              staleAfterMs,
              new Date(clock),
            );
            if (claim !== null) {
              current[worker] = claim;
              issued.push(claim);
            }
          } else if (command.startsWith("release-") && worker !== null) {
            const claim = current[worker];
            if (claim !== null && (await releaseStep(store, claim))) {
              current[worker] = null;
            }
          }
          clock += 1;

          const entry = (await store.get(stepKey))!;
          const record = await storedStep(store);
          const staleClaims = issued.filter(
            (claim) =>
              claim.version !== entry.version ||
              claim.fenceToken !== entry.fenceToken ||
              claim.runId !== record.lockedByRunId ||
              record.status !== "replaying",
          );
          for (const staleClaim of staleClaims) {
            await expect(
              heartbeat(store, staleClaim, new Date(clock)),
            ).resolves.toBeNull();
            await expect(releaseStep(store, staleClaim)).resolves.toBe(false);
          }
        }
      }),
      { numRuns: 30 },
    );
  });

  it("fences the prior owner after a stale reclaim", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 60_000 }),
        fc
          .tuple(fc.uuid(), fc.uuid())
          .filter(([owner, reclaimer]) => owner !== reclaimer),
        async (staleAfterMs, [owner, reclaimer]) => {
          const store = await makeStore();
          const startedAt = new Date(Date.UTC(2026, 0, 1));
          const original = await claimStep(store, stepKey, owner, startedAt);
          expect(original).not.toBeNull();

          const reclaimed = await reclaimStale(
            store,
            stepKey,
            reclaimer,
            staleAfterMs,
            new Date(startedAt.getTime() + staleAfterMs + 1),
          );
          expect(reclaimed).not.toBeNull();
          expect(reclaimed!.fenceToken).toBeGreaterThan(original!.fenceToken);

          const current = (await store.get(stepKey))!;
          await expect(
            store.compareAndSwap(
              stepKey,
              current.version,
              current.body,
              original!.fenceToken,
            ),
          ).resolves.toBe(false);
          await expect(heartbeat(store, original!)).resolves.toBeNull();
          await expect(releaseStep(store, original!)).resolves.toBe(false);
          expect((await storedStep(store)).lockedByRunId).toBe(reclaimer);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("uses the heartbeat boundary and allows only one stale reclaimer", async () => {
    const store = await makeStore();
    const startedAt = new Date("2026-01-01T00:00:00Z");
    const staleAfterMs = 1_000;
    const original = (await claimStep(store, stepKey, "run-a", startedAt))!;

    await expect(
      reclaimStale(
        store,
        stepKey,
        "run-b",
        staleAfterMs,
        new Date(startedAt.getTime() + staleAfterMs),
      ),
    ).resolves.toBeNull();
    const refreshed = (await heartbeat(
      store,
      original,
      new Date(startedAt.getTime() + staleAfterMs),
    ))!;
    const reclaimers = await Promise.all([
      reclaimStale(
        new FsStore(store.root),
        stepKey,
        "run-b",
        staleAfterMs,
        new Date(startedAt.getTime() + 2 * staleAfterMs + 1),
      ),
      reclaimStale(
        new FsStore(store.root),
        stepKey,
        "run-c",
        staleAfterMs,
        new Date(startedAt.getTime() + 2 * staleAfterMs + 1),
      ),
    ]);

    expect(reclaimers.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(heartbeat(store, refreshed)).resolves.toBeNull();
  });

  it("heartbeats and releases only the current owner", async () => {
    const store = await makeStore();
    const claim = (await claimStep(
      store,
      stepKey,
      "run-a",
      new Date("2026-01-01T00:00:00Z"),
    ))!;
    const updated = await heartbeat(
      store,
      claim,
      new Date("2026-01-01T00:00:01Z"),
    );

    expect(updated?.record.heartbeatAt).toBe("2026-01-01T00:00:01.000Z");
    await expect(releaseStep(store, claim)).resolves.toBe(false);
    await expect(releaseStep(store, updated!)).resolves.toBe(true);
    const released = await storedStep(store);
    expect(released.status).toBe("pending");
    expect(released).not.toHaveProperty("lockedByRunId");
    expect(released).not.toHaveProperty("heartbeatAt");
  });
});
