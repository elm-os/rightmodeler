import { createHash, randomUUID } from "node:crypto";

import {
  canonicalJson,
  computeRunSpecDigest,
  factKey,
  jsonValueSchema,
  lifecycleEventSchema,
  verdictKey,
  type JsonValue,
  type LifecycleEvent,
  type Store,
} from "@rightmodeler/core";
import {
  diagnoseFailure,
  diagnoseRemediationEvidence,
  type DiagnosisSnapshot,
  type RemediationEvidence,
  type RemediationProposedChange,
  type RemediationValidation,
} from "@rightmodeler/kernel";
import { z } from "zod";

import type { ApplyVerdict } from "../apply/index.js";
import type { CapturedConventions } from "../enrich/index.js";
import type {
  GithubClient,
  GithubIssueComment,
  GithubReview,
  GithubReviewComment,
} from "../github/index.js";
import { putContractArtifact } from "../contract-validation.js";
import {
  derivePrState,
  readPrLifecycleEvents,
  type PrPhase,
} from "./aggregate.js";
import {
  claimWatchLock,
  heartbeatWatchLock,
  releaseWatchLock,
  type WatchLockClaim,
} from "./lock.js";

const caseIdPattern = /^[0-9a-f]{64}$/;
const storedVerdictSchema = z.looseObject({
  familyId: z.string(),
  reproof_requested: z.boolean().optional(),
  reproof_request_ids: z.array(z.string()).optional(),
});
const ciFailureDetailSchema = z.looseObject({
  category: z.literal("ci_failure"),
  headSha: z.string(),
  failingChecks: z.array(
    z.looseObject({
      id: z.number(),
      name: z.string(),
      completedAt: z.string(),
    }),
  ),
});

interface CiCheckFact {
  readonly id: number;
  readonly name: string;
  readonly completedAt: string | null;
}

export type WatchActionType =
  | "evidence_replied"
  | "reproof_requested"
  | "ci_failure_observed"
  | "pr_closed_rejected"
  | "pr_merged"
  | "watch_ended";

export interface WatchAction {
  readonly type: WatchActionType;
  readonly detail: JsonValue;
}

export type WatchResult =
  | {
      readonly status: "lock_held";
      readonly phase: null;
      readonly lastEventId: null;
      readonly actions: readonly [];
    }
  | {
      readonly status: "quiet" | "actions_taken";
      readonly phase: PrPhase;
      readonly lastEventId: string | null;
      readonly actions: readonly WatchAction[];
    };

export interface WatchOnceInput {
  readonly store: Store;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly repoDir: string;
  readonly prNumber: number;
  readonly verdicts: readonly ApplyVerdict[];
  readonly conventions: CapturedConventions;
}

interface LifecycleContext {
  readonly prNumber: number;
  readonly repo: string;
  readonly familyIds: readonly string[];
  readonly evidence: LifecycleEvent["evidence"];
  readonly runSpecDigest: string;
}

