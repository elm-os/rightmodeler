import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  Assessment,
  CascadeFinding,
  Execution,
  Fact,
  LifecycleEvent,
  RequestAttempt,
  SpendEvent,
} from "./facts.js";
import { canonicalJson } from "./identity.js";
import { factKey } from "./keys.js";
import { readLedger } from "./ledger.js";
import { FsStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<FsStore> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-ledger-"));
  temporaryDirectories.push(root);
  return new FsStore(root);
}

async function writeFact(
  store: FsStore,
  id: string,
  fact: Fact,
): Promise<void> {
  await store.putImmutable(
    factKey("project", id),
    Buffer.from(canonicalJson(fact), "utf8"),
  );
}

const execution = {
  executionId: "execution-1",
  evidenceQuestionId: "question-1",
  caseId: "case-1",
  stepId: "step-1",
  candidateId: "candidate-1",
  trajectoryId: "trajectory-1",
  corpusSplit: "validation",
  selectionStage: "replay",
  terminalOutcome: "success",
  finalOutput: { answer: "done" },
  attribution: "ok",
} satisfies Execution;

const requestAttempt = {
  attemptId: "attempt-1",
  logicalCallId: "call-1",
  executionId: "execution-1",
  streamOutcome: "completed",
  usage: { inputTokens: 100, outputTokens: 25 },
  costUsd: 0.0025,
  costIsEstimate: false,
} satisfies RequestAttempt;

const assessment = {
  assessmentId: "assessment-1",
  executionId: "execution-1",
  evaluatorId: "evaluator-1",
  metricName: "correctness",
  score: 0.95,
  passed: true,
  rubricVersion: "rubric-2",
  artifactRef: { path: "artifacts/result.json" },
} satisfies Assessment;

const spendEvent = {
  actor: "judge",
  phase: "revalidate",
  costUsd: 0.04,
  provider: "provider-1",
  reconcilableTo: { executionId: "execution-1" },
} satisfies SpendEvent;

const cascadeFinding = {
  cascadeId: "cascade-1",
  familyId: "family-1",
  evidenceQuestionId: "question-1",
  swapSetKey: "classify+lookup",
  verdict: "isolated",
  culprits: [["classify", "lookup"]],
  cascadeSeedStepId: "classify",
  uncertainStepIds: ["lookup"],
  runSetsUsed: 4,
  createdAt: "2026-08-13T12:00:00.000Z",
} satisfies CascadeFinding;

function lifecycleEvent(
  eventId: string,
  kind: LifecycleEvent["kind"],
  createdAt: string,
): LifecycleEvent {
  return {
    eventId,
    prNumber: 7,
    repo: "elm-os/rightmodeler",
    familyIds: ["summarize"],
    kind,
    evidence: {
      revision: "revision-1",
      corpusVersionId: "corpus-1",
      gatePolicyVersion: "gate-1",
    },
    runSpecDigest: "run-spec-1",
    createdAt,
    detail: {},
  };
}

describe("readLedger", () => {
  it("partitions every fact kind", async () => {
    const store = await createStore();
    const lifecycle = lifecycleEvent(
      "event-1",
      "apply_started",
      "2026-08-13T12:00:00.000Z",
    );
    await Promise.all([
      writeFact(store, "execution", execution),
      writeFact(store, "request-attempt", requestAttempt),
      writeFact(store, "assessment", assessment),
      writeFact(store, "spend", spendEvent),
      writeFact(store, "cascade", cascadeFinding),
      writeFact(store, "lifecycle", lifecycle),
    ]);

    await expect(readLedger(store, "project")).resolves.toEqual({
      executions: [execution],
      requestAttempts: [requestAttempt],
      assessments: [assessment],
      spendEvents: [spendEvent],
      cascadeFindings: [cascadeFinding],
      lifecycleEvents: [lifecycle],
      droppedRows: 0,
    });
  });

  it("sorts lifecycle events by time, kind, and event id", async () => {
    const store = await createStore();
    const later = lifecycleEvent(
      "event-later",
      "review_requested",
      "2026-08-13T12:00:01.000Z",
    );
    const merged = lifecycleEvent(
      "event-merged",
      "pr_merged",
      "2026-08-13T12:00:00.000Z",
    );
    const opened = lifecycleEvent(
      "event-opened",
      "pr_opened",
      "2026-08-13T12:00:00.000Z",
    );
    await writeFact(store, "a-merged", merged);
    await writeFact(store, "b-later", later);
    await writeFact(store, "z-opened", opened);

    const ledger = await readLedger(store, "project");

    expect(ledger.lifecycleEvents.map(({ eventId }) => eventId)).toEqual([
      "event-opened",
      "event-merged",
      "event-later",
    ]);
  });

  it("salvages malformed facts", async () => {
    const store = await createStore();
    await writeFact(store, "execution", execution);
    await writeFact(store, "request-attempt", requestAttempt);
    await writeFact(store, "assessment", assessment);
    await store.putImmutable(
      factKey("project", "broken"),
      Buffer.from('{"kind":"pr_opened"}', "utf8"),
    );

    await expect(readLedger(store, "project")).resolves.toMatchObject({
      executions: [execution],
      requestAttempts: [requestAttempt],
      assessments: [assessment],
      droppedRows: 1,
    });
  });

  it("returns an empty ledger for an empty store", async () => {
    const store = await createStore();

    await expect(readLedger(store, "project")).resolves.toEqual({
      executions: [],
      requestAttempts: [],
      assessments: [],
      spendEvents: [],
      cascadeFindings: [],
      lifecycleEvents: [],
      droppedRows: 0,
    });
  });
});
