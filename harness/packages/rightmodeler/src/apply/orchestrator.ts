import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalJson,
  computeRunSpecDigest,
  factKey,
  jsonValueSchema,
  lifecycleEventSchema,
  type JsonValue,
  type LifecycleEvent,
  type Store,
} from "@rightmodeler/core";
import type { FamilyVerdict, GateResult } from "@rightmodeler/kernel";

import type {
  CapturedConventions,
  FamilyBlastRadius,
} from "../enrich/index.js";
import {
  type GithubClient,
  type GithubFileContent,
  GithubHttpError,
  type GithubPullRequest,
} from "../github/index.js";
import { buildSwapDiff, type SwapDiffFile, type SwapRequest } from "./diff.js";
import { lintSwapDiff, type DiffViolation } from "./difflint.js";
import { formatWithHostFormatter, type FormatterBlocker } from "./format.js";
import {
  createAppliedRemediationLifecycleEvent,
  createRemediationLifecycleEvent,
  digestFileContent,
  isRepositoryRevision,
  readRemediationLifecycleEvents,
  remediationFromLifecycleDetail,
  type FileDigestMap,
  type RemediationLifecycleEvent,
} from "./remediation.js";

const execFileAsync = promisify(execFile);
const projectId = "project";
const reviewerLimit = 5;

export type ApplyCascadeStatus =
  "confirmed" | "not-required" | "blocked" | "isolated" | "inconclusive";

export interface ApplyCap {
  readonly name: string;
  readonly value: number;
}

export interface ApplyVerdict {
  readonly verdict: FamilyVerdict;
  readonly releaseGates: readonly GateResult[];
  readonly cascadeStatus: ApplyCascadeStatus;
  readonly evidence: {
    readonly revision: string;
    readonly corpusVersionId: string;
  };
  readonly swaps: readonly SwapRequest[];
  readonly blastRadius: FamilyBlastRadius;
  readonly caps: readonly ApplyCap[];
}

export type ApplyRefusalCode =
  | "no_confirmed_recommendation"
  | "release_gate_failed"
  | "inconsistent_evidence"
  | "previously_rejected"
  | "stale_evidence"
  | "detached_head"
  | "stale_location"
  | "diff_lint_failed"
  | "formatter_blocked"
  | "host_conventions_unreadable"
  | "no_requestable_reviewers"
  | "invalid_repository_revision"
  | "apply_branch_unowned"
  | "apply_branch_scope_mismatch"
  | "apply_resume_state_mismatch"
  | "apply_restore_failed";

const caseIdPattern = /^[0-9a-f]{64}$/;

export interface ApplyRefusal {
  readonly code: ApplyRefusalCode;
  readonly message: string;
  readonly detail: JsonValue;
}

export type ApplyResult =
  | {
      readonly status: "refused";
      readonly reasons: readonly ApplyRefusal[];
    }
  | {
      readonly status: "dry_run";
      readonly runSpecDigest: string;
      readonly branch: string;
      readonly title: string;
      readonly files: readonly string[];
      readonly reviewers: readonly string[];
      readonly teamReviewers: readonly string[];
    }
  | {
      readonly status: "existing" | "applied";
      readonly runSpecDigest: string;
      readonly prNumber: number;
      readonly branch: string;
      readonly title: string;
      readonly reviewers: readonly string[];
      readonly teamReviewers: readonly string[];
    };

interface ReviewerSet {
  readonly reviewers: readonly string[];
  readonly teamReviewers: readonly string[];
}

interface ReviewIdentity {
  readonly kind: "user" | "team";
  readonly value: string;
}

interface ApplyBranchUpdate {
  readonly file: SwapDiffFile;
  readonly sha: string;
}

class ApplyServiceError extends Error {
  readonly code: ApplyRefusalCode;
  readonly detail: JsonValue;

  constructor(code: ApplyRefusalCode, message: string, detail: unknown = null) {
    super(message);
    this.name = "ApplyServiceError";
    this.code = code;
    this.detail = jsonValueSchema.parse(detail);
  }
}

