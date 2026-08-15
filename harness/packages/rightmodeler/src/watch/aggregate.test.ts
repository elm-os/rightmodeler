import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  factKey,
  FsStore,
  lifecycleEventSchema,
  type LifecycleEvent,
} from "@rightmodeler/core";
import { afterEach, describe, expect, it } from "vitest";

import { derivePrState } from "./aggregate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<FsStore> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-pr-state-"));
  temporaryDirectories.push(root);
  return new FsStore(root);
}

async function append(
  store: FsStore,
  input: Pick<LifecycleEvent, "eventId" | "kind" | "createdAt" | "detail">,
): Promise<void> {
  const event = lifecycleEventSchema.parse({
    ...input,
    prNumber: 7,
    repo: "acme/demo",
    familyIds: ["summarize"],
    evidence: {
      revision: "revision-1",
      corpusVersionId: "corpus-1",
      gatePolicyVersion: "policy-1",
    },
    runSpecDigest: "run-spec-1",
  });
  await store.putImmutable(
    factKey("project", event.eventId),
    Buffer.from(canonicalJson(event), "utf8"),
  );
}

describe("derivePrState", () => {
  it("folds append-only lifecycle facts and reconstructs handled keys", async () => {
    const store = await createStore();
    await append(store, {
      eventId: "opened",
      kind: "pr_opened",
      createdAt: "2026-01-01T00:00:00.000Z",
      detail: {},
    });
    await append(store, {
      eventId: "commented",
      kind: "comment_posted",
      createdAt: "2026-01-01T00:00:01.000Z",
      detail: { handledEventKey: "comment:7:41" },
    });
    await append(store, {
      eventId: "reproof",
      kind: "reproof_started",
      createdAt: "2026-01-01T00:00:02.000Z",
      detail: { handledEventKey: "review:7:9" },
    });

    await expect(derivePrState({ store, prNumber: 7 })).resolves.toEqual({
      phase: "reproving",
      lastEventId: "reproof",
      handledEventKeys: new Set(["comment:7:41", "review:7:9"]),
    });

    await append(store, {
      eventId: "merged",
      kind: "pr_merged",
      createdAt: "2026-01-01T00:00:03.000Z",
      detail: {},
    });
    expect((await derivePrState({ store, prNumber: 7 })).phase).toBe("merged");

    await append(store, {
      eventId: "ended",
      kind: "watch_ended",
      createdAt: "2026-01-01T00:00:04.000Z",
      detail: {},
    });
    expect(await derivePrState({ store, prNumber: 7 })).toMatchObject({
      phase: "ended",
      lastEventId: "ended",
    });

    await append(store, {
      eventId: "late-reproof",
      kind: "reproof_started",
      createdAt: "2026-01-01T00:00:05.000Z",
      detail: { handledEventKey: "review:7:late" },
    });
    expect(await derivePrState({ store, prNumber: 7 })).toMatchObject({
      phase: "ended",
      lastEventId: "late-reproof",
      handledEventKeys: new Set([
        "comment:7:41",
        "review:7:9",
        "review:7:late",
      ]),
    });
  });

  it("derives a rejected phase before terminal watch cleanup", async () => {
    const store = await createStore();
    await append(store, {
      eventId: "opened-rejected",
      kind: "pr_opened",
      createdAt: "2026-01-01T00:00:00.000Z",
      detail: {},
    });
    await append(store, {
      eventId: "rejected",
      kind: "pr_closed_rejected",
      createdAt: "2026-01-01T00:00:01.000Z",
      detail: { reason: "closed_unmerged" },
    });

    await expect(derivePrState({ store, prNumber: 7 })).resolves.toMatchObject({
      phase: "closed_rejected",
      lastEventId: "rejected",
    });
  });

  it("fails loudly when a listed fact is malformed", async () => {
    const store = await createStore();
    await store.putImmutable(
      factKey("project", "broken"),
      Buffer.from('{"kind":"pr_opened"}', "utf8"),
    );

    await expect(derivePrState({ store, prNumber: 7 })).rejects.toThrow();
  });
});
