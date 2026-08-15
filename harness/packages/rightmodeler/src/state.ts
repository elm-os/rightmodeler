import { z } from "zod";

import { setupStateKey, type JsonValue, type Store } from "@rightmodeler/core";

const checkpointSchema = z.strictObject({
  inputDigest: z.string().min(1),
  outputKey: z.string().min(1),
  completedAt: z.string().min(1),
});

const setupStateSchema = z.strictObject({
  version: z.literal(1),
  stages: z.record(z.string(), checkpointSchema),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;
export type SetupState = z.infer<typeof setupStateSchema>;

export async function readSetupState(
  store: Store,
  projectId: string,
): Promise<SetupState> {
  const entry = await store.get(setupStateKey(projectId));
  if (entry === null) return { version: 1, stages: {} };
  return setupStateSchema.parse(
    JSON.parse(Buffer.from(entry.body).toString("utf8")),
  );
}

export async function writeCheckpoint(
  store: Store,
  projectId: string,
  stage: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const key = setupStateKey(projectId);
  for (;;) {
    const entry = await store.get(key);
    const current =
      entry === null
        ? { version: 1 as const, stages: {} }
        : setupStateSchema.parse(
            JSON.parse(Buffer.from(entry.body).toString("utf8")),
          );
    const next = setupStateSchema.parse({
      ...current,
      stages: { ...current.stages, [stage]: checkpoint },
    });
    const won = await store.compareAndSwap(
      key,
      entry?.version ?? 0,
      Buffer.from(JSON.stringify(next), "utf8"),
      entry?.fenceToken ?? 0,
    );
    if (won) return;
  }
}

export async function putMutableJson(
  store: Store,
  key: string,
  value: JsonValue,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  for (;;) {
    const entry = await store.get(key);
    if (entry !== null && Buffer.from(entry.body).equals(body)) {
      return;
    }
    const won = await store.compareAndSwap(
      key,
      entry?.version ?? 0,
      body,
      entry?.fenceToken ?? 0,
    );
    if (won) return;
  }
}

export async function readJson(store: Store, key: string): Promise<unknown> {
  const entry = await store.get(key);
  if (entry === null) throw new Error(`Store output is missing: ${key}`);
  return JSON.parse(Buffer.from(entry.body).toString("utf8")) as unknown;
}