interface Question {
  readonly source: "review" | "review_comment" | "issue_comment";
  readonly id: number;
  readonly eventKey: string;
  readonly body: string;
  readonly user: string;
  readonly path?: string;
  readonly createdAt: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function detailRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function lifecycleContext(
  events: readonly LifecycleEvent[],
  repository: string,
  prNumber: number,
): LifecycleContext {
  const opened = events.find(({ kind }) => kind === "pr_opened");
  if (opened === undefined) {
    throw new Error(`Pull request ${prNumber} has no pr_opened lifecycle fact`);
  }
  for (const event of events) {
    if (
      event.repo !== opened.repo ||
      event.runSpecDigest !== opened.runSpecDigest
    ) {
      throw new Error(
        `Pull request ${prNumber} has inconsistent lifecycle facts`,
      );
    }
  }
  if (opened.repo !== repository) {
    throw new Error(
      `Pull request ${prNumber} belongs to ${opened.repo}, not ${repository}`,
    );
  }
  return {
    prNumber,
    repo: opened.repo,
    familyIds: opened.familyIds,
    evidence: opened.evidence,
    runSpecDigest: opened.runSpecDigest,
  };
}

async function appendLifecycleEvent(
  store: Store,
  context: LifecycleContext,
  kind: LifecycleEvent["kind"],
  detail: JsonValue,
): Promise<LifecycleEvent> {
  const event = lifecycleEventSchema.parse({
    ...context,
    kind,
    eventId: randomUUID(),
    createdAt: new Date().toISOString(),
    detail,
  });
  await store.putImmutable(
    factKey("project", event.eventId),
    Buffer.from(canonicalJson(event), "utf8"),
  );
  return event;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function evidenceReply(verdicts: readonly ApplyVerdict[]): string {
  return verdicts
    .map(({ verdict, caps }) => {
      const cases = verdict.caseIds.filter((caseId) =>
        caseIdPattern.test(caseId),
      );
      const invalidCaseIds = verdict.caseIds.length - cases.length;
      const renderedCases = cases.map((caseId) => `\`${caseId}\``);
      if (invalidCaseIds > 0) {
        renderedCases.push(
          `${invalidCaseIds} invalid case ID${invalidCaseIds === 1 ? "" : "s"} omitted`,
        );
      }
      const table = [
        `### ${verdict.familyId}`,
        "",
        "| Decision | Evaluator | Passes | Trials | Pass rate | Worst-case bound | Case IDs |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...verdict.evaluatorKinds.map(
          (evaluator) =>
            `| ${verdict.decision} | ${escapeCell(evaluator.evaluatorKind)} | ${evaluator.passes} | ${evaluator.trials} | ${percent(evaluator.passRate)} | ${percent(evaluator.worstCaseBound)} | ${renderedCases.join(", ")} |`,
        ),
        "",
        `Caps: ${caps.map(({ name, value }) => `${name} ${value}`).join(", ") || "none"}`,
      ];
      return table.join("\n");
    })
    .join("\n\n");
}

function affectedVerdicts(
  verdicts: readonly ApplyVerdict[],
  bodies: readonly string[],
  paths: readonly string[],
): ApplyVerdict[] {
  function mentionsFamily(body: string, familyId: string): boolean {
    const escaped = familyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(body);
  }
  const explicit = verdicts.filter(({ verdict }) =>
    bodies.some((body) => mentionsFamily(body, verdict.familyId)),
  );
  if (explicit.length > 0) return explicit;
  const byPath = verdicts.filter(({ swaps }) =>
    swaps.some(({ stepRecord }) => paths.includes(stepRecord.callSite.path)),
  );
  return byPath.length > 0 ? byPath : [...verdicts];
}

function questions(
  reviews: readonly GithubReview[],
  reviewComments: readonly GithubReviewComment[],
  issueComments: readonly GithubIssueComment[],
  prNumber: number,
): Question[] {
  return [
    ...reviews
      .filter(({ state }) => state === "COMMENTED")
      .map((review) => ({
        source: "review" as const,
        id: review.id,
        eventKey: `review-submission:${prNumber}:${review.id}`,
        body: review.body,
        user: review.user,
        createdAt: review.submittedAt ?? "",
      })),
    ...reviewComments.map((comment) => ({
      source: "review_comment" as const,
      id: comment.id,
      eventKey: `comment:${prNumber}:${comment.id}`,
      body: comment.body,
      user: comment.user,
      path: comment.path,
      createdAt: comment.createdAt,
    })),
    ...issueComments.map((comment) => ({
      source: "issue_comment" as const,
      id: comment.id,
      eventKey: `comment:${prNumber}:${comment.id}`,
      body: comment.body,
      user: comment.user,
      createdAt: comment.createdAt,
    })),
  ]
    .filter(
      ({ body, user }) =>
        body.trim() !== "" &&
        user !== "rightmodeler-bot" &&
        !user.endsWith("[bot]"),
    )
    .sort(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) ||
        left.id - right.id ||
        compareText(left.source, right.source),
    );
}

