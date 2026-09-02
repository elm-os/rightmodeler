import type {
  Assessment,
  CascadeFinding,
  Execution,
  LifecycleEvent,
  RequestAttempt,
  SpendEvent,
} from "./facts.js";
import { factsPrefix } from "./keys.js";
import { parseFacts } from "./salvage.js";
import type { Store } from "./store.js";

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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
