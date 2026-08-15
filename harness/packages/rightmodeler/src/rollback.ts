import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";

import {
  canonicalJson,
  computeRunSpecDigest,
  factKey,
  FsStore,
  jsonValueSchema,
  lifecycleEventSchema,
  type JsonValue,
  type LifecycleEvent,
  type Store,
} from "@rightmodeler/core";

import {
  createRemediationLifecycleEvent,
  delegatedCiValidationReason,
  digestFileContent,
  readRemediationLifecycleEvents,
  remediationEvidenceId,
  remediationFromLifecycleDetail,
  type FileDigestMap,
  type RemediationLifecycleEvent,
} from "./apply/remediation.js";
import {
  createGithubClient,
  type GithubClient,
  type GithubFileContent,
  type GithubRef,
  GithubHttpError,
} from "./github/index.js";

const projectId = "project";

export type RollbackRefusalCode =
  | "missing_remediation_evidence"
  | "original_pr_not_merged"
  | "pre_apply_revision_unavailable"
  | "post_apply_digest_mismatch"
  | "rollback_branch_unowned"
  | "rollback_branch_scope_mismatch"
  | "rollback_restore_mismatch"
  | "rollback_restore_failed";

export interface RollbackRefusal {
  readonly code: RollbackRefusalCode;
  readonly message: string;
  readonly detail: JsonValue;
}

export type RollbackResult =
  | {
      readonly status: "refused";
      readonly reasons: readonly RollbackRefusal[];
    }
  | {
      readonly status: "existing" | "rolled_back";
      readonly originalPrNumber: number;
      readonly prNumber: number;
      readonly runSpecDigest: string;
      readonly branch: string;
      readonly title: string;
    };

export interface RollbackSwapsOptions {
  readonly repo: string;
  readonly store?: string;
  readonly owner: string;
  readonly githubBaseUrl: string;
  readonly githubTokenEnv: string;
  readonly prNumber: number;
}

interface RollbackSnapshot {
  readonly path: string;
  readonly current: GithubFileContent;
  readonly previous: GithubFileContent;
}

interface DigestMismatch {
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
}

interface PreApplyUnavailable {
  readonly path: string;
  readonly expected: string | null;
  readonly actual: string | null;
}

class RollbackServiceError extends Error {
  readonly code: RollbackRefusalCode;
  readonly detail: JsonValue;

  constructor(
    code: RollbackRefusalCode,
    message: string,
    detail: unknown = null,
  ) {
    super(message);
    this.name = "RollbackServiceError";
    this.code = code;
    this.detail = jsonValueSchema.parse(detail);
  }
}

function refusal(
  code: RollbackRefusalCode,
  message: string,
  detail: unknown = null,
): RollbackResult {
  return {
    status: "refused",
    reasons: [{ code, message, detail: jsonValueSchema.parse(detail) }],
  };
}

async function appendLifecycleEvent(
  store: Store,
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

function detailRecord(event: LifecycleEvent): Record<string, JsonValue> {
  if (
    typeof event.detail !== "object" ||
    event.detail === null ||
    Array.isArray(event.detail)
  ) {
    return {};
  }
  return event.detail;
}

function originalApplyEvent(
  events: readonly LifecycleEvent[],
  repository: string,
  prNumber: number,
): LifecycleEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.repo === repository &&
        event.prNumber === prNumber &&
        event.kind === "pr_opened",
    );
}

function existingRollback(
  events: readonly LifecycleEvent[],
  runSpecDigest: string,
): LifecycleEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.runSpecDigest === runSpecDigest &&
        event.kind === "pr_opened" &&
        event.prNumber !== null &&
        detailRecord(event).operation === "rollback",
    );
}

function existingRollbackStart(
  events: readonly LifecycleEvent[],
  runSpecDigest: string,
): LifecycleEvent | undefined {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.runSpecDigest === runSpecDigest &&
        event.kind === "apply_started" &&
        detailRecord(event).operation === "rollback",
    );
}

function requireAppliedEvidence(
  event: LifecycleEvent,
): RemediationLifecycleEvent {
  const remediation = remediationFromLifecycleDetail(event.detail);
  if (remediation.event_type !== "applied") {
    throw new Error("Rollback requires an applied remediation lifecycle event");
  }
  if (
    remediation.evidence_id !== remediationEvidenceId(event.runSpecDigest) ||
    remediation.repository_revision !== event.evidence.revision
  ) {
    throw new Error("Remediation evidence does not match its lifecycle fact");
  }
  return remediation;
}

