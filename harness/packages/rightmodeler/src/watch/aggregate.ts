import {
  readLedger,
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
  const ledger = await readLedger(store, "project");
  return ledger.lifecycleEvents.filter((event) => event.prNumber === prNumber);
}

export function derivePrState(events: readonly LifecycleEvent[]): PrState {
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
