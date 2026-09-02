import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  appendLifecycleEvent,
  canonicalJson,
  compareText,
  computeRunSpecDigest,
  jsonValueSchema,
  lifecycleDetail,
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
  GithubHttpError,
  type GithubPullRequest,
} from "../github/index.js";
import {
  optionalFile,
  optionalRef,
  restoreBranch,
} from "../github/branch-ops.js";
import {
  escapeCell,
  formatDeltaPct,
  formatLatencyMs,
  formatUsdPerCase,
  percent,
} from "../report/format.js";
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
  readonly receipts: {
    readonly winnerCostPerCaseUsd: number | null;
    readonly incumbentCostPerCaseUsd: number | null;
    readonly costDeltaPct: number | null;
    readonly winnerLatencyP50Ms: number | null;
  };
}

export type ApplyRefusalCode =
  | "no_confirmed_recommendation"
  | "release_gate_failed"
  | "inconsistent_evidence"
  | "previously_rejected"
  | "stale_evidence"
  | "detached_head"
  | "dirty_worktree"
  | "stale_location"
  | "diff_lint_failed"
  | "formatter_blocked"
  | "host_conventions_unreadable"
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

interface EvidenceRow {
  readonly family: string;
  readonly decision: string;
  readonly evaluatorKinds: string;
  readonly cascade: string;
  readonly worstCaseBound: string;
  readonly from: string;
  readonly to: string;
  readonly incumbentCostPerCase: string;
  readonly winnerCostPerCase: string;
  readonly delta: string;
  readonly p50Latency: string;
  readonly caps: string;
  readonly caseIds: string;
}

const evidenceColumns = [
  ["Family", "family"],
  ["Decision", "decision"],
  ["Evaluator kinds", "evaluatorKinds"],
  ["Cascade", "cascade"],
  ["Worst-case bound", "worstCaseBound"],
  ["From", "from"],
  ["To", "to"],
  ["Incumbent $/case", "incumbentCostPerCase"],
  ["Winner $/case", "winnerCostPerCase"],
  ["Delta", "delta"],
  ["p50 latency", "p50Latency"],
  ["Caps", "caps"],
  ["Case IDs", "caseIds"],
] as const satisfies readonly (readonly [string, keyof EvidenceRow])[];

function evidenceRow({
  verdict,
  cascadeStatus,
  caps,
  swaps,
  receipts,
}: ApplyVerdict): EvidenceRow {
  const evaluators = verdict.evaluatorKinds
    .map(({ evaluatorKind }) => evaluatorKind)
    .join(", ");
  const renderedCaps = caps
    .map(({ name, value }) => `${name}: ${value}`)
    .join("; ");
  const caseIds = verdict.caseIds.filter((caseId) =>
    caseIdPattern.test(caseId),
  );
  const renderedCaseIds = caseIds.slice(0, 5).map((caseId) => `\`${caseId}\``);
  if (caseIds.length > 5) {
    renderedCaseIds.push(`and ${caseIds.length - 5} more`);
  }
  const invalidCaseIds = verdict.caseIds.length - caseIds.length;
  if (invalidCaseIds > 0) {
    renderedCaseIds.push(
      `${invalidCaseIds} invalid case ID${invalidCaseIds === 1 ? "" : "s"} omitted`,
    );
  }
  return {
    family: escapeCell(verdict.familyId),
    decision: verdict.decision,
    evaluatorKinds: escapeCell(evaluators),
    cascade: cascadeStatus,
    worstCaseBound: percent(verdict.worstCaseBound),
    from: `\`${escapeCell(swaps[0]!.fromModel)}\``,
    to: `\`${escapeCell(swaps[0]!.toModel)}\``,
    incumbentCostPerCase: formatUsdPerCase(receipts.incumbentCostPerCaseUsd),
    winnerCostPerCase: formatUsdPerCase(receipts.winnerCostPerCaseUsd),
    delta: formatDeltaPct(receipts.costDeltaPct),
    p50Latency: formatLatencyMs(receipts.winnerLatencyP50Ms),
    caps: escapeCell(renderedCaps || "none"),
    caseIds: renderedCaseIds.join(", "),
  };
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
    `| ${evidenceColumns.map(([heading]) => heading).join(" | ")} |`,
    `| ${evidenceColumns.map(() => "---").join(" | ")} |`,
    ...verdicts.map((entry) => {
      const row = evidenceRow(entry);
      return `| ${evidenceColumns.map(([, field]) => row[field]).join(" | ")} |`;
    }),
    "",
    "Costs are dollars per replayed case. `n/a` means the number is not in the store: the replayed case carries no recorded token usage, the catalog publishes no price for the incumbent model, or no attempt recorded a duration.",
    "Case IDs are SHA-256 digests of the replayed case, not file paths.",
    "",
  ].join("\n");
  const template = conventions.prTemplate?.trimEnd();
  return template === undefined || template === null || template === ""
    ? table
    : `${template}\n\n${table}`;
}