function rollbackBranch(prNumber: number, runSpecDigest: string): string {
  return `rightmodeler/rollback-${prNumber}-${runSpecDigest.slice(0, 8)}`;
}

function rollbackTitle(originalTitle: string): string {
  return `Revert "${originalTitle}"`;
}

function rollbackBody(originalPrNumber: number, evidenceId: string): string {
  return [
    "## Rightmodeler rollback",
    "",
    `Restores the exact pre-apply file contents recorded for #${originalPrNumber}.`,
    "",
    `Evidence: \`${evidenceId}\``,
    "",
  ].join("\n");
}

async function optionalRef(
  githubClient: GithubClient,
  input: Parameters<GithubClient["getRef"]>[0],
): Promise<GithubRef | undefined> {
  try {
    return await githubClient.getRef(input);
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function optionalFile(
  githubClient: GithubClient,
  input: Parameters<GithubClient["getFileContent"]>[0],
): Promise<GithubFileContent | undefined> {
  try {
    return await githubClient.getFileContent(input);
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function snapshotsAtRef({
  githubClient,
  owner,
  repo,
  ref,
  remediation,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly remediation: RemediationLifecycleEvent;
}): Promise<{
  readonly snapshots: RollbackSnapshot[];
  readonly mismatches: DigestMismatch[];
  readonly preApplyUnavailable: PreApplyUnavailable[];
}> {
  const snapshots: RollbackSnapshot[] = [];
  const mismatches: DigestMismatch[] = [];
  const preApplyUnavailable: PreApplyUnavailable[] = [];
  for (const path of remediation.affected_files) {
    const current = await optionalFile(githubClient, {
      owner,
      repo,
      path,
      ref,
    });
    const actualPostDigest =
      current === undefined ? null : digestFileContent(current.contentBytes);
    const expectedPostDigest = remediation.post_apply_digests[path] ?? null;
    if (actualPostDigest !== expectedPostDigest) {
      mismatches.push({
        path,
        expected: expectedPostDigest,
        actual: actualPostDigest,
      });
      continue;
    }
    if (current === undefined) {
      mismatches.push({
        path,
        expected: expectedPostDigest,
        actual: actualPostDigest,
      });
      continue;
    }
    const previous = await optionalFile(githubClient, {
      owner,
      repo,
      path,
      ref: remediation.repository_revision,
    });
    const expectedPreDigest = remediation.pre_apply_digests[path] ?? null;
    const actualPreDigest =
      previous === undefined ? null : digestFileContent(previous.contentBytes);
    if (actualPreDigest !== expectedPreDigest || previous === undefined) {
      preApplyUnavailable.push({
        path,
        expected: expectedPreDigest,
        actual: actualPreDigest,
      });
      continue;
    }
    snapshots.push({ path, current, previous });
  }
  return { snapshots, mismatches, preApplyUnavailable };
}

async function resumeUpdates({
  githubClient,
  owner,
  repo,
  ref,
  remediation,
  snapshots,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly remediation: RemediationLifecycleEvent;
  readonly snapshots: readonly RollbackSnapshot[];
}): Promise<{
  readonly updates: RollbackSnapshot[];
  readonly mismatches: DigestMismatch[];
}> {
  const updates: RollbackSnapshot[] = [];
  const mismatches: DigestMismatch[] = [];
  for (const snapshot of snapshots) {
    const current = await optionalFile(githubClient, {
      owner,
      repo,
      path: snapshot.path,
      ref,
    });
    const actual =
      current === undefined ? null : digestFileContent(current.contentBytes);
    const preApplyDigest = remediation.pre_apply_digests[snapshot.path] ?? null;
    if (actual === preApplyDigest) continue;
    const postApplyDigest =
      remediation.post_apply_digests[snapshot.path] ?? null;
    if (actual !== postApplyDigest || current === undefined) {
      mismatches.push({
        path: snapshot.path,
        expected: postApplyDigest,
        actual,
      });
      continue;
    }
    updates.push({ ...snapshot, current });
  }
  return { updates, mismatches };
}

async function restoreRollbackBranch({
  githubClient,
  owner,
  repo,
  branch,
  title,
  snapshots,
  failedDigests,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly snapshots: readonly RollbackSnapshot[];
  readonly failedDigests: FileDigestMap;
}): Promise<void> {
  const branchRef = await optionalRef(githubClient, {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  if (branchRef === undefined) return;

  const currentFiles = new Map<string, GithubFileContent | undefined>();
  for (const snapshot of snapshots) {
    const current = await optionalFile(githubClient, {
      owner,
      repo,
      path: snapshot.path,
      ref: branchRef.sha,
    });
    currentFiles.set(snapshot.path, current);
    failedDigests[snapshot.path] =
      current === undefined ? null : digestFileContent(current.contentBytes);
  }
  for (const snapshot of snapshots) {
    const current = currentFiles.get(snapshot.path);
    if (current?.content === snapshot.current.content) continue;
    await githubClient.createOrUpdateFile({
      owner,
      repo,
      path: snapshot.path,
      message: `Restore after failed ${title}`,
      content: snapshot.current.content,
      branch,
      ...(current === undefined ? {} : { sha: current.sha }),
    });
  }
  for (const snapshot of snapshots) {
    const restored = await optionalFile(githubClient, {
      owner,
      repo,
      path: snapshot.path,
      ref: branch,
    });
    if (
      restored === undefined ||
      digestFileContent(restored.contentBytes) !==
        digestFileContent(snapshot.current.contentBytes)
    ) {
      throw new RollbackServiceError(
        "rollback_restore_failed",
        `Rollback failure did not restore ${snapshot.path} to the base state.`,
        { path: snapshot.path },
      );
    }
  }
}

export async function rollbackPreparedSwaps({
  store,
  githubClient,
  owner,
  repo,
  prNumber,
}: {
  readonly store: Store;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): Promise<RollbackResult> {
  const repository = `${owner}/${repo}`;
  const events = await readRemediationLifecycleEvents(store, projectId);
  const originalEvent = originalApplyEvent(events, repository, prNumber);
  if (originalEvent === undefined) {
    return refusal(
      "missing_remediation_evidence",
      `Pull request ${prNumber} has no recorded apply evidence.`,
    );
  }

  if (!("remediation" in detailRecord(originalEvent))) {
    return refusal(
      "missing_remediation_evidence",
      `Pull request ${prNumber} has no recorded remediation evidence.`,
    );
  }
  let remediation: RemediationLifecycleEvent;
  try {
    remediation = requireAppliedEvidence(originalEvent);
  } catch (error) {
    return refusal(
      "missing_remediation_evidence",
      `Pull request ${prNumber} has invalid remediation evidence.`,
      { message: error instanceof Error ? error.message : String(error) },
    );
  }
  const runSpecDigest = computeRunSpecDigest({
    operation: "rollback",
    repo: repository,
    originalPrNumber: prNumber,
    evidenceId: remediation.evidence_id,
  });
  const branch = rollbackBranch(prNumber, runSpecDigest);
  const priorRollback = existingRollback(events, runSpecDigest);
  if (
    priorRollback?.prNumber !== null &&
    priorRollback?.prNumber !== undefined
  ) {
    const detail = detailRecord(priorRollback);
    return {
      status: "existing",
      originalPrNumber: prNumber,
      prNumber: priorRollback.prNumber,
      runSpecDigest,
      branch: typeof detail.branch === "string" ? detail.branch : branch,
      title:
        typeof detail.title === "string"
          ? detail.title
          : "Rollback model swaps",
    };
  }

  const originalPull = await githubClient.getPullRequest({
    owner,
    repo,
    pullNumber: prNumber,
  });
  if (!originalPull.merged) {
    return refusal(
      "original_pr_not_merged",
      "Only a merged model-swap pull request can be rolled back.",
      { prNumber },
    );
  }

  let base = await githubClient.getRef({
    owner,
    repo,
    ref: `heads/${originalPull.base.ref}`,
  });
  let baseState = await snapshotsAtRef({
    githubClient,
    owner,
    repo,
    ref: base.sha,
    remediation,
  });
  if (baseState.mismatches.length > 0) {
    return refusal(
      "post_apply_digest_mismatch",
      "Affected files no longer match the recorded post-apply state.",
      { files: baseState.mismatches },
    );
  }
  if (baseState.preApplyUnavailable.length > 0) {
    return refusal(
      "pre_apply_revision_unavailable",
      "The recorded pre-apply file revision is unavailable or does not match its digest.",
      { files: baseState.preApplyUnavailable },
    );
  }

  const title = rollbackTitle(originalPull.title);
  const started = existingRollbackStart(events, runSpecDigest);
  const rollbackRef = await optionalRef(githubClient, {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  if (rollbackRef !== undefined && started === undefined) {
    return refusal(
      "rollback_branch_unowned",
      "The deterministic rollback branch exists without a recorded rollback start.",
      { branch },
    );
  }
  if (rollbackRef !== undefined) {
    const recordedBaseRevision =
      started === undefined ? undefined : detailRecord(started).baseRevision;
    if (typeof recordedBaseRevision !== "string") {
      return refusal(
        "rollback_branch_unowned",
        "The existing rollback branch has no recorded base revision.",
        { branch },
      );
    }
    const comparison = await githubClient.compareCommits({
      owner,
      repo,
      base: recordedBaseRevision,
      head: rollbackRef.sha,
    });
    const affected = new Set(remediation.affected_files);
    const unexpected = comparison.files
      .map(({ filename }) => filename)
      .filter((path) => !affected.has(path));
    if (unexpected.length > 0) {
      return refusal(
        "rollback_branch_scope_mismatch",
        "The existing rollback branch changes files outside the recorded remediation scope.",
        { branch, paths: unexpected },
      );
    }
  }
  let updates = baseState.snapshots;
  if (rollbackRef !== undefined) {
    const resumed = await resumeUpdates({
      githubClient,
      owner,
      repo,
      ref: rollbackRef.sha,
      remediation,
      snapshots: baseState.snapshots,
    });
    if (resumed.mismatches.length > 0) {
      return refusal(
        "post_apply_digest_mismatch",
        "Rollback branch files match neither the recorded pre-apply nor post-apply state.",
        { files: resumed.mismatches },
      );
    }
    updates = resumed.updates;
  }

  const latestBase = await githubClient.getRef({
    owner,
    repo,
    ref: `heads/${originalPull.base.ref}`,
  });
  if (latestBase.sha !== base.sha) {
    base = latestBase;
    baseState = await snapshotsAtRef({
      githubClient,
      owner,
      repo,
      ref: base.sha,
      remediation,
    });
    if (baseState.mismatches.length > 0) {
      return refusal(
        "post_apply_digest_mismatch",
        "Affected files no longer match the recorded post-apply state.",
        { files: baseState.mismatches },
      );
    }
    if (baseState.preApplyUnavailable.length > 0) {
      return refusal(
        "pre_apply_revision_unavailable",
        "The recorded pre-apply file revision is unavailable or does not match its digest.",
        { files: baseState.preApplyUnavailable },
      );
    }
    if (rollbackRef === undefined) updates = baseState.snapshots;
  }
  const lifecycle = {
    repo: repository,
    familyIds: [...originalEvent.familyIds],
    evidence: {
      revision: base.sha,
      corpusVersionId: originalEvent.evidence.corpusVersionId,
      gatePolicyVersion: originalEvent.evidence.gatePolicyVersion,
    },
    runSpecDigest,
  };
  if (started === undefined) {
    await appendLifecycleEvent(store, {
      ...lifecycle,
      prNumber: null,
      kind: "apply_started",
      detail: {
        operation: "rollback",
        originalPrNumber: prNumber,
        baseRevision: base.sha,
        branch,
        title,
      },
    });
  }

  let ownsBranch = rollbackRef !== undefined;
  try {
    if (rollbackRef === undefined) {
      await githubClient.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: base.sha,
      });
      ownsBranch = true;
    }
    for (const snapshot of updates) {
      await githubClient.createOrUpdateFile({
        owner,
        repo,
        path: snapshot.path,
        message: title,
        content: snapshot.previous.content,
        branch,
        sha: snapshot.current.sha,
      });
    }

    const rollbackHead = await githubClient.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const restoredDigests: FileDigestMap = {};
    for (const path of remediation.affected_files) {
      const restored = await optionalFile(githubClient, {
        owner,
        repo,
        path,
        ref: rollbackHead.sha,
      });
      const actual =
        restored === undefined
          ? null
          : digestFileContent(restored.contentBytes);
      restoredDigests[path] = actual;
      if (actual !== (remediation.pre_apply_digests[path] ?? null)) {
        throw new RollbackServiceError(
          "rollback_restore_mismatch",
          `Rollback did not restore the recorded pre-apply state: ${path}`,
          {
            path,
            expected: remediation.pre_apply_digests[path] ?? null,
            actual,
          },
        );
      }
    }

    const rollbackEvidence = createRemediationLifecycleEvent({
      evidenceId: remediation.evidence_id,
      eventType: "rolled_back",
      actor: "rightmodeler",
      reason: delegatedCiValidationReason,
      repositoryRevision: base.sha,
      affectedFiles: remediation.affected_files,
      preApplyDigests: remediation.pre_apply_digests,
      postApplyDigests: restoredDigests,
      restored: true,
    });
    const priorPullRequest = await githubClient.findOpenPullRequest({
      owner,
      repo,
      head: branch,
      base: originalPull.base.ref,
    });
    const pullRequest =
      priorPullRequest ??
      (await githubClient.createPullRequest({
        owner,
        repo,
        title,
        body: rollbackBody(prNumber, remediation.evidence_id),
        head: branch,
        base: originalPull.base.ref,
        draft: true,
      }));
    await appendLifecycleEvent(store, {
      ...lifecycle,
      prNumber: pullRequest.number,
      kind: "pr_opened",
      detail: {
        operation: "rollback",
        originalPrNumber: prNumber,
        branch,
        title,
        remediation: rollbackEvidence,
      },
    });

    return {
      status: "rolled_back",
      originalPrNumber: prNumber,
      prNumber: pullRequest.number,
      runSpecDigest,
      branch,
      title,
    };
  } catch (error) {
    const failedDigests: FileDigestMap = Object.fromEntries(
      remediation.affected_files.map((path) => [
        path,
        (ownsBranch
          ? remediation.pre_apply_digests[path]
          : remediation.post_apply_digests[path]) ?? null,
      ]),
    );
    let restoreFailure: unknown;
    if (ownsBranch) {
      try {
        await restoreRollbackBranch({
          githubClient,
          owner,
          repo,
          branch,
          title,
          snapshots: baseState.snapshots,
          failedDigests,
        });
      } catch (caught) {
        restoreFailure = caught;
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    const failureEvidence = createRemediationLifecycleEvent({
      evidenceId: remediation.evidence_id,
      eventType: "rollback_failed",
      actor: "rightmodeler",
      reason,
      repositoryRevision: base.sha,
      affectedFiles: remediation.affected_files,
      preApplyDigests: remediation.pre_apply_digests,
      postApplyDigests: failedDigests,
      restored: ownsBranch && restoreFailure === undefined,
    });
    await appendLifecycleEvent(store, {
      ...lifecycle,
      prNumber: null,
      kind: "apply_started",
      detail: {
        operation: "rollback_failed",
        originalPrNumber: prNumber,
        branch,
        title,
        remediation: failureEvidence,
      },
    });
    if (restoreFailure !== undefined) {
      if (restoreFailure instanceof RollbackServiceError) throw restoreFailure;
      throw new RollbackServiceError(
        "rollback_restore_failed",
        `Rollback failure restoration failed: ${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}`,
        { branch },
      );
    }
    if (error instanceof RollbackServiceError) {
      return refusal(error.code, error.message, error.detail);
    }
    throw new Error(
      ownsBranch ? `${reason}; rollback branch was restored to base` : reason,
      { cause: error },
    );
  }
}

export function rollbackSwaps(
  options: RollbackSwapsOptions,
): Promise<RollbackResult> {
  const repoDir = resolve(options.repo);
  return rollbackPreparedSwaps({
    store: new FsStore(
      resolve(options.store ?? join(repoDir, ".rightmodeler")),
    ),
    githubClient: createGithubClient({
      baseUrl: options.githubBaseUrl,
      tokenEnv: options.githubTokenEnv,
    }),
    owner: options.owner,
    repo: basename(repoDir),
    prNumber: options.prNumber,
  });
}