function parseStoredVerdict(value: unknown, familyId: string) {
  const verdict = storedVerdictSchema.parse(value);
  if (verdict.familyId !== familyId) {
    throw new Error(`Stored verdict for ${familyId} has the wrong familyId`);
  }
  return { verdict, requestIds: verdict.reproof_request_ids ?? [] };
}

function verdictWithoutReproofMetadata(
  verdict: Record<string, unknown>,
): JsonValue {
  return jsonValueSchema.parse(
    Object.fromEntries(
      Object.entries(verdict).filter(
        ([key]) => key !== "reproof_requested" && key !== "reproof_request_ids",
      ),
    ),
  );
}

async function verifyStoredVerdicts(
  store: Store,
  verdicts: readonly ApplyVerdict[],
): Promise<void> {
  for (const { verdict: supplied } of verdicts) {
    const entry = await store.get(verdictKey("project", supplied.familyId));
    if (entry === null) {
      throw new Error(`Stored verdict for ${supplied.familyId} is missing`);
    }
    const parsed = parseStoredVerdict(
      JSON.parse(Buffer.from(entry.body).toString("utf8")) as unknown,
      supplied.familyId,
    );
    if (
      canonicalJson(verdictWithoutReproofMetadata(parsed.verdict)) !==
      canonicalJson(jsonValueSchema.parse(supplied))
    ) {
      throw new Error(`Stored verdict for ${supplied.familyId} is stale`);
    }
  }
}

async function markForReproof(
  store: Store,
  verdicts: readonly ApplyVerdict[],
  requestId: string,
): Promise<void> {
  for (const { verdict: supplied } of verdicts) {
    const key = verdictKey("project", supplied.familyId);
    for (;;) {
      const entry = await store.get(key);
      if (entry === null) {
        throw new Error(`Stored verdict for ${supplied.familyId} is missing`);
      }
      const parsed = parseStoredVerdict(
        JSON.parse(Buffer.from(entry.body).toString("utf8")) as unknown,
        supplied.familyId,
      );
      const requestIds = [...new Set([...parsed.requestIds, requestId])].sort(
        compareText,
      );
      const next = jsonValueSchema.parse({
        ...parsed.verdict,
        reproof_requested: true,
        reproof_request_ids: requestIds,
      });
      const won = await store.compareAndSwap(
        key,
        entry.version,
        Buffer.from(JSON.stringify(next), "utf8"),
        entry.fenceToken,
      );
      if (won) break;
    }
  }
}

function ciEventKey(
  prNumber: number,
  headSha: string,
  checkIdentities: readonly string[],
): string {
  const checks = createHash("sha256")
    .update(JSON.stringify(checkIdentities))
    .digest("hex");
  return `ci:${prNumber}:${headSha}:${checks}`;
}

function checkIdentity(check: {
  readonly id: number;
  readonly completedAt: string | null;
}): string {
  return `${check.id}:${check.completedAt ?? ""}`;
}

function previousFailingCheckObservations(
  events: readonly LifecycleEvent[],
  headSha: string,
): Map<string, number> {
  const identities = new Map<string, number>();
  for (const event of events) {
    const detail = ciFailureDetailSchema.safeParse(event.detail);
    if (!detail.success || detail.data.headSha !== headSha) {
      continue;
    }
    for (const check of detail.data.failingChecks) {
      const identity = `${check.id}:${check.completedAt}`;
      identities.set(identity, (identities.get(identity) ?? 0) + 1);
    }
  }
  return identities;
}

function latestCiFailureDetail(
  events: readonly LifecycleEvent[],
): z.infer<typeof ciFailureDetailSchema> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const detail = ciFailureDetailSchema.safeParse(events[index]!.detail);
    if (detail.success) return detail.data;
  }
  return undefined;
}