function refusal(
  code: ApplyRefusalCode,
  message: string,
  detail: unknown = null,
): ApplyResult {
  return {
    status: "refused",
    reasons: [{ code, message, detail: jsonValueSchema.parse(detail) }],
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lintFiles(files: readonly SwapDiffFile[]) {
  return files.map((file) => ({
    path: file.path,
    before: file.before,
    after: file.after,
    replacements: file.hunks.flatMap(({ replacements }) => replacements),
  }));
}

function sortedSwapSet(verdicts: readonly ApplyVerdict[]): JsonValue {
  return verdicts
    .flatMap(({ verdict, swaps }) =>
      swaps.map(({ stepRecord, fromModel, toModel }) => ({
        familyId: verdict.familyId,
        stepId: stepRecord.stepId,
        path: stepRecord.callSite.path,
        fromModel,
        toModel,
      })),
    )
    .sort(
      (left, right) =>
        compareText(left.familyId, right.familyId) ||
        compareText(left.path, right.path) ||
        compareText(left.stepId, right.stepId) ||
        compareText(left.fromModel, right.fromModel) ||
        compareText(left.toModel, right.toModel),
    );
}

function branchPart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "models" : normalized;
}

function branchName(
  conventions: CapturedConventions,
  familyIds: readonly string[],
  runSpecDigest: string,
): string {
  const prefix = conventions.branchPrefix ?? "rightmodeler/";
  return `${prefix}swap-${branchPart(familyIds[0] ?? "models")}-${runSpecDigest.slice(0, 8)}`;
}

function changeTitle(
  conventions: CapturedConventions,
  familyIds: readonly string[],
): string {
  const families = familyIds.join(", ");
  return conventions.commitConvention.style === "conventional"
    ? `perf(models): swap ${families}`
    : `Swap ${families} models`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function evidenceBody(
  conventions: CapturedConventions,
  verdicts: readonly ApplyVerdict[],
): string {
  const evidence = verdicts[0]!.evidence;
  const table = [
    "## Rightmodeler evidence",
    "",
    `Revision: \`${evidence.revision}\``,
    `Corpus version: \`${evidence.corpusVersionId}\``,
    "",
    "| Family | Decision | Evaluator kinds | Cascade | Worst-case bound | Caps | Case IDs |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...verdicts.map(({ verdict, cascadeStatus, caps }) => {
      const evaluators = verdict.evaluatorKinds
        .map(({ evaluatorKind }) => evaluatorKind)
        .join(", ");
      const renderedCaps = caps
        .map(({ name, value }) => `${name}: ${value}`)
        .join("; ");
      const caseIds = verdict.caseIds.filter((caseId) =>
        caseIdPattern.test(caseId),
      );
      const renderedCaseIds = caseIds
        .slice(0, 5)
        .map((caseId) => `\`${caseId}\``);
      if (caseIds.length > 5) {
        renderedCaseIds.push(`and ${caseIds.length - 5} more`);
      }
      const invalidCaseIds = verdict.caseIds.length - caseIds.length;
      if (invalidCaseIds > 0) {
        renderedCaseIds.push(
          `${invalidCaseIds} invalid case ID${invalidCaseIds === 1 ? "" : "s"} omitted`,
        );
      }
      return `| ${escapeCell(verdict.familyId)} | ${verdict.decision} | ${escapeCell(evaluators)} | ${cascadeStatus} | ${percent(verdict.worstCaseBound)} | ${escapeCell(renderedCaps || "none")} | ${renderedCaseIds.join(", ")} |`;
    }),
    "",
  ].join("\n");
  const template = conventions.prTemplate?.trimEnd();
  return template === undefined || template === null || template === ""
    ? table
    : `${template}\n\n${table}`;
}

function reviewersFor(verdicts: readonly ApplyVerdict[]): ReviewerSet {
  const handles = [
    ...new Set(
      verdicts.flatMap(({ blastRadius }) =>
        blastRadius.owners.map(({ handle }) => handle),
      ),
    ),
  ].sort(compareText);
  const selected: ReviewIdentity[] = [];
  for (const handle of handles) {
    if (!handle.startsWith("@")) continue;
    const identity = handle.slice(1);
    const slash = identity.indexOf("/");
    selected.push(
      slash === -1
        ? { kind: "user", value: identity }
        : { kind: "team", value: identity.slice(slash + 1) },
    );
  }
  const unique = [
    ...new Map(
      selected.map((reviewer) => [
        `${reviewer.kind}:${reviewer.value.toLowerCase()}`,
        reviewer,
      ]),
    ).values(),
  ];
  return {
    reviewers: unique
      .flatMap(({ kind, value }) => (kind === "user" ? [value] : []))
      .slice(0, reviewerLimit),
    teamReviewers: unique
      .flatMap(({ kind, value }) => (kind === "team" ? [value] : []))
      .slice(0, reviewerLimit),
  };
}

