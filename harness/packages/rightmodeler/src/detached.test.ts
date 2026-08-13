import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  factKey,
  FsStore,
  lifecycleEventSchema,
  spendEventSchema,
} from "@rightmodeler/core";

import {
  beginDetachedReplayWorker,
  claimDetachedReplay,
  listApprovedSwapSets,
  listWatchablePullRequests,
  readActiveDetachedReplay,
  readRunStatus,
  readStatus,
  runPipeline,
} from "./pipeline.js";
import { Reporter } from "./protocol.js";

const temporaryDirectories: string[] = [];
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;

interface StubProvider {
  readonly port: number;
  close(): Promise<void>;
}

interface StubProviderModule {
  startStubProvider(input: { port: number }): Promise<StubProvider>;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("pull request watches", () => {
  it("derives active and terminal-unended watches from lifecycle records", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-watches-"));
    temporaryDirectories.push(root);
    const store = new FsStore(join(root, "store"));
    const event = (
      eventId: string,
      prNumber: number,
      kind: "pr_opened" | "pr_merged" | "watch_ended",
    ) =>
      lifecycleEventSchema.parse({
        eventId,
        prNumber,
        repo: "owner/repo",
        familyIds: ["summarize"],
        kind,
        evidence: {
          revision: "abc123",
          corpusVersionId: "corpus-1",
          gatePolicyVersion: "phase-a-v2",
        },
        runSpecDigest: `run-${prNumber}`,
        createdAt: new Date(prNumber * 1_000).toISOString(),
        detail: {},
      });
    for (const record of [
      event("open-1", 1, "pr_opened"),
      event("open-2", 2, "pr_opened"),
      event("merged-2", 2, "pr_merged"),
      event("open-3", 3, "pr_opened"),
      event("merged-3", 3, "pr_merged"),
      event("ended-3", 3, "watch_ended"),
    ]) {
      await store.putImmutable(
        factKey("project", record.eventId),
        Buffer.from(canonicalJson(record), "utf8"),
      );
    }

    await expect(
      listWatchablePullRequests({ repo: demoAppPath, store: store.root }),
    ).resolves.toEqual([
      { prNumber: 1, phase: "open" },
      { prNumber: 2, phase: "terminal" },
    ]);
    await expect(
      listApprovedSwapSets({ repo: demoAppPath, store: store.root }),
    ).rejects.toThrow("Approved swap run-2 resolved to 0 immutable mappings");
  });
});

