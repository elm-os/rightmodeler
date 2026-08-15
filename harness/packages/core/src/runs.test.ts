import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runKey } from "./keys.js";
import { completeRun, createRun, failRun, runMetaSchema } from "./runs.js";
import { FsStore, type Store } from "./store.js";

const temporaryDirectories: string[] = [];

async function makeStore(): Promise<FsStore> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-core-runs-"));
  temporaryDirectories.push(directory);
  return new FsStore(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("run lifecycle", () => {
  it("creates and completes persisted run metadata", async () => {
    const store = await makeStore();
    const created = await createRun(store, {
      projectId: "project",
      runId: "run-1",
      type: "pipeline",
      phase: "replay",
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(created).toMatchObject({
      runId: "run-1",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: process.pid,
    });

    const completed = await completeRun(
      store,
      "project",
      "run-1",
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(completed).toMatchObject({
      status: "completed",
      completedAt: "2026-01-01T00:01:00.000Z",
    });

    const stored = await store.get(runKey("project", "run-1"));
    expect(
      runMetaSchema.parse(
        JSON.parse(Buffer.from(stored!.body).toString("utf8")),
      ),
    ).toEqual(completed);
    await expect(completeRun(store, "project", "run-1")).resolves.toEqual(
      completed,
    );
  });

  it("fails a running run and rejects an opposite terminal transition", async () => {
    const store = await makeStore();
    await createRun(store, {
      projectId: "project",
      runId: "run-2",
      type: "pipeline",
      phase: "replay",
    });

    await expect(failRun(store, "project", "run-2")).resolves.toMatchObject({
      status: "failed",
    });
    await expect(completeRun(store, "project", "run-2")).rejects.toThrow(
      /already failed/,
    );
  });

  it("stops finishing a run after three lost compare-and-swap attempts", async () => {
    const body = Buffer.from(
      JSON.stringify({
        runId: "run-3",
        type: "pipeline",
        phase: "replay",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        pid: process.pid,
        hostname: "worker",
      }),
    );
    let attempts = 0;
    const store: Store = {
      get: async () => ({ body, version: 1, fenceToken: 0 }),
      list: async () => [],
      putImmutable: async () => undefined,
      compareAndSwap: async () => {
        attempts += 1;
        return false;
      },
    };

    await expect(completeRun(store, "project", "run-3")).rejects.toThrow(
      /after 3 attempts/,
    );
    expect(attempts).toBe(3);
  });
});