async function gitOutput(repoDir: string, args: readonly string[]) {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function blobSha(content: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");
}

function lifecycleDetail(event: LifecycleEvent): Record<string, JsonValue> {
  if (
    typeof event.detail !== "object" ||
    event.detail === null ||
    Array.isArray(event.detail)
  ) {
    return {};
  }
  return event.detail;
}

async function optionalGithubFile(
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

async function optionalBranchSha(
  githubClient: GithubClient,
  input: Parameters<GithubClient["getRef"]>[0],
): Promise<string | undefined> {
  try {
    return (await githubClient.getRef(input)).sha;
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function resumedApplyUpdates({
  githubClient,
  owner,
  repo,
  branchSha,
  files,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly branchSha: string;
  readonly files: readonly SwapDiffFile[];
}): Promise<ApplyBranchUpdate[]> {
  const updates: ApplyBranchUpdate[] = [];
  for (const file of files) {
    const current = await optionalGithubFile(githubClient, {
      owner,
      repo,
      path: file.path,
      ref: branchSha,
    });
    if (current?.content === file.after) continue;
    if (current?.content !== file.before) {
      throw new ApplyServiceError(
        "apply_resume_state_mismatch",
        `Existing apply branch has an unrecognized touched-file state: ${file.path}`,
        { path: file.path },
      );
    }
    updates.push({ file, sha: current.sha });
  }
  return updates;
}

async function assertApplyBranchScope({
  githubClient,
  owner,
  repo,
  base,
  head,
  files,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly files: readonly SwapDiffFile[];
}): Promise<void> {
  const allowed = new Set(files.map(({ path }) => path));
  const comparison = await githubClient.compareCommits({
    owner,
    repo,
    base,
    head,
  });
  const unexpected = comparison.files
    .map(({ filename }) => filename)
    .filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new ApplyServiceError(
      "apply_branch_scope_mismatch",
      `Existing apply branch changed files outside its declared scope: ${unexpected.join(", ")}`,
      { paths: unexpected },
    );
  }
}

async function restoreApplyBranch({
  githubClient,
  owner,
  repo,
  branch,
  title,
  files,
  failedDigests,
}: {
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly files: readonly {
    readonly path: string;
    readonly before: string;
  }[];
  readonly failedDigests: FileDigestMap;
}): Promise<void> {
  const branchSha = await optionalBranchSha(githubClient, {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  if (branchSha === undefined) {
    return;
  }

  const currentFiles = new Map<string, GithubFileContent | undefined>();
  for (const file of files) {
    const current = await optionalGithubFile(githubClient, {
      owner,
      repo,
      path: file.path,
      ref: branchSha,
    });
    currentFiles.set(file.path, current);
    failedDigests[file.path] =
      current === undefined ? null : digestFileContent(current.contentBytes);
  }

  for (const file of files) {
    const current = currentFiles.get(file.path);
    if (current?.content === file.before) continue;
    await githubClient.createOrUpdateFile({
      owner,
      repo,
      path: file.path,
      message: `Restore after failed ${title}`,
      content: file.before,
      branch,
      ...(current === undefined ? {} : { sha: current.sha }),
    });
  }

  for (const file of files) {
    const restored = await optionalGithubFile(githubClient, {
      owner,
      repo,
      path: file.path,
      ref: branch,
    });
    if (restored?.content !== file.before) {
      throw new ApplyServiceError(
        "apply_restore_failed",
        `Apply failure did not restore ${file.path}`,
        { path: file.path },
      );
    }
  }
}

function applyStartMismatch(
  started: LifecycleEvent,
  remediation: RemediationLifecycleEvent,
): ApplyResult | null {
  let recorded: RemediationLifecycleEvent;
  try {
    recorded = remediationFromLifecycleDetail(started.detail);
  } catch (error) {
    return refusal(
      "apply_resume_state_mismatch",
      "The recorded apply start has malformed remediation evidence.",
      { message: error instanceof Error ? error.message : String(error) },
    );
  }
  if (
    recorded.evidence_id !== remediation.evidence_id ||
    recorded.repository_revision !== remediation.repository_revision ||
    canonicalJson(recorded.affected_files) !==
      canonicalJson(remediation.affected_files) ||
    canonicalJson(recorded.pre_apply_digests) !==
      canonicalJson(remediation.pre_apply_digests)
  ) {
    return refusal(
      "apply_resume_state_mismatch",
      "The recorded pre-apply state does not match the resumed remediation.",
      { eventId: started.eventId },
    );
  }
  return null;
}

async function staleDigestPaths(
  repoDir: string,
  swaps: readonly SwapRequest[],
): Promise<string[]> {
  const expectedByPath = new Map<string, Set<string>>();
  for (const { stepRecord } of swaps) {
    const path = stepRecord.callSite.path;
    const expected = expectedByPath.get(path) ?? new Set<string>();
    expected.add(stepRecord.contentHash);
    expectedByPath.set(path, expected);
  }

  const stale: string[] = [];
  for (const [path, expected] of [...expectedByPath].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    try {
      const content = (await readFile(join(repoDir, path), "utf8")).replaceAll(
        "\r\n",
        "\n",
      );
      const actual = createHash("sha256").update(content).digest("hex");
      if (expected.size !== 1 || !expected.has(actual)) stale.push(path);
    } catch {
      stale.push(path);
    }
  }
  return stale;
}

function recordedReviewers(
  events: readonly LifecycleEvent[],
  prNumber: number,
): ReviewerSet | null {
  const requested = [...events]
    .reverse()
    .find(
      (event) =>
        event.kind === "review_requested" && event.prNumber === prNumber,
    );
  const detail = requested === undefined ? undefined : requested.detail;
  if (
    typeof detail !== "object" ||
    detail === null ||
    Array.isArray(detail) ||
    !Array.isArray(detail.reviewers) ||
    !detail.reviewers.every((reviewer) => typeof reviewer === "string") ||
    !Array.isArray(detail.teamReviewers) ||
    !detail.teamReviewers.every((reviewer) => typeof reviewer === "string")
  ) {
    return null;
  }
  return {
    reviewers: detail.reviewers,
    teamReviewers: detail.teamReviewers,
  };
}

function existingPullRequest(
  events: readonly LifecycleEvent[],
  runSpecDigest: string,
):
  | {
      status: "existing";
      prNumber: number;
      branch?: string;
      title?: string;
      reviewerSet?: ReviewerSet;
    }
  | { status: "rejected"; prNumber: number; detail: JsonValue }
  | null {
  const matching = events.filter(
    (event) => event.runSpecDigest === runSpecDigest,
  );
  const terminal = [...matching]
    .reverse()
    .find(
      (event) =>
        event.kind === "pr_closed_rejected" || event.kind === "pr_merged",
    );
  if (terminal?.prNumber !== null && terminal?.prNumber !== undefined) {
    if (terminal.kind === "pr_closed_rejected") {
      return {
        status: "rejected",
        prNumber: terminal.prNumber,
        detail: terminal.detail,
      };
    }
    const opened = matching.find(
      (event) =>
        event.kind === "pr_opened" && event.prNumber === terminal.prNumber,
    );
    const detail =
      typeof opened?.detail === "object" &&
      opened.detail !== null &&
      !Array.isArray(opened.detail)
        ? opened.detail
        : undefined;
    if (
      opened === undefined ||
      typeof detail?.branch !== "string" ||
      typeof detail.title !== "string"
    ) {
      throw new Error(
        `Merged run ${runSpecDigest} has no complete pr_opened lifecycle fact`,
      );
    }
    const reviewerSet = recordedReviewers(matching, terminal.prNumber);
    return {
      status: "existing",
      prNumber: terminal.prNumber,
      branch: detail.branch,
      title: detail.title,
      ...(reviewerSet === null ? {} : { reviewerSet }),
    };
  }
  const opened = [...matching]
    .reverse()
    .find((event) => event.kind === "pr_opened" && event.prNumber !== null);
  if (opened === undefined || opened.prNumber === null) return null;
  const detail =
    typeof opened.detail === "object" &&
    opened.detail !== null &&
    !Array.isArray(opened.detail)
      ? opened.detail
      : {};
  return {
    status: "existing",
    prNumber: opened.prNumber,
    ...(typeof detail.branch === "string" ? { branch: detail.branch } : {}),
    ...(typeof detail.title === "string" ? { title: detail.title } : {}),
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

function lintRefusal(violations: readonly DiffViolation[]): ApplyResult {
  return refusal(
    "diff_lint_failed",
    "The proposed swap diff contains changes outside model identifiers.",
    { violations },
  );
}

function formatterRefusal(blocker: FormatterBlocker): ApplyResult {
  return refusal(
    "formatter_blocked",
    "The host formatter changed content outside the proposed model swap.",
    blocker,
  );
}

export async function applySwaps({
  store,
  repoDir,
  githubClient,
  owner,
  repo,
  conventions,
  verdicts,
  dryRun,
}: {
  readonly store: Store;
  readonly repoDir: string;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly repo: string;
  readonly conventions: CapturedConventions;
  readonly verdicts: readonly ApplyVerdict[];
  readonly dryRun: boolean;
}): Promise<ApplyResult> {
  if (conventions.warnings.length > 0) {
    return refusal(
      "host_conventions_unreadable",
      "One or more host repository instructions could not be read unambiguously.",
      { warnings: conventions.warnings },
    );
  }

  const selected = verdicts
    .filter(
      ({ verdict, cascadeStatus }) =>
        verdict.decision === "recommend" &&
        (cascadeStatus === "confirmed" || cascadeStatus === "not-required"),
    )
    .sort((left, right) =>
      compareText(left.verdict.familyId, right.verdict.familyId),
    );
  if (selected.length === 0) {
    return refusal(
      "no_confirmed_recommendation",
      "No recommended family has confirmed or not-required cascade evidence.",
    );
  }

  const failedGates = selected.flatMap(({ verdict, releaseGates }) =>
    releaseGates
      .filter(({ pass }) => !pass)
      .map(({ id, reason }) => ({ familyId: verdict.familyId, id, reason })),
  );
  if (failedGates.length > 0) {
    return refusal(
      "release_gate_failed",
      "At least one release gate is not green.",
      { gates: failedGates },
    );
  }

  const evidence = selected[0]!.evidence;
  const gatePolicyVersion = selected[0]!.verdict.gatePolicyVersion;
  const inconsistent = selected.some(
    ({ verdict, evidence: candidate }) =>
      candidate.revision !== evidence.revision ||
      candidate.corpusVersionId !== evidence.corpusVersionId ||
      verdict.gatePolicyVersion !== gatePolicyVersion,
  );
  if (inconsistent) {
    return refusal(
      "inconsistent_evidence",
      "Selected families do not share one evidence revision, corpus, and gate policy.",
    );
  }
  if (!isRepositoryRevision(evidence.revision)) {
    return refusal(
      "invalid_repository_revision",
      "The evidence repository revision must be a 40- or 64-character lowercase hex object ID.",
      { revision: evidence.revision },
    );
  }

  const repository = `${owner}/${repo}`;
  const runSpecDigest = computeRunSpecDigest({
    repo: repository,
    evidenceRevision: evidence.revision,
    swapSet: sortedSwapSet(selected),
    corpusVersionId: evidence.corpusVersionId,
  });
  const familyIds = selected.map(({ verdict }) => verdict.familyId);
  const branch = branchName(conventions, familyIds, runSpecDigest);
  const title = changeTitle(conventions, familyIds);
  const reviewerSet = reviewersFor(selected);
  const lifecycleEvents = await readRemediationLifecycleEvents(
    store,
    projectId,
  );
  const existing = existingPullRequest(lifecycleEvents, runSpecDigest);
  if (existing?.status === "rejected") {
    return refusal(
      "previously_rejected",
      "This evidence and swap set was previously rejected and requires new evidence before it can be proposed again.",
      { prNumber: existing.prNumber, rejection: existing.detail },
    );
  }
  if (existing !== null) {
    return {
      status: "existing",
      runSpecDigest,
      prNumber: existing.prNumber,
      branch: existing.branch ?? branch,
      title: existing.title ?? title,
      ...(existing.reviewerSet ?? reviewerSet),
    };
  }

  const head = await gitOutput(repoDir, ["rev-parse", "HEAD"]);
  if (head !== evidence.revision) {
    return refusal(
      "stale_evidence",
      "Evidence revision does not match the repository HEAD; re-prove before applying.",
      { evidenceRevision: evidence.revision, head, action: "re-prove" },
    );
  }
  const base = await gitOutput(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (base === "HEAD") {
    return refusal(
      "detached_head",
      "The target repository has no current branch for the pull request base.",
    );
  }
  const remoteBase = await githubClient.getRef({
    owner,
    repo,
    ref: `heads/${base}`,
  });
  if (remoteBase.sha !== evidence.revision) {
    return refusal(
      "stale_evidence",
      "The remote base moved beyond the evidence revision; re-prove before applying.",
      {
        evidenceRevision: evidence.revision,
        remoteRevision: remoteBase.sha,
        action: "re-prove",
      },
    );
  }

  const swaps = selected.flatMap(({ swaps }) => swaps);
  const staleDigests = await staleDigestPaths(repoDir, swaps);
  if (staleDigests.length > 0) {
    return refusal(
      "stale_location",
      "At least one proposed swap no longer matches its scan-time file digest.",
      { paths: staleDigests },
    );
  }
  const diffResults = buildSwapDiff({ repoDir, projectId, swaps });
  const stale = diffResults.flatMap((result) =>
    "reason" in result ? [result.path] : [],
  );
  if (
    selected.some(({ swaps: familySwaps }) => familySwaps.length === 0) ||
    stale.length > 0
  ) {
    return refusal(
      "stale_location",
      "At least one proposed swap no longer has one fresh source location.",
      { paths: stale },
    );
  }
  const files = diffResults as SwapDiffFile[];

  const lint = lintSwapDiff({ files: lintFiles(files) });
  if (!lint.pass) return lintRefusal(lint.violations);

  const formatted = await formatWithHostFormatter({
    repoDir,
    conventions,
    files,
  });
  if (formatted.blocker !== undefined) {
    return formatterRefusal(formatted.blocker);
  }
  const finalLint = lintSwapDiff({ files: lintFiles(formatted.files) });
  if (!finalLint.pass) return lintRefusal(finalLint.violations);

  if (
    reviewerSet.reviewers.length === 0 &&
    reviewerSet.teamReviewers.length === 0
  ) {
    return refusal(
      "no_requestable_reviewers",
      "No enriched owner can be requested through the GitHub review API.",
    );
  }

  if (dryRun) {
    return {
      status: "dry_run",
      runSpecDigest,
      branch,
      title,
      files: formatted.files.map(({ path }) => path),
      ...reviewerSet,
    };
  }

  const remediation = createAppliedRemediationLifecycleEvent({
    runSpecDigest,
    repositoryRevision: evidence.revision,
    files: formatted.files,
  });
  const lifecycle = {
    repo: repository,
    familyIds,
    evidence: {
      revision: evidence.revision,
      corpusVersionId: evidence.corpusVersionId,
      gatePolicyVersion,
    },
    runSpecDigest,
  } as const;
  const sortedFiles = [...formatted.files].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const started = [...lifecycleEvents]
    .reverse()
    .find(
      (event) =>
        event.runSpecDigest === runSpecDigest &&
        event.kind === "apply_started" &&
        lifecycleDetail(event).operation === "apply",
    );
  if (started !== undefined) {
    const mismatch = applyStartMismatch(started, remediation);
    if (mismatch !== null) return mismatch;
  }
  const existingBranchSha = await optionalBranchSha(githubClient, {
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  if (existingBranchSha !== undefined && started === undefined) {
    return refusal(
      "apply_branch_unowned",
      "The deterministic apply branch exists without a recorded apply start.",
      { branch },
    );
  }
  let resumedUpdates: ApplyBranchUpdate[] | undefined;
  try {
    if (existingBranchSha !== undefined) {
      await assertApplyBranchScope({
        githubClient,
        owner,
        repo,
        base: evidence.revision,
        head: existingBranchSha,
        files: sortedFiles,
      });
      resumedUpdates = await resumedApplyUpdates({
        githubClient,
        owner,
        repo,
        branchSha: existingBranchSha,
        files: sortedFiles,
      });
    }
  } catch (error) {
    if (error instanceof ApplyServiceError) {
      return refusal(error.code, error.message, error.detail);
    }
    throw error;
  }
  if (started === undefined) {
    await appendLifecycleEvent(store, {
      ...lifecycle,
      prNumber: null,
      kind: "apply_started",
      detail: { operation: "apply", branch, title, remediation },
    });
  }

  let pullRequest: GithubPullRequest;
  let ownsBranch = existingBranchSha !== undefined && started !== undefined;
  try {
    if (existingBranchSha === undefined) {
      await githubClient.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: evidence.revision,
      });
      ownsBranch = true;
    }
    const updates =
      resumedUpdates ??
      sortedFiles.map((file) => ({ file, sha: blobSha(file.before) }));
    for (const { file, sha } of updates) {
      await githubClient.createOrUpdateFile({
        owner,
        repo,
        path: file.path,
        message: title,
        content: file.after,
        branch,
        sha,
      });
    }
    await assertApplyBranchScope({
      githubClient,
      owner,
      repo,
      base: evidence.revision,
      head: branch,
      files: sortedFiles,
    });
    pullRequest =
      (await githubClient.findOpenPullRequest({
        owner,
        repo,
        head: branch,
        base,
      })) ??
      (await githubClient.createPullRequest({
        owner,
        repo,
        title,
        body: evidenceBody(conventions, selected),
        head: branch,
        base,
        draft: true,
      }));
  } catch (error) {
    const failedDigests: FileDigestMap = {
      ...(ownsBranch
        ? remediation.post_apply_digests
        : remediation.pre_apply_digests),
    };
    let restoreFailure: unknown;
    if (ownsBranch) {
      try {
        await restoreApplyBranch({
          githubClient,
          owner,
          repo,
          branch,
          title,
          files: sortedFiles,
          failedDigests,
        });
      } catch (caught) {
        restoreFailure = caught;
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    const failedRemediation = createRemediationLifecycleEvent({
      evidenceId: remediation.evidence_id,
      eventType: "apply_failed",
      actor: "rightmodeler",
      reason,
      repositoryRevision: evidence.revision,
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
        operation: "apply_failed",
        branch,
        title,
        remediation: failedRemediation,
      },
    });
    if (restoreFailure !== undefined) {
      if (restoreFailure instanceof ApplyServiceError) throw restoreFailure;
      throw new ApplyServiceError(
        "apply_restore_failed",
        `Apply failure restoration failed: ${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)}`,
        { branch },
      );
    }
    if (error instanceof ApplyServiceError) {
      return refusal(error.code, error.message, error.detail);
    }
    throw new Error(
      ownsBranch ? `${reason}; pre-apply files were restored` : reason,
      {
        cause: error,
      },
    );
  }
  await appendLifecycleEvent(store, {
    ...lifecycle,
    prNumber: pullRequest.number,
    kind: "pr_opened",
    detail: { operation: "apply", branch, title, remediation },
  });

  await githubClient.requestReviewers({
    owner,
    repo,
    pullNumber: pullRequest.number,
    reviewers: reviewerSet.reviewers,
    teamReviewers: reviewerSet.teamReviewers,
  });
  await appendLifecycleEvent(store, {
    ...lifecycle,
    prNumber: pullRequest.number,
    kind: "review_requested",
    detail: {
      reviewers: [...reviewerSet.reviewers],
      teamReviewers: [...reviewerSet.teamReviewers],
    },
  });

  return {
    status: "applied",
    runSpecDigest,
    prNumber: pullRequest.number,
    branch,
    title,
    ...reviewerSet,
  };
}
