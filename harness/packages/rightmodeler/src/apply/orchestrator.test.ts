import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJson,
  computeRunSpecDigest,
  factKey,
  factsPrefix,
  FsStore,
  lifecycleEventSchema,
  type LifecycleEvent,
  type StepRecord,
  type Store,
} from "@rightmodeler/core";
import {
  GATE_IDS,
  type EvaluatorKindVerdict,
  type FamilyVerdict,
  type GateResult,
} from "@rightmodeler/kernel";
import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  blastRadius,
  captureConventions,
  type CapturedConventions,
  type FamilyBlastRadius,
} from "../enrich/index.js";
import { executeCli } from "../cli.js";
import {
  createGithubClient,
  type GithubClient,
  GithubHttpError,
} from "../github/index.js";
import {
  applySwaps,
  type ApplyCascadeStatus,
  type ApplyResult,
  type ApplyVerdict,
} from "./orchestrator.js";
import {
  createRemediationLifecycleEvent,
  delegatedCiValidationReason,
  digestFileContent,
  remediationFromLifecycleDetail,
} from "./remediation.js";
import { rollbackPreparedSwaps, type RollbackResult } from "../rollback.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../../../../", import.meta.url)),
);
const fixtureRoot = join(repositoryRoot, "harness/fixtures/demo-app");
const sourcePath = "src/summarize.ts";
const owner = "acme";
const repo = "demo";
const repository = { owner, repo } as const;
const tokenEnv = "RIGHTMODELER_APPLY_GITHUB_TOKEN";
const token = "apply-orchestrator-stub-token";
const caseContentMarker = "PRIVATE_CASE_CONTENT_MUST_NOT_REACH_THE_PR";
const caseIds = ["3".repeat(64), "a".repeat(64)] as const;

