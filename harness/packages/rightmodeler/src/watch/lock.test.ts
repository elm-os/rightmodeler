import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsStore } from "@rightmodeler/core";
import { afterEach, describe, expect, it } from "vitest";

import { claimWatchLock, releaseWatchLock } from "./lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PR watch lock", () => {
  it("reclaims a stale heartbeat and fences the displaced owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-watch-lock-"));
    temporaryDirectories.push(root);
    const store = new FsStore(root);
    const input = {
      store,
      owner: "acme",
      repo: "demo",
      prNumber: 7,
    } as const;
    const first = await claimWatchLock({
      ...input,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(first).not.toBeNull();

    await expect(
      claimWatchLock({
        ...input,
        now: new Date("2026-01-01T00:05:00.000Z"),
      }),
    ).resolves.toBeNull();
    const reclaimed = await claimWatchLock({
      ...input,
      now: new Date("2026-01-01T00:05:00.001Z"),
    });
    expect(reclaimed).not.toBeNull();
    await expect(releaseWatchLock(store, first!)).resolves.toBe(false);
    await expect(releaseWatchLock(store, reclaimed!)).resolves.toBe(true);
    await expect(claimWatchLock(input)).resolves.not.toBeNull();
  });
});