async function reviewersFor(
  githubClient: GithubClient,
  owner: string,
  repo: string,
  verdicts: readonly ApplyVerdict[],
): Promise<ReviewerSet & { readonly unresolvedOwners: number }> {
  const owners = [
    ...new Map(
      verdicts
        .flatMap(({ blastRadius }) => blastRadius.owners)
        .map((rankedOwner) => [rankedOwner.handle, rankedOwner] as const),
    ).values(),
  ].sort((left, right) => compareText(left.handle, right.handle));
  const selected: ReviewIdentity[] = [];
  let unresolvedOwners = 0;
  for (const { handle, source } of owners) {
    if (handle.startsWith("@")) {
      const identity = handle.slice(1);
      const slash = identity.indexOf("/");
      selected.push(
        slash === -1
          ? { kind: "user", value: identity }
          : { kind: "team", value: identity.slice(slash + 1) },
      );
      continue;
    }
    const noreply =
      /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/.exec(handle);
    if (noreply !== null) {
      selected.push({ kind: "user", value: noreply[1]! });
      continue;
    }
    if (source === "blame") {
      const login = await githubClient.findCommitAuthorLogin({
        owner,
        repo,
        email: handle,
      });
      if (login !== null) {
        selected.push({ kind: "user", value: login });
        continue;
      }
    }
    unresolvedOwners += 1;
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
    unresolvedOwners,
  };
}

