import {
  factSchema,
  factsPrefix,
  lifecycleEventSchema,
  type LifecycleEvent,
  type Store,
} from "@rightmodeler/core";
import { z } from "zod";

export type PrPhase =
  "open" | "reproving" | "closed_rejected" | "merged" | "ended";

export interface PrState {
  readonly phase: PrPhase;
  readonly lastEventId: string | null;
  readonly handledEventKeys: Set<string>;
}

const lifecycleKindOrder: Record<LifecycleEvent["kind"], number> = {
  apply_started: 0,
  pr_opened: 1,
  review_requested: 2,
  comment_posted: 3,
  reproof_started: 4,
  pr_closed_rejected: 5,
  pr_merged: 6,
  watch_ended: 7,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function handledEventKey(event: LifecycleEvent): string | undefined {
  if (
    typeof event.detail !== "object" ||
    event.detail === null ||
    Array.isArray(event.detail) ||
    !("handledEventKey" in event.detail)
  ) {
    return undefined;
  }
  return z.string().parse(event.detail.handledEventKey);
}

export async function readPrLifecycleEvents({
  store,
  prNumber,
}: {
  readonly store: Store;
  readonly prNumber: number;
}): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  for (const key of await store.list(factsPrefix("project"))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing listed fact: ${key}`);
    const value: unknown = JSON.parse(Buffer.from(entry.body).toString("utf8"));
    const fact = factSchema.parse(value);
    const lifecycle = lifecycleEventSchema.safeParse(fact);
    if (lifecycle.success && lifecycle.data.prNumber === prNumber) {
      events.push(lifecycle.data);
    }
  }
  return events.sort(
    (left, right) =>
      compareText(left.createdAt, right.createdAt) ||
      lifecycleKindOrder[left.kind] - lifecycleKindOrder[right.kind] ||
      compareText(left.eventId, right.eventId),
  );
}

export async function derivePrState({
  store,
  prNumber,
}: {
  readonly store: Store;
  readonly prNumber: number;
}): Promise<PrState> {
  const events = await readPrLifecycleEvents({ store, prNumber });
  let phase: PrPhase = "open";
  const handledEventKeys = new Set<string>();
  for (const event of events) {
    const key = handledEventKey(event);
    if (key !== undefined) handledEventKeys.add(key);
    if (phase === "ended") continue;
    if (phase === "merged" || phase === "closed_rejected") {
      if (event.kind === "watch_ended") phase = "ended";
      continue;
    }
    if (event.kind === "pr_opened") phase = "open";
    if (event.kind === "reproof_started") phase = "reproving";
    if (event.kind === "pr_closed_rejected") phase = "closed_rejected";
    if (event.kind === "pr_merged") phase = "merged";
    if (event.kind === "watch_ended") phase = "ended";
  }
  return {
    phase,
    lastEventId: events.at(-1)?.eventId ?? null,
    handledEventKeys,
  };
}
