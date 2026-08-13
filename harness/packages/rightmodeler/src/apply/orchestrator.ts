import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalJson,
  computeRunSpecDigest,
  factKey,
  factSchema,
  factsPrefix,
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
import type { GithubClient } from "../github/index.js";
import { buildSwapDiff, type SwapDiffFile, type SwapRequest } from "./diff.js";
import { lintSwapDiff, type DiffViolation } from "./difflint.js";
import { formatWithHostFormatter, type FormatterBlocker } from "./format.js";

const execFileAsync = promisify(execFile);
const projectId = "project";
const reviewerLimit = 5;
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
  | "stale_evidence"
  | "detached_head"
  | "stale_location"
  | "diff_lint_failed"
  | "formatter_blocked"
  | "host_conventions_unreadable"
  | "no_requestable_reviewers";

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
      return `| ${escapeCell(verdict.familyId)} | ${verdict.decision} | ${escapeCell(evaluators)} | ${cascadeStatus} | ${percent(verdict.worstCaseBound)} | ${escapeCell(renderedCaps || "none")} | ${caseIds.map((caseId) => `\`${caseId}\``).join(", ")} |`;
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
  ].slice(0, reviewerLimit);
  return {
    reviewers: unique.flatMap(({ kind, value }) =>
      kind === "user" ? [value] : [],
    ),
    teamReviewers: unique.flatMap(({ kind, value }) =>
      kind === "team" ? [value] : [],
    ),
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

async function readLifecycleEvents(store: Store): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  for (const key of await store.list(factsPrefix(projectId))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing listed fact: ${key}`);
    const value: unknown = JSON.parse(Buffer.from(entry.body).toString("utf8"));
    const fact = factSchema.parse(value);
    const lifecycle = lifecycleEventSchema.safeParse(fact);
    if (lifecycle.success) events.push(lifecycle.data);
  }
  return events.sort(
    (left, right) =>
      compareText(left.createdAt, right.createdAt) ||
      lifecycleKindOrder[left.kind] - lifecycleKindOrder[right.kind] ||
      compareText(left.eventId, right.eventId),
  );
}

function openPullRequest(
  events: readonly LifecycleEvent[],
  runSpecDigest: string,
): { prNumber: number; branch?: string; title?: string } | null {
  const matching = events.filter(
    (event) => event.runSpecDigest === runSpecDigest,
  );
  const terminalPulls = new Set(
    matching.flatMap((event) =>
      event.prNumber !== null &&
      (event.kind === "pr_closed_rejected" || event.kind === "pr_merged")
        ? [event.prNumber]
        : [],
    ),
  );
  const opened = [...matching]
    .reverse()
    .find(
      (event) =>
        event.kind === "pr_opened" &&
        event.prNumber !== null &&
        !terminalPulls.has(event.prNumber),
    );
  if (opened === undefined || opened.prNumber === null) return null;
  const detail =
    typeof opened.detail === "object" &&
    opened.detail !== null &&
    !Array.isArray(opened.detail)
      ? opened.detail
      : {};
  return {
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
  const existing = openPullRequest(
    await readLifecycleEvents(store),
    runSpecDigest,
  );
  if (existing !== null) {
    return {
      status: "existing",
      runSpecDigest,
      prNumber: existing.prNumber,
      branch: existing.branch ?? branch,
      title: existing.title ?? title,
      ...reviewerSet,
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

  if (conventions.warnings.length > 0) {
    return refusal(
      "host_conventions_unreadable",
      "One or more host repository instructions could not be read unambiguously.",
      { warnings: conventions.warnings },
    );
  }

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
  await appendLifecycleEvent(store, {
    ...lifecycle,
    prNumber: null,
    kind: "apply_started",
    detail: { branch, title },
  });

  await githubClient.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: evidence.revision,
  });
  for (const file of [...formatted.files].sort((left, right) =>
    compareText(left.path, right.path),
  )) {
    await githubClient.createOrUpdateFile({
      owner,
      repo,
      path: file.path,
      message: title,
      content: file.after,
      branch,
      sha: blobSha(file.before),
    });
  }
  const pullRequest = await githubClient.createPullRequest({
    owner,
    repo,
    title,
    body: evidenceBody(conventions, selected),
    head: branch,
    base,
    draft: true,
  });
  await appendLifecycleEvent(store, {
    ...lifecycle,
    prNumber: pullRequest.number,
    kind: "pr_opened",
    detail: { branch, title },
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