function ciSnapshot(
  headSha: string,
  checks: readonly CiCheckFact[],
  status: "pass" | "fail",
): DiagnosisSnapshot {
  const facts = {
    gates: [{ id: "repo-ci", status }],
    cases: checks.map(({ id }) => ({
      caseId: `check-run-${id}`,
      pipelineFamily: "repo-fix",
      terminalVerdict: status,
      failureCode: null,
      evidenceRefs: [`github-check-run:${id}`],
    })),
    replayObserved: false,
  } as const;
  return {
    ...facts,
    snapshotId: `sha256:${computeRunSpecDigest(
      jsonValueSchema.parse({ headSha, ...facts }),
    )}`,
    confidenceStatus: status,
  };
}

function ciProposedChange(
  verdicts: readonly ApplyVerdict[],
  prNumber: number,
): RemediationProposedChange {
  return {
    type: "configuration",
    content: `Apply the reviewed model substitutions from pull request #${prNumber}.`,
    affected_files: [
      ...new Set(
        verdicts.flatMap(({ swaps }) =>
          swaps.map(({ stepRecord }) => stepRecord.callSite.path),
        ),
      ),
    ].sort(compareText),
    validation_commands: [],
  };
}

function ciValidation(
  checks: readonly CiCheckFact[],
  status: "passed" | "failed",
): RemediationValidation {
  return {
    status,
    commands: [...new Set(checks.map(({ name }) => name))].sort(compareText),
    evidence_refs: checks
      .map(({ id }) => `github-check-run:${id}`)
      .sort(compareText),
  };
}

async function writeRemediationEvidence(
  store: Store,
  evidence: RemediationEvidence,
): Promise<string> {
  const key = `project/reports/remediation-${evidence.evidence_id.slice("sha256:".length)}.json`;
  await putContractArtifact(store, key, "remediation-evidence", evidence);
  return key;
}

function action(type: WatchActionType, detail: JsonValue): WatchAction {
  return { type, detail };
}

function commentMarker(handledEventKey: string): string {
  const digest = createHash("sha256").update(handledEventKey).digest("hex");
  return `<!-- rightmodeler-watch:${digest} -->`;
}