async function gitOutput(repoDir: string, args: readonly string[]) {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function dirtySwapPaths(
  repoDir: string,
  paths: readonly string[],
): Promise<string[]> {
  const dirty: string[] = [];
  for (const path of paths) {
    try {
      await execFileAsync(
        "git",
        ["-C", repoDir, "diff", "--quiet", "HEAD", "--", path],
        { encoding: "utf8" },
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      ) {
        dirty.push(path);
        continue;
      }
      throw error;
    }
  }
  return dirty;
}

function committedBlobSha(repoDir: string, path: string): Promise<string> {
  return gitOutput(repoDir, ["rev-parse", `HEAD:${path}`]);
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
    const current = await optionalFile(githubClient, {
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
    return {
      status: "existing",
      prNumber: terminal.prNumber,
      branch: detail.branch,
      title: detail.title,
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

async function ensureReviewRequested({
  githubClient,
  store,
  lifecycle,
  owner,
  repo,
  events,
  prNumber,
  reviewerSet,
}: {
  readonly githubClient: GithubClient;
  readonly store: Store;
  readonly lifecycle: Pick<
    LifecycleEvent,
    "repo" | "familyIds" | "evidence" | "runSpecDigest"
  >;
  readonly owner: string;
  readonly repo: string;
  readonly events: readonly LifecycleEvent[];
  readonly prNumber: number;
  readonly reviewerSet: ReviewerSet & { readonly unresolvedOwners: number };
}): Promise<ReviewerSet> {
  const recorded = recordedReviewers(events, prNumber);
  if (recorded !== null) return recorded;

  const author = await githubClient.getAuthenticatedUserLogin();
  let reviewers = reviewerSet.reviewers.filter(
    (reviewer) => reviewer.toLowerCase() !== author.toLowerCase(),
  );
  let teamReviewers = reviewerSet.teamReviewers;
  if (reviewers.length > 0 || teamReviewers.length > 0) {
    try {
      await githubClient.requestReviewers({
        owner,
        repo,
        pullNumber: prNumber,
        reviewers,
        teamReviewers,
      });
    } catch (error) {
      if (!(error instanceof GithubHttpError) || error.status !== 422) {
        throw error;
      }
      const granted: string[] = [];
      let teamReviewersGranted = false;
      for (const reviewer of reviewers) {
        try {
          await githubClient.requestReviewers({
            owner,
            repo,
            pullNumber: prNumber,
            reviewers: [reviewer],
            teamReviewers,
          });
          granted.push(reviewer);
          teamReviewersGranted = true;
        } catch (reviewerError) {
          if (
            !(reviewerError instanceof GithubHttpError) ||
            reviewerError.status !== 422
          ) {
            throw reviewerError;
          }
        }
      }
      reviewers = granted;
      if (!teamReviewersGranted) teamReviewers = [];
    }
  }
  const requested = reviewers.length > 0 || teamReviewers.length > 0;
  await appendLifecycleEvent(store, projectId, {
    ...lifecycle,
    prNumber,
    kind: "review_requested",
    detail: {
      reviewers: [...reviewers],
      teamReviewers: [...teamReviewers],
      unresolvedOwners: reviewerSet.unresolvedOwners,
      ...(requested ? {} : { reason: "no_requestable_reviewers" }),
    },
  });
  return { reviewers, teamReviewers };
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
  const branch = branchName(conventions, familyIds, runSpecDigest);
  const title = changeTitle(conventions, familyIds);
  const reviewerSet = await reviewersFor(githubClient, owner, repo, selected);
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
    const requestedReviewers = await ensureReviewRequested({
      githubClient,
      store,
      lifecycle,
      owner,
      repo,
      events: lifecycleEvents,
      prNumber: existing.prNumber,
      reviewerSet,
    });
    return {
      status: "existing",
      runSpecDigest,
      prNumber: existing.prNumber,
      branch: existing.branch ?? branch,
      title: existing.title ?? title,
      ...requestedReviewers,
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
  const swapPaths = [
    ...new Set(swaps.map(({ stepRecord }) => stepRecord.callSite.path)),
  ].sort(compareText);
  const dirty = await dirtySwapPaths(repoDir, swapPaths);
  if (dirty.length > 0) {
    return refusal(
      "dirty_worktree",
      "At least one file the swap touches has uncommitted changes; commit or stash them before applying.",
      { paths: dirty },
    );
  }
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

  if (dryRun) {
    return {
      status: "dry_run",
      runSpecDigest,
      branch,
      title,
      files: formatted.files.map(({ path }) => path),
      reviewers: reviewerSet.reviewers,
      teamReviewers: reviewerSet.teamReviewers,
    };
  }

  const remediation = createAppliedRemediationLifecycleEvent({
    runSpecDigest,
    repositoryRevision: evidence.revision,
    files: formatted.files,
  });
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
  const existingBranchSha = (
    await optionalRef(githubClient, {
      owner,
      repo,
      ref: `heads/${branch}`,
    })
  )?.sha;
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
    await appendLifecycleEvent(store, projectId, {
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
      (await Promise.all(
        sortedFiles.map(async (file) => ({
          file,
          sha: await committedBlobSha(repoDir, file.path),
        })),
      ));
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
        await restoreBranch({
          githubClient,
          owner,
          repo,
          branch,
          title,
          files: sortedFiles.map(({ path, before }) => ({
            path,
            content: before,
            contentBytes: Buffer.from(before, "utf8"),
          })),
          failedDigests,
          unrestored: (path) =>
            new ApplyServiceError(
              "apply_restore_failed",
              `Apply failure did not restore ${path}`,
              { path },
            ),
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
    await appendLifecycleEvent(store, projectId, {
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
  await appendLifecycleEvent(store, projectId, {
    ...lifecycle,
    prNumber: pullRequest.number,
    kind: "pr_opened",
    detail: { operation: "apply", branch, title, remediation },
  });

  const requestedReviewers = await ensureReviewRequested({
    githubClient,
    store,
    lifecycle,
    owner,
    repo,
    events: lifecycleEvents,
    prNumber: pullRequest.number,
    reviewerSet,
  });

  return {
    status: "applied",
    runSpecDigest,
    prNumber: pullRequest.number,
    branch,
    title,
    ...requestedReviewers,
  };
}
