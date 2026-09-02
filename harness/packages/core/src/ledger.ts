import { randomUUID } from "node:crypto";

import {
  lifecycleEventSchema,
  type Assessment,
  type CascadeFinding,
  type Execution,
  type JsonValue,
  type LifecycleEvent,
  type RequestAttempt,
  type SpendEvent,
} from "./facts.js";
import { canonicalJson } from "./identity.js";
import { factKey, factsPrefix } from "./keys.js";
import { parseFacts } from "./salvage.js";
import type { Store } from "./store.js";
import { compareText } from "./text.js";

export interface Ledger {
  readonly executions: readonly Execution[];
  readonly requestAttempts: readonly RequestAttempt[];
  readonly assessments: readonly Assessment[];
  readonly spendEvents: readonly SpendEvent[];
  readonly cascadeFindings: readonly CascadeFinding[];
  readonly lifecycleEvents: readonly LifecycleEvent[];
  readonly droppedRows: number;
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

export async function readLedger(
  store: Store,
  projectId: string,
): Promise<Ledger> {
  const keys = await store.list(factsPrefix(projectId));
  const rows: string[] = [];
  let droppedRows = 0;
  for (let index = 0; index < keys.length; index += 16) {
    const entries = await Promise.all(
      keys.slice(index, index + 16).map((key) => store.get(key)),
    );
    for (const entry of entries) {
      if (entry === null) {
        droppedRows += 1;
      } else {
        rows.push(Buffer.from(entry.body).toString("utf8"));
      }
    }
  }

  const parsed = parseFacts(rows);
  droppedRows += parsed.droppedRows;
  const executions: Execution[] = [];
  const requestAttempts: RequestAttempt[] = [];
  const assessments: Assessment[] = [];
  const spendEvents: SpendEvent[] = [];
  const cascadeFindings: CascadeFinding[] = [];
  const lifecycleEvents: LifecycleEvent[] = [];
  for (const fact of parsed.facts) {
    if ("attemptId" in fact) requestAttempts.push(fact);
    else if ("assessmentId" in fact) assessments.push(fact);
    else if ("cascadeId" in fact) cascadeFindings.push(fact);
    else if ("eventId" in fact) lifecycleEvents.push(fact);
    else if ("actor" in fact) spendEvents.push(fact);
    else executions.push(fact);
  }
  lifecycleEvents.sort(
    (left, right) =>
      compareText(left.createdAt, right.createdAt) ||
      lifecycleKindOrder[left.kind] - lifecycleKindOrder[right.kind] ||
      compareText(left.eventId, right.eventId),
  );

  return {
    executions,
    requestAttempts,
    assessments,
    spendEvents,
    cascadeFindings,
    lifecycleEvents,
    droppedRows,
  };
}

export async function appendLifecycleEvent(
  store: Store,
  projectId: string,
  event: Omit<LifecycleEvent, "eventId" | "createdAt">,
): Promise<void> {
  const value = lifecycleEventSchema.parse({
    ...event,
    eventId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  await store.putImmutable(
    factKey(projectId, value.eventId),
    Buffer.from(canonicalJson(value), "utf8"),
  );
}

export function lifecycleDetail(
  event: LifecycleEvent,
): Record<string, JsonValue> {
  if (
    typeof event.detail !== "object" ||
    event.detail === null ||
    Array.isArray(event.detail)
  ) {
    return {};
  }
  return event.detail;
}