export async function watchOnce(input: WatchOnceInput): Promise<WatchResult> {
  const acquired = await claimWatchLock(input);
  if (acquired === null) {
    return {
      status: "lock_held",
      phase: null,
      lastEventId: null,
      actions: [],
    };
  }
  let claim: WatchLockClaim = acquired;

  const actions: WatchAction[] = [];
  const observedIssueComments: GithubIssueComment[] = [];
  try {
    let state = await derivePrState(input);
    let events = await readPrLifecycleEvents(input);
    const context = lifecycleContext(
      events,
      `${input.owner}/${input.repo}`,
      input.prNumber,
    );

    async function renew(): Promise<void> {
      const renewed = await heartbeatWatchLock(input.store, claim);
      if (renewed === null) throw new Error("Lost the fenced PR watch lock");
      claim = renewed;
    }

    async function record(
      kind: LifecycleEvent["kind"],
      detail: JsonValue,
    ): Promise<LifecycleEvent> {
      await renew();
      const event = await appendLifecycleEvent(
        input.store,
        context,
        kind,
        detail,
      );
      events = [...events, event];
      return event;
    }

    async function comment(
      handledEventKey: string,
      body: string,
    ): Promise<number> {
      const marker = commentMarker(handledEventKey);
      const existing = observedIssueComments.find((item) =>
        item.body.includes(marker),
      );
      if (existing !== undefined) return existing.id;
      await renew();
      const posted = await input.githubClient.createIssueComment({
        owner: input.owner,
        repo: input.repo,
        issueNumber: input.prNumber,
        body: `${body}\n\n${marker}`,
      });
      await renew();
      observedIssueComments.push(posted);
      return posted.id;
    }

    async function endRecordedTerminal(
      reason: "merged" | "closed_rejected",
    ): Promise<WatchResult> {
      const ended = await record("watch_ended", { reason });
      actions.push(action("watch_ended", { reason }));
      return {
        status: "actions_taken",
        phase: "ended",
        lastEventId: ended.eventId,
        actions,
      };
    }

    if (state.phase === "ended") {
      return {
        status: "quiet",
        phase: state.phase,
        lastEventId: state.lastEventId,
        actions,
      };
    }
    if (state.phase === "merged") {
      return await endRecordedTerminal("merged");
    }
    if (state.phase === "closed_rejected") {
      return await endRecordedTerminal("closed_rejected");
    }

    const pull = await input.githubClient.getPullRequest({
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.prNumber,
    });
    await renew();
    if (pull.merged) {
      await record("pr_merged", {
        mergedAt: pull.mergedAt,
        headSha: pull.head.sha,
      });
      actions.push(
        action("pr_merged", {
          prNumber: input.prNumber,
          headSha: pull.head.sha,
        }),
      );
      return await endRecordedTerminal("merged");
    }
    if (pull.state === "closed") {
      await record("pr_closed_rejected", {
        reason: "closed_unmerged",
        closedAt: pull.closedAt,
        rejectionRecorded: true,
      });
      actions.push(
        action("pr_closed_rejected", {
          prNumber: input.prNumber,
          reason: "closed_unmerged",
        }),
      );
      return await endRecordedTerminal("closed_rejected");
    }

    const prVerdicts = input.verdicts.filter(({ verdict }) =>
      context.familyIds.includes(verdict.familyId),
    );
    if (prVerdicts.length !== context.familyIds.length) {
      throw new Error(
        `Stored evidence is missing for pull request ${input.prNumber}`,
      );
    }
    await verifyStoredVerdicts(input.store, prVerdicts);

    const [reviews, reviewComments, issueComments, checkRuns, base] =
      await Promise.all([
        input.githubClient.listReviews({
          owner: input.owner,
          repo: input.repo,
          pullNumber: input.prNumber,
        }),
        input.githubClient.listReviewComments({
          owner: input.owner,
          repo: input.repo,
          pullNumber: input.prNumber,
        }),
        input.githubClient.listIssueComments({
          owner: input.owner,
          repo: input.repo,
          issueNumber: input.prNumber,
        }),
        input.githubClient.listCheckRunsForRef({
          owner: input.owner,
          repo: input.repo,
          ref: pull.head.sha,
        }),
        input.githubClient.getRef({
          owner: input.owner,
          repo: input.repo,
          ref: `heads/${pull.base.ref}`,
        }),
      ]);
    await renew();

    observedIssueComments.push(...issueComments);
    const handled = new Set(state.handledEventKeys);

    for (const question of questions(
      reviews,
      reviewComments,
      issueComments,
      input.prNumber,
    )) {
      const key = question.eventKey;
      if (handled.has(key)) continue;
      const selected = affectedVerdicts(
        prVerdicts,
        [question.body],
        question.path === undefined ? [] : [question.path],
      );
      const postedCommentId = await comment(key, evidenceReply(selected));
      const event = await record("comment_posted", {
        handledEventKey: key,
        source: question.source,
        sourceCommentId: question.id,
        postedCommentId,
        familyIds: selected.map(({ verdict }) => verdict.familyId),
      });
      handled.add(key);
      state = {
        ...state,
        lastEventId: event.eventId,
        handledEventKeys: handled,
      };
      actions.push(
        action("evidence_replied", {
          source: question.source,
          commentId: question.id,
          familyIds: selected.map(({ verdict }) => verdict.familyId),
        }),
      );
    }

    for (const review of [...reviews].sort(
      (left, right) =>
        compareText(left.submittedAt ?? "", right.submittedAt ?? "") ||
        left.id - right.id,
    )) {
      if (review.state !== "CHANGES_REQUESTED") continue;
      const key = `review:${input.prNumber}:${review.id}`;
      if (handled.has(key)) continue;
      const attached = reviewComments.filter(
        ({ reviewId }) => reviewId === review.id,
      );
      const selected = affectedVerdicts(
        prVerdicts,
        [review.body, ...attached.map(({ body }) => body)],
        attached.map(({ path }) => path),
      );
      await renew();
      await markForReproof(input.store, selected, key);
      const familyIds = selected.map(({ verdict }) => verdict.familyId);
      const postedCommentId = await comment(
        key,
        `Acknowledged. The following model families will be re-proven against the requested changes: ${familyIds.join(", ")}.`,
      );
      const event = await record("reproof_started", {
        handledEventKey: key,
        reason: "changes_requested",
        reviewId: review.id,
        familyIds,
        reproof_requested: true,
        postedCommentId,
      });
      handled.add(key);
      state = {
        ...state,
        phase: "reproving",
        lastEventId: event.eventId,
        handledEventKeys: handled,
      };
      actions.push(
        action("reproof_requested", {
          reason: "changes_requested",
          reviewId: review.id,
          familyIds,
        }),
      );
    }

    if (base.sha !== context.evidence.revision) {
      const key = `base:${input.prNumber}:${base.sha}`;
      if (!handled.has(key)) {
        await renew();
        await markForReproof(input.store, prVerdicts, key);
        const familyIds = prVerdicts.map(({ verdict }) => verdict.familyId);
        const postedCommentId = await comment(
          key,
          `The base branch advanced from ${context.evidence.revision} to ${base.sha}. Evidence for ${familyIds.join(", ")} is being re-proven before the pull request changes.`,
        );
        const event = await record("reproof_started", {
          handledEventKey: key,
          reason: "base_branch_advanced",
          evidenceRevision: context.evidence.revision,
          baseRevision: base.sha,
          familyIds,
          reproof_requested: true,
          postedCommentId,
        });
        handled.add(key);
        state = {
          ...state,
          phase: "reproving",
          lastEventId: event.eventId,
          handledEventKeys: handled,
        };
        actions.push(
          action("reproof_requested", {
            reason: "base_branch_advanced",
            familyIds,
            baseRevision: base.sha,
          }),
        );
      }
    }

    const relevantChecks = checkRuns.checkRuns
      .filter(
        (check) =>
          check.headSha === pull.head.sha &&
          check.status === "completed" &&
          /(lint|test|build)/i.test(check.name),
      )
      .sort(
        (left, right) =>
          compareText(left.name, right.name) || left.id - right.id,
      );
    const failingChecks = relevantChecks.filter(
      ({ conclusion }) => conclusion === "failure",
    );
    if (failingChecks.length > 0) {
      const failingNames = [...new Set(failingChecks.map(({ name }) => name))];
      const diagnosis = diagnoseFailure({
        gates: [{ id: "repo-ci", status: "fail" }],
        cases: failingChecks.map(({ id }) => ({
          caseId: `check-run-${id}`,
          pipelineFamily: "repo-fix",
          terminalVerdict: "fail",
          failureCode: null,
          evidenceRefs: [`github-check-run:${id}`],
        })),
        replayObserved: false,
      });
      const priorChecks = previousFailingCheckObservations(
        events,
        pull.head.sha,
      );
      const persistent = failingChecks.filter(
        (check) => (priorChecks.get(checkIdentity(check)) ?? 0) >= 1,
      );
      const key = ciEventKey(
        input.prNumber,
        pull.head.sha,
        failingChecks.map(checkIdentity),
      );
      if (persistent.length === 0) {
        const remediationEvidence = diagnoseRemediationEvidence({
          baseline: ciSnapshot(pull.head.sha, failingChecks, "fail"),
          proposal: ciProposedChange(prVerdicts, input.prNumber),
          validation: ciValidation(failingChecks, "failed"),
        });
        const remediationEvidenceKey = await writeRemediationEvidence(
          input.store,
          remediationEvidence,
        );
        const postedCommentId = await comment(
          key,
          `Diagnosis: ${diagnosis.issueClass} (${diagnosis.nextAction}). The following relevant checks failed on ${pull.head.sha}: ${failingNames.join(", ")}. The watch will confirm the failure on the next pass before closing the pull request.`,
        );
        const event = await record("comment_posted", {
          handledEventKey: key,
          category: "ci_failure",
          issueClass: diagnosis.issueClass,
          nextAction: diagnosis.nextAction,
          failurePass: 1,
          headSha: pull.head.sha,
          checkNames: failingNames,
          failingChecks: failingChecks.map(({ id, name, completedAt }) => ({
            id,
            name,
            completedAt: completedAt ?? "",
          })),
          remediationEvidenceId: remediationEvidence.evidence_id,
          remediationEvidenceKey,
          postedCommentId,
        });
        state = { ...state, lastEventId: event.eventId };
        actions.push(
          action("ci_failure_observed", {
            failurePass: 1,
            checkNames: failingNames,
            issueClass: diagnosis.issueClass,
            nextAction: diagnosis.nextAction,
            remediationEvidenceId: remediationEvidence.evidence_id,
            remediationEvidenceKey,
          }),
        );
      } else {
        const persistentNames = [
          ...new Set(persistent.map(({ name }) => name)),
        ].sort(compareText);
        await renew();
        await input.githubClient.closePullRequest({
          owner: input.owner,
          repo: input.repo,
          pullNumber: input.prNumber,
        });
        await renew();
        await record("pr_closed_rejected", {
          handledEventKey: key,
          reason: "persistent_ci_failure",
          issueClass: diagnosis.issueClass,
          nextAction: diagnosis.nextAction,
          rejectionRecorded: true,
          failurePass: 2,
          headSha: pull.head.sha,
          checkNames: persistentNames,
          failingChecks: persistent.map(({ id, name, completedAt }) => ({
            id,
            name,
            completedAt: completedAt ?? "",
          })),
        });
        actions.push(
          action("pr_closed_rejected", {
            reason: "persistent_ci_failure",
            checkNames: persistentNames,
            issueClass: diagnosis.issueClass,
            nextAction: diagnosis.nextAction,
          }),
        );
        return await endRecordedTerminal("closed_rejected");
      }
    } else {
      const baselineDetail = latestCiFailureDetail(events);
      const passingChecksByName = new Map(
        relevantChecks
          .filter(({ conclusion }) => conclusion === "success")
          .map((check) => [check.name, check] as const),
      );
      const baselineCheckNames = [
        ...new Set(baselineDetail?.failingChecks.map(({ name }) => name) ?? []),
      ].sort(compareText);
      const passingChecks = baselineCheckNames.flatMap((name) => {
        const check = passingChecksByName.get(name);
        return check === undefined ? [] : [check];
      });
      if (
        baselineDetail !== undefined &&
        passingChecks.length === baselineCheckNames.length
      ) {
        const baselineChecks = baselineDetail.failingChecks.map(
          ({ id, name, completedAt }) => ({ id, name, completedAt }),
        );
        await writeRemediationEvidence(
          input.store,
          diagnoseRemediationEvidence({
            baseline: ciSnapshot(
              baselineDetail.headSha,
              baselineChecks,
              "fail",
            ),
            proposal: ciProposedChange(prVerdicts, input.prNumber),
            postFix: ciSnapshot(pull.head.sha, passingChecks, "pass"),
            validation: ciValidation(passingChecks, "passed"),
          }),
        );
      }
    }

    return {
      status: actions.length === 0 ? "quiet" : "actions_taken",
      phase: state.phase,
      lastEventId: state.lastEventId,
      actions,
    };
  } finally {
    await releaseWatchLock(input.store, claim);
  }
}
