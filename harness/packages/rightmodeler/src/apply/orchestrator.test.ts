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
  factsPrefix,
  FsStore,
  lifecycleEventSchema,
  type LifecycleEvent,
  type StepRecord,
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
import { createGithubClient, type GithubClient } from "../github/index.js";
import {
  applySwaps,
  type ApplyCascadeStatus,
  type ApplyResult,
  type ApplyVerdict,
} from "./orchestrator.js";

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
): Promise<ApplyResult> {
  return applySwaps({
    store: harness.store,
    repoDir: harness.repoDir,
    githubClient: harness.githubClient,
    ...repository,
    conventions: harness.conventions,
    verdicts,
    dryRun,
  });
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
    expect(applied.reviewers).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(applied.teamReviewers).toEqual(["platform"]);
    expect(applied.reviewers.length + applied.teamReviewers.length).toBe(5);

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

  it("stops a clean dry-run after gate (f) with no GitHub writes or lifecycle facts", async () => {
    const harness = await createHarness();

    const result = await runApply(harness, [applyVerdict(harness)], true);

    expect(result).toMatchObject({
      status: "dry_run",
      files: [sourcePath],
      reviewers: ["alpha", "bravo", "charlie", "delta"],
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