describe("detached replay progress", () => {
  it(
    "reports only stages observed by the requested run",
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rightmodeler-detached-"));
      temporaryDirectories.push(root);
      const repo = demoAppPath;
      const store = join(root, "store");
      const traces = join(root, "traces.jsonl");
      await writeFile(traces, await readFile(tracesPath));
      const reporter = new Reporter("json", {
        stdout: () => undefined,
        stderr: () => undefined,
      });

      const stubModule = (await import(stubModuleUrl)) as StubProviderModule;
      const stub = await stubModule.startStubProvider({ port: 0 });
      const apiKeyEnv = "RIGHTMODELER_DETACHED_TEST_API_KEY";
      process.env[apiKeyEnv] = "fixture-key";
      let claim: Awaited<ReturnType<typeof claimDetachedReplay>>;
      try {
        claim = await claimDetachedReplay({
          repo,
          store,
          traces,
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          apiKeyEnv,
          reporter,
        });
        await expect(
          claimDetachedReplay({
            repo,
            store,
            traces,
            baseUrl: `http://127.0.0.1:${stub.port}/v1`,
            apiKeyEnv,
            reporter,
          }),
        ).resolves.toMatchObject({ runId: claim.runId, deduplicated: true });
        expect(reporter.events).toEqual([]);

        expect(
          (await readRunStatus({ repo, store, runId: claim.runId })).progress,
        ).toEqual({
          completedStages: [],
          targetStage: "replay",
          completed: 0,
          total: 8,
        });

        await expect(
          beginDetachedReplayWorker({ repo, store, reporter }, claim.runId),
        ).resolves.toBe(true);
        await expect(
          readActiveDetachedReplay({ repo, store }),
        ).resolves.toMatchObject({
          runId: claim.runId,
          status: "running",
        });
        await expect(
          beginDetachedReplayWorker({ repo, store, reporter }, claim.runId),
        ).resolves.toBe(false);
        const nextClaim = await claimDetachedReplay({
          repo,
          store,
          traces,
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          apiKeyEnv,
          maxCostUsd: 1,
          reporter,
        });
        expect(nextClaim.runId).not.toBe(claim.runId);
        await expect(
          beginDetachedReplayWorker({ repo, store, reporter }, nextClaim.runId),
        ).resolves.toBe(false);
        await runPipeline({
          repo,
          store,
          traces,
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          apiKeyEnv,
          through: "replay",
          existingRunId: claim.runId,
          reporter,
        });
        await expect(
          claimDetachedReplay({
            repo,
            store,
            baseUrl: `http://127.0.0.1:${stub.port}/v1`,
            apiKeyEnv,
            reporter,
          }),
        ).resolves.toMatchObject({ runId: claim.runId, deduplicated: true });
        expect(
          (await readRunStatus({ repo, store, runId: claim.runId })).progress,
        ).toEqual({
          completedStages: [
            "scan",
            "ingest",
            "reconcile",
            "scrub",
            "corpus",
            "audit-sample",
            "shortlist",
            "replay",
          ],
          targetStage: "replay",
          completed: 8,
          total: 8,
        });
        const stored = new FsStore(store);
        const shortlistKeys = await stored.list("project/setup/shortlist-");
        const shortlistEntry = await stored.get(shortlistKeys.at(-1)!);
        const shortlist = JSON.parse(
          Buffer.from(shortlistEntry!.body).toString("utf8"),
        ) as { steps: Array<{ observedContextTokens: number }> };
        expect(
          shortlist.steps.every(({ observedContextTokens }) =>
            Number.isSafeInteger(observedContextTokens),
          ),
        ).toBe(true);
        expect(
          shortlist.steps.every(
            ({ observedContextTokens }) => observedContextTokens > 0,
          ),
        ).toBe(true);
        await expect(
          readActiveDetachedReplay({ repo, store }),
        ).resolves.toBeNull();
        await expect(
          beginDetachedReplayWorker({ repo, store, reporter }, nextClaim.runId),
        ).resolves.toBe(true);
        await expect(
          readActiveDetachedReplay({ repo, store }),
        ).resolves.toMatchObject({
          runId: nextClaim.runId,
          status: "running",
        });
      } finally {
        delete process.env[apiKeyEnv];
        await stub.close();
      }
    },
  );
});

describe("status spend", () => {
  it("reports authoritative harness spend totals by actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-status-spend-"));
    temporaryDirectories.push(root);
    const store = new FsStore(join(root, "store"));
    for (const [eventId, actor, costUsd] of [
      ["spend-1", "candidate", 1.25],
      ["spend-2", "candidate", 0.75],
      ["spend-3", "judge", 0.5],
    ] as const) {
      const record = spendEventSchema.parse({
        actor,
        phase: "replay",
        costUsd,
        provider: "fixture",
        reconcilableTo: { eventId },
      });
      await store.putImmutable(
        factKey("project", eventId),
        Buffer.from(canonicalJson(record), "utf8"),
      );
    }

    await expect(
      readStatus({ repo: demoAppPath, store: store.root }),
    ).resolves.toMatchObject({
      spend: {
        events: 3,
        totalCostUsd: 2.5,
        byActor: {
          candidate: { events: 2, costUsd: 2 },
          judge: { events: 1, costUsd: 0.5 },
        },
      },
    });
  });
});