const stubModuleUrl = new URL(
  "../../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;

interface StubHit {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly authorized: boolean;
}

interface StubServer {
  readonly port: number;
  getHits(): readonly StubHit[];
  close(): Promise<void>;
}

interface StubModule {
  startGithubStub(options: {
    readonly port: number;
    readonly token?: string;
  }): Promise<StubServer>;
}

interface TestHarness {
  readonly root: string;
  readonly repoDir: string;
  readonly head: string;
  readonly store: FsStore;
  readonly stub: StubServer;
  readonly githubClient: GithubClient;
  readonly stepRecord: StepRecord;
  readonly conventions: CapturedConventions;
  readonly blastRadius: FamilyBlastRadius;
}

const temporaryDirectories: string[] = [];
const openStubs: StubServer[] = [];

afterEach(async () => {
  delete process.env[tokenEnv];
  await Promise.all(openStubs.splice(0).map((stub) => stub.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function control<T>(
  stub: StubServer,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${stub.port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Test control ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function startStub(): Promise<StubServer> {
  const module = (await import(stubModuleUrl)) as StubModule;
  const stub = await module.startGithubStub({ port: 0, token });
  openStubs.push(stub);
  return stub;
}

function githubWrites(stub: StubServer): readonly StubHit[] {
  return stub
    .getHits()
    .filter(
      ({ method, path }) =>
        !path.startsWith("/__test/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(method),
    );
}

function pullCreationHits(stub: StubServer): readonly StubHit[] {
  return stub
    .getHits()
    .filter(
      ({ method, path }) =>
        method === "POST" && path === `/repos/${owner}/${repo}/pulls`,
    );
}

function evaluatorKind(
  kind: string,
  worstCaseBound: number,
): EvaluatorKindVerdict {
  return {
    evaluatorKind: kind,
    conditionalExecutions: 20,
    passes: 19,
    trials: 20,
    passRate: 0.95,
    averageScore: 0.96,
    nTrajectories: 20,
    nDistinctSteps: 2,
    excludedExecutions: 0,
    excludedFraction: 0,
    assessmentAbsent: 0,
    assessmentAbsentReasons: [],
    worstCasePassRate: 0.95,
    worstCaseBound,
    naiveInterval: { point: 0.95, lower: worstCaseBound, upper: 0.99 },
    trajectoryClusters: [
      { trajectoryId: `${kind}-trajectory`, passes: 19, trials: 20 },
    ],
  };
}

function verdictFor(
  stepRecord: StepRecord,
  decision: "recommend" | "reject" = "recommend",
): FamilyVerdict {
  const common = {
    evidenceQuestionId: "evidence-question-1",
    corpusSplit: "holdout",
    familyId: stepRecord.family,
    candidateId: "acme/small-1",
    candidateFamily: "acme-small",
    caseIds: [...caseIds, caseContentMarker],
    candidateCostUsd: 0.001,
    gatePolicyVersion: "gate-policy-7",
    referenceCeilingMultiplier: 1,
    evaluatorKinds: [
      evaluatorKind("deterministic", 0.93),
      evaluatorKind("judge", 0.91),
    ],
    weakestEvaluatorKind: "judge",
    nExecutions: 20,
    nReviewTrials: 20,
    nTrajectories: 20,
    nDistinctSteps: 2,
    excludedExecutions: 0,
    excludedFraction: 0,
    assessmentAbsent: 0,
    assessmentAbsentReasons: [],
    worstCaseBound: 0.91,
    naiveInterval: { point: 0.95, lower: 0.91, upper: 0.99 },
    availability: {
      availableExecutions: 20,
      executions: 20,
      rate: 1,
      lowerBound: 0.9,
      naiveInterval: { point: 1, lower: 0.9, upper: 1 },
    },
    unsafeSubstitutions: 0,
    coveredEvidenceCases: 20,
    requiredAbstentions: 0,
    satisfiedRequiredAbstentions: 0,
  } as const;
  return decision === "recommend"
    ? { ...common, decision: "recommend" }
    : { ...common, decision: "reject" };
}

function greenGates(): readonly GateResult[] {
  return GATE_IDS.map((id) => ({ id, pass: true, reason: `${id} passed` }));
}

function applyVerdict(
  harness: TestHarness,
  options: {
    readonly decision?: "recommend" | "reject";
    readonly cascadeStatus?: ApplyCascadeStatus;
    readonly releaseGates?: readonly GateResult[];
    readonly toModel?: string;
    readonly contentHash?: string;
  } = {},
): ApplyVerdict {
  const stepRecord: StepRecord = {
    ...harness.stepRecord,
    ...(options.contentHash === undefined
      ? {}
      : { contentHash: options.contentHash }),
    analysisHistory: [
      ...harness.stepRecord.analysisHistory,
      { caseContent: caseContentMarker },
    ],
  };
  if (stepRecord.currentModel === null) {
    throw new Error("Fixture step must have a current model");
  }
  return {
    verdict: verdictFor(stepRecord, options.decision),
    releaseGates: options.releaseGates ?? greenGates(),
    cascadeStatus: options.cascadeStatus ?? "confirmed",
    evidence: {
      revision: harness.head,
      corpusVersionId: "corpus-version-9",
    },
    swaps: [
      {
        stepRecord,
        fromModel: stepRecord.currentModel,
        toModel: options.toModel ?? "acme/small-1",
      },
    ],
    blastRadius: harness.blastRadius,
    caps: [
      { name: "top-N shortlist", value: 3 },
      { name: "confirm max run sets", value: 8 },
    ],
  };
}

async function createHarness(): Promise<TestHarness> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-apply-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  await cp(fixtureRoot, repoDir, { recursive: true });
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["add", "."]);
  await git(repoDir, [
    "-c",
    "user.name=Fixture Author",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "feat: seed demo application",
  ]);
  const head = await git(repoDir, ["rev-parse", "HEAD"]);
  const scanned = scan(repoDir, createMatcherRegistry(), "project").find(
    ({ callSite }) => callSite.path === sourcePath,
  );
  if (scanned === undefined) {
    throw new Error(`Scanner did not find ${sourcePath}`);
  }
  const conventions = await captureConventions({ repoDir });
  const ownerHandles = [
    "@acme/platform",
    "@alpha",
    "@alpha",
    "@bravo",
    "@charlie",
    "@delta",
    "@echo",
    "owner@example.com",
  ] as const;
  const blast = blastRadius({
    stepRecords: [scanned],
    verdicts: [{ familyId: scanned.family, decision: "recommend" }],
    owners: [
      {
        path: scanned.callSite.path,
        owners: ownerHandles.map((handle) => ({
          handle,
          source: handle.includes("@example.com")
            ? ("blame" as const)
            : ("codeowners" as const),
        })),
      },
    ],
  })[0];
  if (blast === undefined) throw new Error("Fixture blast radius is empty");

  process.env[tokenEnv] = token;
  const stub = await startStub();
  await control(stub, "/__test/seed", {
    ...repository,
    defaultBranch: "main",
    sha: head,
    tree: {
      src: {
        "summarize.ts": await readFile(join(repoDir, sourcePath), "utf8"),
      },
    },
  });
  const githubClient = createGithubClient({
    baseUrl: `http://127.0.0.1:${stub.port}`,
    tokenEnv,
  });
  return {
    root,
    repoDir,
    head,
    store: new FsStore(join(root, "store")),
    stub,
    githubClient,
    stepRecord: scanned,
    conventions,
    blastRadius: blast,
  };
}

async function runApply(
  harness: TestHarness,
  verdicts: readonly ApplyVerdict[],
  dryRun = false,
  githubClient: GithubClient = harness.githubClient,
): Promise<ApplyResult> {
  return applySwaps({
    store: harness.store,
    repoDir: harness.repoDir,
    githubClient,
    ...repository,
    conventions: harness.conventions,
    verdicts,
    dryRun,
  });
}

async function runRollback(
  harness: TestHarness,
  prNumber: number,
  githubClient: GithubClient = harness.githubClient,
): Promise<RollbackResult> {
  return rollbackPreparedSwaps({
    store: harness.store,
    githubClient,
    ...repository,
    prNumber,
  });
}

async function runRollbackCli(
  harness: TestHarness,
  prNumber: number,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const code = await executeCli(
    [
      "--repo",
      join(harness.root, "demo"),
      "--store",
      harness.store.root,
      "--output",
      "json",
      "rollback",
      "--owner",
      owner,
      "--pr",
      String(prNumber),
      "--github-base-url",
      `http://127.0.0.1:${harness.stub.port}`,
      "--github-token-env",
      tokenEnv,
    ],
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  return { code, stdout, stderr };
}

function requireApplied(result: ApplyResult) {
  if (result.status !== "applied") {
    throw new Error(`Expected applied result, received ${result.status}`);
  }
  return result;
}

function requireRefused(result: ApplyResult) {
  if (result.status !== "refused") {
    throw new Error(`Expected refused result, received ${result.status}`);
  }
  return result;
}

function requireRolledBack(result: RollbackResult) {
  if (result.status !== "rolled_back") {
    throw new Error(`Expected rolled_back result, received ${result.status}`);
  }
  return result;
}

function requireRollbackRefused(result: RollbackResult) {
  if (result.status !== "refused") {
    throw new Error(`Expected refused result, received ${result.status}`);
  }
  return result;
}

async function lifecycleEvents(store: FsStore): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  for (const key of await store.list(factsPrefix("project"))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing listed fact ${key}`);
    const value: unknown = JSON.parse(Buffer.from(entry.body).toString("utf8"));
    events.push(lifecycleEventSchema.parse(value));
  }
  return events;
}

describe("applySwaps", () => {
  it("opens a convention-shaped draft PR, commits the swap, requests capped owners, and records its lifecycle", async () => {
    const harness = await createHarness();

    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );

    expect(applied.branch).toMatch(
      /^rightmodeler\/swap-[a-z0-9._-]+-[a-f0-9]{8}$/,
    );
    expect(applied.title).toBe(
      `perf(models): swap ${harness.stepRecord.family}`,
    );
    expect(applied.reviewers).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
    ]);
    expect(applied.teamReviewers).toEqual(["platform"]);

    await expect(
      harness.githubClient.getRef({
        ...repository,
        ref: `heads/${applied.branch}`,
      }),
    ).resolves.toEqual({
      ref: `refs/heads/${applied.branch}`,
      sha: expect.not.stringMatching(new RegExp(`^${harness.head}$`)),
    });
    await expect(
      harness.githubClient.compareCommits({
        ...repository,
        base: "main",
        head: applied.branch,
      }),
    ).resolves.toMatchObject({
      status: "ahead",
      aheadBy: 1,
      files: [{ filename: sourcePath, status: "modified" }],
    });

    const pull = await harness.githubClient.getPullRequest({
      ...repository,
      pullNumber: applied.prNumber,
    });
    expect(pull).toMatchObject({
      state: "open",
      draft: true,
      title: applied.title,
      head: { ref: applied.branch },
      base: { ref: "main", sha: harness.head },
      requestedReviewers: applied.reviewers,
      requestedTeams: applied.teamReviewers,
    });
    expect(pull.body).toContain("## Summary");
    expect(pull.body).toContain("Describe the model swap");
    expect(pull.body).toContain("## Rightmodeler evidence");
    expect(pull.body).toContain("deterministic, judge");
    expect(pull.body).toContain("confirmed");
    expect(pull.body).toContain("91.0%");
    expect(pull.body).toContain("top-N shortlist: 3");
    expect(pull.body).toContain("confirm max run sets: 8");
    expect(pull.body).toContain("corpus-version-9");
    for (const caseId of caseIds) expect(pull.body).toContain(caseId);
    expect(pull.body).not.toContain(caseContentMarker);
    expect(pull.body).toContain("1 invalid case ID omitted");

    expect(
      harness.stub
        .getHits()
        .filter(
          ({ method, path }) => method === "PUT" && path.includes("/contents/"),
        ),
    ).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          message: applied.title,
          branch: applied.branch,
        }),
      }),
    ]);
    const events = await lifecycleEvents(harness.store);
    expect(events).toHaveLength(3);
    expect(events.map(({ kind }) => kind).sort()).toEqual([
      "apply_started",
      "pr_opened",
      "review_requested",
    ]);
    expect(
      events.every(
        ({ runSpecDigest }) => runSpecDigest === applied.runSpecDigest,
      ),
    ).toBe(true);
    expect(
      events.find(({ kind }) => kind === "apply_started")?.prNumber,
    ).toBeNull();
    expect(
      events
        .filter(({ kind }) => kind !== "apply_started")
        .every(({ prNumber }) => prNumber === applied.prNumber),
    ).toBe(true);
    const opened = events.find(({ kind }) => kind === "pr_opened");
    if (opened === undefined) throw new Error("Missing pr_opened event");
    const remediation = remediationFromLifecycleDetail(opened.detail);
    const before = await readFile(join(harness.repoDir, sourcePath), "utf8");
    const after = await harness.githubClient.getFileContent({
      ...repository,
      path: sourcePath,
      ref: applied.branch,
    });
    expect(remediation).toMatchObject({
      event_type: "applied",
      evidence_id: `sha256:${applied.runSpecDigest}`,
      repository_revision: harness.head,
      affected_files: [sourcePath],
      pre_apply_digests: { [sourcePath]: digestFileContent(before) },
      post_apply_digests: {
        [sourcePath]: digestFileContent(after.contentBytes),
      },
      reason: delegatedCiValidationReason,
      restored: false,
    });
    const started = events.find(({ kind }) => kind === "apply_started");
    if (started === undefined) throw new Error("Missing apply_started event");
    expect(
      remediationFromLifecycleDetail(started.detail).pre_apply_digests,
    ).toEqual(remediation.pre_apply_digests);
  });

  it.each([
    {
      name: "a rejected verdict",
      decision: "reject" as const,
      cascadeStatus: "confirmed" as const,
    },
    {
      name: "an unconfirmed recommendation",
      decision: "recommend" as const,
      cascadeStatus: "blocked" as const,
    },
  ])("refuses gate (a) for $name", async ({ decision, cascadeStatus }) => {
    const harness = await createHarness();

    const refused = requireRefused(
      await runApply(harness, [
        applyVerdict(harness, { decision, cascadeStatus }),
      ]),
    );

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "no_confirmed_recommendation",
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
    expect(await lifecycleEvents(harness.store)).toEqual([]);
  });

  it("refuses gate (b) when a release gate is not green", async () => {
    const harness = await createHarness();
    const gates = greenGates().map((gate) =>
      gate.id === "quality"
        ? { ...gate, pass: false, reason: "quality lower bound missed" }
        : gate,
    );

    const refused = requireRefused(
      await runApply(harness, [applyVerdict(harness, { releaseGates: gates })]),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "release_gate_failed",
        detail: {
          gates: [
            {
              familyId: harness.stepRecord.family,
              id: "quality",
              reason: "quality lower bound missed",
            },
          ],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses inconsistent evidence across selected families", async () => {
    const harness = await createHarness();
    const first = applyVerdict(harness);
    const second = {
      ...applyVerdict(harness),
      evidence: { ...first.evidence, corpusVersionId: "different-corpus" },
    };

    const refused = requireRefused(await runApply(harness, [first, second]));

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "inconsistent_evidence",
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses a detached target HEAD", async () => {
    const harness = await createHarness();
    await git(harness.repoDir, ["checkout", "--detach"]);

    const refused = requireRefused(
      await runApply(harness, [applyVerdict(harness)]),
    );

    expect(refused.reasons.map(({ code }) => code)).toEqual(["detached_head"]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses unreadable host conventions before selecting a swap", async () => {
    const harness = await createHarness();
    const conventions: CapturedConventions = {
      ...harness.conventions,
      warnings: [{ name: "instruction_file_unreadable", path: "AGENTS.md" }],
    };

    const refused = requireRefused(
      await applySwaps({
        store: harness.store,
        repoDir: harness.repoDir,
        githubClient: harness.githubClient,
        ...repository,
        conventions,
        verdicts: [],
        dryRun: false,
      }),
    );

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "host_conventions_unreadable",
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses a swap with no requestable owners", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const withoutOwners: ApplyVerdict = {
      ...input,
      blastRadius: { ...input.blastRadius, owners: [] },
    };

    const refused = requireRefused(await runApply(harness, [withoutOwners]));

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "no_requestable_reviewers",
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses gate (c) when local HEAD moved beyond the evidence revision", async () => {
    const harness = await createHarness();
    await git(harness.repoDir, [
      "-c",
      "user.name=Fixture Author",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "chore: advance local head",
    ]);

    const refused = requireRefused(
      await runApply(harness, [applyVerdict(harness)]),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "stale_evidence",
        detail: expect.objectContaining({
          evidenceRevision: harness.head,
          action: "re-prove",
        }),
      }),
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses gate (c) when the stub base advances beyond the evidence revision", async () => {
    const harness = await createHarness();
    const advanced = await control<{ object: { sha: string } }>(
      harness.stub,
      "/__test/advance-base",
      {
        ...repository,
        branch: "main",
        tree: { README: "base advanced\n" },
      },
    );

    const refused = requireRefused(
      await runApply(harness, [applyVerdict(harness)]),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "stale_evidence",
        detail: {
          evidenceRevision: harness.head,
          remoteRevision: advanced.object.sha,
          action: "re-prove",
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses gate (d) when an adjacent on-disk edit changed the scan-time digest", async () => {
    const harness = await createHarness();
    const file = join(harness.repoDir, sourcePath);
    await writeFile(
      file,
      `const adjacentEdit = true;\n${await readFile(file, "utf8")}`,
    );

    const refused = requireRefused(
      await runApply(harness, [applyVerdict(harness)]),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "stale_location",
        detail: { paths: [sourcePath] },
      }),
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses gate (e) when the candidate diff contains an adjacent edit", async () => {
    const harness = await createHarness();
    vi.resetModules();
    vi.doMock("./diff.js", async () => {
      const actual =
        await vi.importActual<typeof import("./diff.js")>("./diff.js");
      return {
        ...actual,
        buildSwapDiff: (options: Parameters<typeof actual.buildSwapDiff>[0]) =>
          actual.buildSwapDiff(options).map((result) =>
            "reason" in result
              ? result
              : {
                  ...result,
                  after: `${result.after}\nconst adjacentEdit = true;\n`,
                },
          ),
      };
    });

    let refused: ReturnType<typeof requireRefused>;
    try {
      const { applySwaps: applyWithSeededDiff } =
        await import("./orchestrator.js");
      refused = requireRefused(
        await applyWithSeededDiff({
          store: harness.store,
          repoDir: harness.repoDir,
          githubClient: harness.githubClient,
          ...repository,
          conventions: harness.conventions,
          verdicts: [applyVerdict(harness)],
          dryRun: false,
        }),
      );
    } finally {
      vi.doUnmock("./diff.js");
      vi.resetModules();
    }

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "diff_lint_failed",
        detail: expect.objectContaining({
          violations: expect.arrayContaining([
            expect.objectContaining({ path: sourcePath }),
          ]),
        }),
      }),
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("refuses gate (f) when the configured formatter changes an adjacent line", async () => {
    const harness = await createHarness();
    await symlink(
      join(repositoryRoot, "node_modules"),
      join(harness.repoDir, "node_modules"),
      "dir",
    );
    const file = join(harness.repoDir, sourcePath);
    const content = `const adjacent={value:1}\n${await readFile(file, "utf8")}`;
    await writeFile(file, content);

    const refused = requireRefused(
      await runApply(harness, [
        applyVerdict(harness, {
          contentHash: createHash("sha256").update(content).digest("hex"),
        }),
      ]),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "formatter_blocked",
        detail: {
          path: sourcePath,
          line: 1,
          reason: "formatter_conflict",
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });

  it("returns the same open PR on an idempotent rerun without duplicating writes or facts", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const first = requireApplied(await runApply(harness, [input]));
    const hitsAfterFirstApply = harness.stub.getHits().length;

    const second = await runApply(harness, [input]);

    expect(second).toMatchObject({
      status: "existing",
      prNumber: first.prNumber,
      runSpecDigest: first.runSpecDigest,
      branch: first.branch,
      title: first.title,
    });
    expect(pullCreationHits(harness.stub)).toHaveLength(1);
    expect(harness.stub.getHits()).toHaveLength(hitsAfterFirstApply);
    expect(await lifecycleEvents(harness.store)).toHaveLength(3);
  });

  it("refuses a directly reapplied swap after its pull request was rejected", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const first = requireApplied(await runApply(harness, [input]));
    const writesAfterFirstApply = githubWrites(harness.stub).length;
    const rejected = lifecycleEventSchema.parse({
      eventId: "rejected",
      prNumber: first.prNumber,
      repo: `${owner}/${repo}`,
      familyIds: [harness.stepRecord.family],
      kind: "pr_closed_rejected",
      evidence: {
        revision: harness.head,
        corpusVersionId: "corpus-version-9",
        gatePolicyVersion: "gate-policy-7",
      },
      runSpecDigest: first.runSpecDigest,
      createdAt: "9999-01-01T00:00:00.000Z",
      detail: { reason: "closed_unmerged" },
    });
    await harness.store.putImmutable(
      factKey("project", rejected.eventId),
      Buffer.from(canonicalJson(rejected), "utf8"),
    );

    const reapplied = requireRefused(await runApply(harness, [input]));

    expect(reapplied.reasons).toEqual([
      expect.objectContaining({
        code: "previously_rejected",
        detail: expect.objectContaining({ prNumber: first.prNumber }),
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesAfterFirstApply);
    expect(pullCreationHits(harness.stub)).toHaveLength(1);
  });

  it("bounds rendered case IDs and reports omitted invalid IDs", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const renderedCaseIds = Array.from({ length: 7 }, (_, index) =>
      (index + 1).toString(16).repeat(64),
    );
    const verdict: ApplyVerdict = {
      ...input,
      verdict: {
        ...input.verdict,
        caseIds: [...renderedCaseIds, caseContentMarker],
      },
    };

    const applied = requireApplied(await runApply(harness, [verdict]));
    const pull = await harness.githubClient.getPullRequest({
      ...repository,
      pullNumber: applied.prNumber,
    });

    for (const caseId of renderedCaseIds.slice(0, 5)) {
      expect(pull.body).toContain(caseId);
    }
    for (const caseId of renderedCaseIds.slice(5)) {
      expect(pull.body).not.toContain(caseId);
    }
    expect(pull.body).toContain("and 2 more");
    expect(pull.body).toContain("1 invalid case ID omitted");
    expect(pull.body).not.toContain(caseContentMarker);
  });

  it("restores the exact pre-apply branch state, records apply_failed, and resumes", async () => {
    const harness = await createHarness();
    const before = await readFile(join(harness.repoDir, sourcePath), "utf8");
    const input = applyVerdict(harness);
    const interruptedClient: GithubClient = {
      ...harness.githubClient,
      createPullRequest: vi.fn(async () => {
        throw new Error("simulated pull-request failure");
      }),
    };

    await expect(
      runApply(harness, [input], false, interruptedClient),
    ).rejects.toThrow("pre-apply files were restored");

    const failedEvents = await lifecycleEvents(harness.store);
    const failed = failedEvents.find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "apply_failed",
    );
    if (
      failed === undefined ||
      typeof failed.detail !== "object" ||
      failed.detail === null ||
      Array.isArray(failed.detail) ||
      typeof failed.detail.branch !== "string"
    ) {
      throw new Error("Missing apply_failed lifecycle fact");
    }
    await expect(
      harness.githubClient.getFileContent({
        ...repository,
        path: sourcePath,
        ref: failed.detail.branch,
      }),
    ).resolves.toMatchObject({ content: before });
    const failureProof = remediationFromLifecycleDetail(failed.detail);
    expect(failureProof).toMatchObject({
      event_type: "apply_failed",
      affected_files: [sourcePath],
      pre_apply_digests: { [sourcePath]: digestFileContent(before) },
      post_apply_digests: {
        [sourcePath]: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      restored: true,
    });
    expect(failureProof.post_apply_digests[sourcePath]).not.toBe(
      failureProof.pre_apply_digests[sourcePath],
    );
    expect(pullCreationHits(harness.stub)).toHaveLength(0);

    const resumed = requireApplied(await runApply(harness, [input]));

    expect(resumed.branch).toBe(failed.detail.branch);
    expect(pullCreationHits(harness.stub)).toHaveLength(1);
    expect(
      harness.stub
        .getHits()
        .filter(
          ({ method, path }) =>
            method === "POST" && path === `/repos/${owner}/${repo}/git/refs`,
        ),
    ).toHaveLength(1);
    const events = await lifecycleEvents(harness.store);
    expect(
      events.filter(
        ({ detail }) =>
          typeof detail === "object" &&
          detail !== null &&
          !Array.isArray(detail) &&
          detail.operation === "apply",
      ),
    ).toHaveLength(2);
    expect(
      events.filter(
        ({ detail }) =>
          typeof detail === "object" &&
          detail !== null &&
          !Array.isArray(detail) &&
          detail.operation === "apply_failed",
      ),
    ).toHaveLength(1);
  });

  it("records a failed restoration and leaves a named path forward", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const failingClient: GithubClient = {
      ...harness.githubClient,
      async createOrUpdateFile(request) {
        if (request.message.startsWith("Restore after failed")) {
          await harness.githubClient.createOrUpdateFile({
            ...request,
            content: "partially restored\n",
          });
          throw new Error("simulated restore failure");
        }
        return harness.githubClient.createOrUpdateFile(request);
      },
      createPullRequest: vi.fn(async () => {
        throw new Error("simulated pull-request failure");
      }),
    };

    await expect(
      runApply(harness, [input], false, failingClient),
    ).rejects.toMatchObject({ code: "apply_restore_failed" });

    const failure = (await lifecycleEvents(harness.store)).find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "apply_failed",
    );
    if (failure === undefined) throw new Error("Missing apply_failed event");
    const failedProof = remediationFromLifecycleDetail(failure.detail);
    const started = (await lifecycleEvents(harness.store)).find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "apply",
    );
    if (started === undefined) throw new Error("Missing apply start event");
    const startedProof = remediationFromLifecycleDetail(started.detail);
    expect(failedProof).toMatchObject({
      event_type: "apply_failed",
      restored: false,
      post_apply_digests: {
        [sourcePath]: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(failedProof.post_apply_digests).toEqual(
      startedProof.post_apply_digests,
    );
    expect(failedProof.post_apply_digests[sourcePath]).not.toBe(
      digestFileContent("partially restored\n"),
    );

    const resumed = requireRefused(await runApply(harness, [input]));
    expect(resumed.reasons.map(({ code }) => code)).toEqual([
      "apply_resume_state_mismatch",
    ]);
  });

  it("does not claim restoration when branch creation failed", async () => {
    const harness = await createHarness();
    const failingClient: GithubClient = {
      ...harness.githubClient,
      createRef: vi.fn(async () => {
        throw new Error("simulated branch creation failure");
      }),
    };

    await expect(
      runApply(harness, [applyVerdict(harness)], false, failingClient),
    ).rejects.toThrow("simulated branch creation failure");

    const failure = (await lifecycleEvents(harness.store)).find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "apply_failed",
    );
    if (failure === undefined) throw new Error("Missing apply_failed event");
    expect(remediationFromLifecycleDetail(failure.detail).restored).toBe(false);
  });

  it("refuses a deterministic apply branch without a recorded start fact", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const preview = await runApply(harness, [input], true);
    if (preview.status !== "dry_run") {
      throw new Error(`Expected dry_run, received ${preview.status}`);
    }
    await harness.githubClient.createRef({
      ...repository,
      ref: `refs/heads/${preview.branch}`,
      sha: harness.head,
    });
    const writesBeforeApply = githubWrites(harness.stub).length;

    const refused = requireRefused(await runApply(harness, [input]));

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "apply_branch_unowned",
        detail: { branch: preview.branch },
      }),
    ]);

    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeApply);
    expect(await lifecycleEvents(harness.store)).toEqual([]);
  });

  it("names an invalid repository revision before GitHub mutation", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const invalid: ApplyVerdict = {
      ...input,
      evidence: { ...input.evidence, revision: "not-an-object-id" },
    };

    const refused = requireRefused(await runApply(harness, [invalid]));

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "invalid_repository_revision",
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
    expect(await lifecycleEvents(harness.store)).toEqual([]);
  });

  it("refuses a resume when the recorded pre-apply digests changed", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const interruptedClient: GithubClient = {
      ...harness.githubClient,
      createPullRequest: vi.fn(async () => {
        throw new Error("simulated pull-request failure");
      }),
    };
    await expect(
      runApply(harness, [input], false, interruptedClient),
    ).rejects.toThrow("pre-apply files were restored");
    const originalStart = (await lifecycleEvents(harness.store)).find(
      ({ kind, detail }) =>
        kind === "apply_started" &&
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "apply",
    );
    if (
      originalStart === undefined ||
      typeof originalStart.detail !== "object" ||
      originalStart.detail === null ||
      Array.isArray(originalStart.detail)
    ) {
      throw new Error("Missing apply start");
    }
    const originalDetail = originalStart.detail;
    const recorded = remediationFromLifecycleDetail(originalStart.detail);
    const conflicting = createRemediationLifecycleEvent({
      evidenceId: recorded.evidence_id,
      eventType: "applied",
      actor: recorded.actor,
      reason: recorded.reason,
      repositoryRevision: recorded.repository_revision,
      affectedFiles: recorded.affected_files,
      preApplyDigests: { [sourcePath]: digestFileContent("different\n") },
      postApplyDigests: recorded.post_apply_digests,
      restored: false,
      timestamp: recorded.timestamp,
    });
    const conflictingStart = lifecycleEventSchema.parse({
      ...originalStart,
      eventId: "conflicting-start",
      createdAt: "9999-01-01T00:00:00.000Z",
      detail: {
        ...originalDetail,
        remediation: conflicting,
      },
    });
    await harness.store.putImmutable(
      factKey("project", conflictingStart.eventId),
      Buffer.from(canonicalJson(conflictingStart), "utf8"),
    );

    const writesBeforeResume = githubWrites(harness.stub).length;
    const refused = requireRefused(await runApply(harness, [input]));

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "apply_resume_state_mismatch",
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeResume);
  });

  it("refuses a resumed apply branch with changes outside the swap files", async () => {
    const harness = await createHarness();
    const input = applyVerdict(harness);
    const interruptedClient: GithubClient = {
      ...harness.githubClient,
      createPullRequest: vi.fn(async () => {
        throw new Error("simulated pull-request failure");
      }),
    };
    await expect(
      runApply(harness, [input], false, interruptedClient),
    ).rejects.toThrow("pre-apply files were restored");
    const failed = (await lifecycleEvents(harness.store)).find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "apply_failed",
    );
    if (
      failed === undefined ||
      typeof failed.detail !== "object" ||
      failed.detail === null ||
      Array.isArray(failed.detail) ||
      typeof failed.detail.branch !== "string"
    ) {
      throw new Error("Missing apply_failed lifecycle fact");
    }
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: failed.detail.branch,
      tree: { "outside-scope.txt": "unexpected\n" },
    });
    const writesBeforeResume = githubWrites(harness.stub).length;

    const refused = requireRefused(await runApply(harness, [input]));

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "apply_branch_scope_mismatch",
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeResume);
    expect(await lifecycleEvents(harness.store)).toHaveLength(2);
  });

  it("stops a clean dry-run after gate (f) with no GitHub writes or lifecycle facts", async () => {
    const harness = await createHarness();

    const result = await runApply(harness, [applyVerdict(harness)], true);

    expect(result).toMatchObject({
      status: "dry_run",
      files: [sourcePath],
      reviewers: ["alpha", "bravo", "charlie", "delta", "echo"],
      teamReviewers: ["platform"],
    });
    expect(githubWrites(harness.stub)).toEqual([]);
    expect(
      harness.stub
        .getHits()
        .filter(({ path }) => !path.startsWith("/__test/"))
        .map(({ method, path }) => ({ method, path })),
    ).toEqual([
      {
        method: "GET",
        path: `/repos/${owner}/${repo}/git/ref/heads/main`,
      },
    ]);
    expect(await lifecycleEvents(harness.store)).toEqual([]);
  });
});

describe("rollbackPreparedSwaps", () => {
  it("restores the exact pre-apply contents on a new pull request and records rollback proof", async () => {
    const harness = await createHarness();
    const before = await readFile(join(harness.repoDir, sourcePath), "utf8");
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    const appliedContent = await harness.githubClient.getFileContent({
      ...repository,
      path: sourcePath,
      ref: applied.branch,
    });
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const rolledBack = requireRolledBack(
      await runRollback(harness, applied.prNumber),
    );

    expect(rolledBack.prNumber).not.toBe(applied.prNumber);
    await expect(
      harness.githubClient.getFileContent({
        ...repository,
        path: sourcePath,
        ref: rolledBack.branch,
      }),
    ).resolves.toMatchObject({ content: before });
    await expect(
      harness.githubClient.compareCommits({
        ...repository,
        base: "main",
        head: rolledBack.branch,
      }),
    ).resolves.toMatchObject({
      status: "ahead",
      aheadBy: 1,
      files: [{ filename: sourcePath, status: "modified" }],
    });
    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: rolledBack.prNumber,
      }),
    ).resolves.toMatchObject({
      state: "open",
      draft: true,
      head: { ref: rolledBack.branch },
      base: { ref: "main" },
    });

    const events = await lifecycleEvents(harness.store);
    expect(events).toHaveLength(5);
    const rollbackEvents = events.filter(
      ({ runSpecDigest }) => runSpecDigest === rolledBack.runSpecDigest,
    );
    expect(rollbackEvents.map(({ kind }) => kind).sort()).toEqual([
      "apply_started",
      "pr_opened",
    ]);
    const opened = rollbackEvents.find(({ kind }) => kind === "pr_opened");
    if (opened === undefined)
      throw new Error("Missing rollback pr_opened event");
    expect(opened.detail).toMatchObject({
      operation: "rollback",
      originalPrNumber: applied.prNumber,
    });
    const proof = remediationFromLifecycleDetail(opened.detail);
    expect(proof).toMatchObject({
      evidence_id: `sha256:${applied.runSpecDigest}`,
      event_type: "rolled_back",
      affected_files: [sourcePath],
      pre_apply_digests: { [sourcePath]: digestFileContent(before) },
      post_apply_digests: { [sourcePath]: digestFileContent(before) },
      reason: delegatedCiValidationReason,
      restored: true,
    });
    expect(appliedContent.content).not.toBe(before);
    expect(digestFileContent(appliedContent.contentBytes)).not.toBe(
      proof.post_apply_digests[sourcePath],
    );

    const hitsAfterRollback = harness.stub.getHits().length;
    await expect(runRollback(harness, applied.prNumber)).resolves.toMatchObject(
      {
        status: "existing",
        prNumber: rolledBack.prNumber,
        branch: rolledBack.branch,
      },
    );
    expect(harness.stub.getHits()).toHaveLength(hitsAfterRollback);
    expect(await lifecycleEvents(harness.store)).toHaveLength(5);
  });

  it("executes rollback argv with JSON output", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });

    const result = await runRollbackCli(harness, applied.prNumber);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "rolled_back",
      originalPrNumber: applied.prNumber,
      prNumber: 2,
    });
  });

  it("returns exit 1 and JSON refusal for rollback digest mismatch argv", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: "main",
      tree: { src: { "summarize.ts": "changed before CLI rollback\n" } },
    });

    const result = await runRollbackCli(harness, applied.prNumber);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "refused",
      reasons: [{ code: "post_apply_digest_mismatch" }],
    });
  });

  it("refuses an original pull request that has not merged", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    const writesBeforeRollback = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "original_pr_not_merged",
        detail: { prNumber: applied.prNumber },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
  });

  it("names an unavailable pre-apply revision before rollback writes", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const unavailableClient: GithubClient = {
      ...harness.githubClient,
      async getFileContent(request) {
        if (request.ref === harness.head) {
          throw new GithubHttpError(404, "commit unavailable");
        }
        return harness.githubClient.getFileContent(request);
      },
    };
    const writesBeforeRollback = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber, unavailableClient),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "pre_apply_revision_unavailable",
        detail: {
          files: [expect.objectContaining({ path: sourcePath, actual: null })],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
  });

  it("refuses a deterministic rollback branch without a recorded owner fact", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const opened = (await lifecycleEvents(harness.store)).find(
      ({ kind, prNumber }) =>
        kind === "pr_opened" && prNumber === applied.prNumber,
    );
    if (opened === undefined) throw new Error("Missing apply proof");
    const proof = remediationFromLifecycleDetail(opened.detail);
    const runSpecDigest = computeRunSpecDigest({
      operation: "rollback",
      repo: `${owner}/${repo}`,
      originalPrNumber: applied.prNumber,
      evidenceId: proof.evidence_id,
    });
    const branch = `rightmodeler/rollback-${applied.prNumber}-${runSpecDigest.slice(0, 8)}`;
    const main = await harness.githubClient.getRef({
      ...repository,
      ref: "heads/main",
    });
    await harness.githubClient.createRef({
      ...repository,
      ref: `refs/heads/${branch}`,
      sha: main.sha,
    });
    const writesBeforeRollback = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "rollback_branch_unowned",
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
    expect(await lifecycleEvents(harness.store)).toHaveLength(3);
  });

  it("refuses an owned rollback branch with changes outside the affected files", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const interruptedClient: GithubClient = {
      ...harness.githubClient,
      createOrUpdateFile: vi.fn(async () => {
        throw new Error("simulated interruption after branch creation");
      }),
    };
    await expect(
      runRollback(harness, applied.prNumber, interruptedClient),
    ).rejects.toThrow("simulated interruption");
    const started = (await lifecycleEvents(harness.store)).find(
      ({ kind, detail }) =>
        kind === "apply_started" &&
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "rollback",
    );
    if (
      started === undefined ||
      typeof started.detail !== "object" ||
      started.detail === null ||
      Array.isArray(started.detail) ||
      typeof started.detail.branch !== "string"
    ) {
      throw new Error("Missing rollback start fact");
    }
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: started.detail.branch,
      tree: { "outside-scope.txt": "unexpected\n" },
    });
    const writesBeforeResume = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "rollback_branch_scope_mismatch",
        detail: {
          branch: started.detail.branch,
          paths: ["outside-scope.txt"],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeResume);
  });

  it("refuses with post_apply_digest_mismatch before writes when an affected file changed", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: "main",
      tree: { src: { "summarize.ts": "someone else changed this\n" } },
    });
    const writesBeforeRollback = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "post_apply_digest_mismatch",
        detail: {
          files: [
            expect.objectContaining({
              path: sourcePath,
              expected: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
              actual: digestFileContent("someone else changed this\n"),
            }),
          ],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
    expect(await lifecycleEvents(harness.store)).toHaveLength(3);
    await expect(
      harness.githubClient.getFileContent({
        ...repository,
        path: sourcePath,
        ref: "main",
      }),
    ).resolves.toMatchObject({ content: "someone else changed this\n" });
  });

  it("refuses with post_apply_digest_mismatch when an affected file was deleted", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: "main",
      deletePaths: [sourcePath],
    });
    const writesBeforeRollback = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "post_apply_digest_mismatch",
        detail: {
          files: [
            expect.objectContaining({
              path: sourcePath,
              expected: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
              actual: null,
            }),
          ],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
    expect(await lifecycleEvents(harness.store)).toHaveLength(3);
  });

  it("fails loudly when reading a touched file fails for a reason other than absence", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const failingClient: GithubClient = {
      ...harness.githubClient,
      getFileContent: vi.fn(async () => {
        throw new GithubHttpError(500, "upstream failed");
      }),
    };
    const writesBeforeRollback = githubWrites(harness.stub).length;

    await expect(
      runRollback(harness, applied.prNumber, failingClient),
    ).rejects.toMatchObject({ status: 500 });
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
    expect(await lifecycleEvents(harness.store)).toHaveLength(3);
  });

  it("records rollback_failed, restores the branch, and resumes", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const mergedContent = await harness.githubClient.getFileContent({
      ...repository,
      path: sourcePath,
      ref: "main",
    });
    const interruptedClient: GithubClient = {
      ...harness.githubClient,
      createPullRequest: vi.fn(async () => {
        throw new Error("simulated interruption before pull request");
      }),
    };

    await expect(
      runRollback(harness, applied.prNumber, interruptedClient),
    ).rejects.toThrow("simulated interruption");
    const failure = (await lifecycleEvents(harness.store)).find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "rollback_failed",
    );
    if (
      failure === undefined ||
      typeof failure.detail !== "object" ||
      failure.detail === null ||
      Array.isArray(failure.detail) ||
      typeof failure.detail.branch !== "string"
    ) {
      throw new Error("Missing rollback_failed event");
    }
    expect(remediationFromLifecycleDetail(failure.detail)).toMatchObject({
      event_type: "rollback_failed",
      restored: true,
    });
    await expect(
      harness.githubClient.getFileContent({
        ...repository,
        path: sourcePath,
        ref: failure.detail.branch,
      }),
    ).resolves.toMatchObject({ content: mergedContent.content });
    const writesAfterInterruption = githubWrites(harness.stub).length;

    const resumed = requireRolledBack(
      await runRollback(harness, applied.prNumber),
    );

    expect(githubWrites(harness.stub)).toHaveLength(
      writesAfterInterruption + 2,
    );
    expect(pullCreationHits(harness.stub)).toHaveLength(2);
    const rollbackEvents = (await lifecycleEvents(harness.store)).filter(
      ({ runSpecDigest }) => runSpecDigest === resumed.runSpecDigest,
    );
    expect(rollbackEvents.map(({ kind }) => kind).sort()).toEqual([
      "apply_started",
      "apply_started",
      "pr_opened",
    ]);
  });

  it("records a failed rollback restoration and leaves a named path forward", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const failingClient: GithubClient = {
      ...harness.githubClient,
      async createOrUpdateFile(request) {
        if (request.message.startsWith("Restore after failed")) {
          await harness.githubClient.createOrUpdateFile({
            ...request,
            content: "partially restored rollback\n",
          });
          throw new Error("simulated rollback restore failure");
        }
        return harness.githubClient.createOrUpdateFile(request);
      },
      createPullRequest: vi.fn(async () => {
        throw new Error("simulated rollback pull-request failure");
      }),
    };

    await expect(
      runRollback(harness, applied.prNumber, failingClient),
    ).rejects.toMatchObject({ code: "rollback_restore_failed" });

    const failure = (await lifecycleEvents(harness.store)).find(
      ({ detail }) =>
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "rollback_failed",
    );
    if (failure === undefined) throw new Error("Missing rollback_failed event");
    expect(remediationFromLifecycleDetail(failure.detail).restored).toBe(false);

    const resumed = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );
    expect(resumed.reasons.map(({ code }) => code)).toEqual([
      "post_apply_digest_mismatch",
    ]);
  });

  it("recovers a rollback pull request created before its lifecycle fact", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    let immutableWrites = 0;
    const interruptedStore: Store = {
      get: (key) => harness.store.get(key),
      list: (prefix) => harness.store.list(prefix),
      compareAndSwap: (key, expectedVersion, body, fenceToken) =>
        harness.store.compareAndSwap(key, expectedVersion, body, fenceToken),
      async putImmutable(key, body) {
        immutableWrites += 1;
        if (immutableWrites === 2) {
          throw new Error("simulated interruption after pull request");
        }
        await harness.store.putImmutable(key, body);
      },
    };

    await expect(
      rollbackPreparedSwaps({
        store: interruptedStore,
        githubClient: harness.githubClient,
        ...repository,
        prNumber: applied.prNumber,
      }),
    ).rejects.toThrow("simulated interruption after pull request");
    expect(pullCreationHits(harness.stub)).toHaveLength(2);

    const resumed = requireRolledBack(
      await runRollback(harness, applied.prNumber),
    );

    expect(resumed.prNumber).toBe(2);
    expect(pullCreationHits(harness.stub)).toHaveLength(2);
    const rollbackEvents = (await lifecycleEvents(harness.store)).filter(
      ({ runSpecDigest }) => runSpecDigest === resumed.runSpecDigest,
    );
    expect(rollbackEvents.map(({ kind }) => kind).sort()).toEqual([
      "apply_started",
      "apply_started",
      "pr_opened",
    ]);
  });

  it("refuses a resumed rollback branch whose touched file is in a third state", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    const interruptedClient: GithubClient = {
      ...harness.githubClient,
      createOrUpdateFile: vi.fn(async () => {
        throw new Error("simulated interruption after branch creation");
      }),
    };
    await expect(
      runRollback(harness, applied.prNumber, interruptedClient),
    ).rejects.toThrow("simulated interruption");
    const started = (await lifecycleEvents(harness.store)).find(
      ({ kind, detail }) =>
        kind === "apply_started" &&
        typeof detail === "object" &&
        detail !== null &&
        !Array.isArray(detail) &&
        detail.operation === "rollback",
    );
    if (
      started === undefined ||
      typeof started.detail !== "object" ||
      started.detail === null ||
      Array.isArray(started.detail) ||
      typeof started.detail.branch !== "string"
    ) {
      throw new Error("Missing rollback start fact");
    }
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: started.detail.branch,
      tree: { src: { "summarize.ts": "third state\n" } },
    });
    const writesBeforeResume = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "post_apply_digest_mismatch",
        detail: {
          files: [
            expect.objectContaining({
              path: sourcePath,
              actual: digestFileContent("third state\n"),
            }),
          ],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeResume);
  });

  it("rechecks a moved base before mutation and refuses newly overlapping edits", async () => {
    const harness = await createHarness();
    const applied = requireApplied(
      await runApply(harness, [applyVerdict(harness)]),
    );
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: applied.prNumber,
    });
    let advanced = false;
    const racingClient: GithubClient = {
      ...harness.githubClient,
      async getFileContent(input) {
        const file = await harness.githubClient.getFileContent(input);
        if (!advanced) {
          advanced = true;
          await control(harness.stub, "/__test/advance-base", {
            ...repository,
            branch: "main",
            tree: { src: { "summarize.ts": "racing edit\n" } },
          });
        }
        return file;
      },
    };
    const writesBeforeRollback = githubWrites(harness.stub).length;

    const refused = requireRollbackRefused(
      await runRollback(harness, applied.prNumber, racingClient),
    );

    expect(refused.reasons).toEqual([
      expect.objectContaining({
        code: "post_apply_digest_mismatch",
        detail: {
          files: [
            expect.objectContaining({
              path: sourcePath,
              actual: digestFileContent("racing edit\n"),
            }),
          ],
        },
      }),
    ]);
    expect(githubWrites(harness.stub)).toHaveLength(writesBeforeRollback);
    expect(await lifecycleEvents(harness.store)).toHaveLength(3);
  });

  it("returns missing_remediation_evidence for a legacy apply lifecycle fact", async () => {
    const harness = await createHarness();
    const legacy = lifecycleEventSchema.parse({
      eventId: "legacy-pr",
      prNumber: 17,
      repo: `${owner}/${repo}`,
      familyIds: [harness.stepRecord.family],
      kind: "pr_opened",
      evidence: {
        revision: harness.head,
        corpusVersionId: "corpus-version-9",
        gatePolicyVersion: "gate-policy-7",
      },
      runSpecDigest: "f".repeat(64),
      createdAt: "2026-07-13T12:00:00.000Z",
      detail: { branch: "rightmodeler/legacy", title: "Legacy swap" },
    });
    await harness.store.putImmutable(
      factKey("project", legacy.eventId),
      Buffer.from(canonicalJson(legacy), "utf8"),
    );

    const refused = requireRollbackRefused(await runRollback(harness, 17));

    expect(refused.reasons.map(({ code }) => code)).toEqual([
      "missing_remediation_evidence",
    ]);
    expect(githubWrites(harness.stub)).toEqual([]);
  });
});
