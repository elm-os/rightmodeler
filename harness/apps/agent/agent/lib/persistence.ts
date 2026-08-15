import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

const spendRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_spend"),
  eventId: z.string().min(1),
  emittedAt: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  agent: z.string().min(1),
  channel: z.string().nullable(),
  costUsd: z.number().nonnegative(),
  usage: z.strictObject({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheWriteTokens: z.number().nonnegative().optional(),
  }),
});

let warnedMissingStore = false;

export async function persistAgentRecord(
  namespace: "audit" | "spend",
  eventId: string,
  record: unknown,
): Promise<"written" | "existing" | "skipped"> {
  const store = agentStore();
  if (store === undefined) return "skipped";
  const directory = join(store, "agent", namespace);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${encodeURIComponent(eventId)}.json`);
  const body = `${JSON.stringify(record)}\n`;
  try {
    await writeFile(path, body, { encoding: "utf8", flag: "wx" });
    return "written";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) === body) return "existing";
    throw new Error(
      `Agent record already exists with different bytes: ${path}`,
    );
  }
}

export async function readAgentSpendSummary(): Promise<{
  readonly available: boolean;
  readonly records: number;
  readonly costUsd: number;
}> {
  const store = agentStore();
  if (store === undefined) return { available: false, records: 0, costUsd: 0 };
  const directory = join(store, "agent", "spend");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: true, records: 0, costUsd: 0 };
    }
    throw error;
  }
  let costUsd = 0;
  let records = 0;
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const value: unknown = JSON.parse(
      await readFile(join(directory, name), "utf8"),
    );
    const record = spendRecordSchema.parse(value);
    costUsd += record.costUsd;
    records += 1;
  }
  return { available: true, records, costUsd };
}

function agentStore(): string | undefined {
  const value = process.env.RIGHTMODELER_AGENT_STORE;
  if (value !== undefined && value.length > 0) return resolve(value);
  if (!warnedMissingStore) {
    warnedMissingStore = true;
    console.warn(
      "rightmodeler agent persistence skipped: RIGHTMODELER_AGENT_STORE is not configured",
    );
  }
  return undefined;
}
