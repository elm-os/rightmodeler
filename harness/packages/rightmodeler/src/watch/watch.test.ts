import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  factKey,
  factsPrefix,
  FsStore,
  lifecycleEventSchema,
  verdictKey,
  type LifecycleEvent,
  type StepRecord,
  type Store,
} from "@rightmodeler/core";
import {
  GATE_IDS,
  type EvaluatorKindVerdict,
  type FamilyVerdict,
} from "@rightmodeler/kernel";
import { afterEach, describe, expect, it } from "vitest";

import type { ApplyVerdict } from "../apply/index.js";
import { assertContractArtifact } from "../contract-validation.js";
import type { CapturedConventions } from "../enrich/index.js";
import { createGithubClient, type GithubClient } from "../github/index.js";
import { derivePrState } from "./aggregate.js";
import { watchOnce } from "./watch.js";

const stubModuleUrl = new URL(
  "../../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
const owner = "acme";
const repo = "demo";
const repository = { owner, repo } as const;
const token = "watch-stub-token";
const tokenEnv = "RIGHTMODELER_WATCH_GITHUB_TOKEN";
const familyId = "summarize";
const validCaseIds = ["3".repeat(64), "a".repeat(64)] as const;
const originalSource = 'export const model = "acme/max-1";\n';

interface StubHit {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
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

interface Harness {
  readonly root: string;
  readonly store: FsStore;
  readonly stub: StubServer;
  readonly githubClient: GithubClient;
  readonly prNumber: number;
  readonly head: string;
  readonly verdicts: readonly ApplyVerdict[];
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

const conventions: CapturedConventions = {
  version: "1",
  instructionFiles: [],
  prTemplate: null,
  codeowners: null,
  formatter: { kind: null, configPath: null },
  commitConvention: { style: "plain", inferredFrom: [] },
  branchPrefix: null,
  warnings: [],
};

function evaluatorKind(): EvaluatorKindVerdict {
  return {
    evaluatorKind: "deterministic",
    conditionalExecutions: 2,
    passes: 2,
    trials: 2,
    passRate: 1,
    averageScore: 1,
    nTrajectories: 2,
    nDistinctSteps: 1,
    excludedExecutions: 0,
    excludedFraction: 0,
    assessmentAbsent: 0,
    assessmentAbsentReasons: [],
    worstCasePassRate: 1,
    worstCaseBound: 0.8,
    naiveInterval: { point: 1, lower: 0.8, upper: 1 },
    trajectoryClusters: [
      { trajectoryId: "trajectory-1", passes: 2, trials: 2 },
    ],
  };
}

function familyVerdict(): FamilyVerdict {
  return {
    evidenceQuestionId: "question-1",
    corpusSplit: "holdout",
    familyId,
    candidateId: "acme/small-1",
    candidateFamily: "acme-small",
    caseIds: [...validCaseIds, "private-case-content"],
    candidateCostUsd: 0.001,
    gatePolicyVersion: "policy-1",
    referenceCeilingMultiplier: 1,
    evaluatorKinds: [evaluatorKind()],
    weakestEvaluatorKind: "deterministic",
    nExecutions: 2,
    nReviewTrials: 2,
    nTrajectories: 2,
    nDistinctSteps: 1,
    excludedExecutions: 0,
    excludedFraction: 0,
    assessmentAbsent: 0,
    assessmentAbsentReasons: [],
    worstCaseBound: 0.8,
    naiveInterval: { point: 1, lower: 0.8, upper: 1 },
    availability: {
      availableExecutions: 2,
      executions: 2,
      rate: 1,
      lowerBound: 0.8,
      naiveInterval: { point: 1, lower: 0.8, upper: 1 },
    },
    unsafeSubstitutions: 0,
    coveredEvidenceCases: 2,
    requiredAbstentions: 0,
    satisfiedRequiredAbstentions: 0,
    decision: "recommend",
  };
}

function applyVerdict(revision: string): ApplyVerdict {
  const stepRecord: StepRecord = {
    stepId: "summarize-step",
    callSite: { path: "src/model.ts", line: 1, matcherSlug: "literal" },
    family: familyId,
    replayMode: "single_shot",
    prefixProvenance: "external",
    riskTier: "low",
    capabilityRequirements: [],
    evaluatorLadder: ["deterministic"],
    currentModel: "acme/max-1",
    observedCostUsd: 0.01,
    downstreamStepIds: [],
    candidates: [],
    analysisHistory: [],
    status: "replayed",
    contentHash: "content-hash-1",
  };
  return {
    verdict: familyVerdict(),
    releaseGates: GATE_IDS.map((id) => ({
      id,
      pass: true,
      reason: `${id} passed`,
    })),
    cascadeStatus: "confirmed",
    evidence: { revision, corpusVersionId: "corpus-1" },
    swaps: [
      {
        stepRecord,
        fromModel: "acme/max-1",
        toModel: "acme/small-1",
      },
    ],
    blastRadius: {
      familyId,
      files: ["src/model.ts"],
      downstreamFiles: [],
      owners: [{ handle: "@owner", source: "codeowners" }],
    },
    caps: [{ name: "replay sample size", value: 2 }],
  };
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

async function appendLifecycle(
  store: FsStore,
  event: LifecycleEvent,
): Promise<void> {
  const parsed = lifecycleEventSchema.parse(event);
  await store.putImmutable(
    factKey("project", parsed.eventId),
    Buffer.from(canonicalJson(parsed), "utf8"),
  );
}

async function lifecycleEvents(store: FsStore): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  for (const key of await store.list(factsPrefix("project"))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing fact ${key}`);
    const parsed = lifecycleEventSchema.safeParse(
      JSON.parse(Buffer.from(entry.body).toString("utf8")),
    );
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

async function remediationEvidenceArtifacts(
  store: FsStore,
): Promise<Array<Record<string, unknown>>> {
  const artifacts: Array<Record<string, unknown>> = [];
  for (const key of await store.list("project/reports/remediation-")) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Missing remediation evidence ${key}`);
    const value: unknown = JSON.parse(Buffer.from(entry.body).toString("utf8"));
    assertContractArtifact("remediation-evidence", value);
    artifacts.push(value as Record<string, unknown>);
  }
  return artifacts;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-watch-"));
  temporaryDirectories.push(root);
  const module = (await import(stubModuleUrl)) as StubModule;
  const stub = await module.startGithubStub({ port: 0, token });
  openStubs.push(stub);
  process.env[tokenEnv] = token;
  const seeded = await control<{ sha: string }>(stub, "/__test/seed", {
    ...repository,
    defaultBranch: "main",
    tree: { src: { "model.ts": originalSource } },
  });
  const githubClient = createGithubClient({
    baseUrl: `http://127.0.0.1:${stub.port}`,
    tokenEnv,
  });
  await githubClient.createRef({
    ...repository,
    ref: "refs/heads/rightmodeler/swap",
    sha: seeded.sha,
  });
  await githubClient.createOrUpdateFile({
    ...repository,
    path: "src/model.ts",
    message: "Swap model",
    content: 'export const model = "acme/small-1";\n',
    branch: "rightmodeler/swap",
    sha: createHash("sha1")
      .update(`blob ${Buffer.byteLength(originalSource)}\0${originalSource}`)
      .digest("hex"),
  });
  const pull = await githubClient.createPullRequest({
    ...repository,
    title: "Swap model",
    body: "Evidence",
    head: "rightmodeler/swap",
    base: "main",
    draft: true,
  });
  const store = new FsStore(join(root, "store"));
  const verdict = applyVerdict(seeded.sha);
  await store.compareAndSwap(
    verdictKey("project", familyId),
    0,
    Buffer.from(JSON.stringify(verdict.verdict), "utf8"),
    0,
  );
  await appendLifecycle(store, {
    eventId: "opened",
    prNumber: pull.number,
    repo: `${owner}/${repo}`,
    familyIds: [familyId],
    kind: "pr_opened",
    evidence: {
      revision: seeded.sha,
      corpusVersionId: "corpus-1",
      gatePolicyVersion: "policy-1",
    },
    runSpecDigest: "run-spec-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    detail: { branch: "rightmodeler/swap", title: "Swap model" },
  });
  return {
    root,
    store,
    stub,
    githubClient,
    prNumber: pull.number,
    head: pull.head.sha,
    verdicts: [verdict],
  };
}

function watchInput(
  harness: Harness,
  githubClient = harness.githubClient,
  store: Store = harness.store,
) {
  return {
    store,
    githubClient,
    ...repository,
    repoDir: harness.root,
    prNumber: harness.prNumber,
    verdicts: harness.verdicts,
    conventions,
  };
}

function fenceOutBeforeVerdictMutation(store: FsStore): Store {
  let watchLockWrites = 0;
  return {
    get: (key) => store.get(key),
    list: (prefix) => store.list(prefix),
    putImmutable: (key, body) => store.putImmutable(key, body),
    compareAndSwap(key, expectedVersion, body, fenceToken) {
      if (key.includes("/watch-locks/")) {
        watchLockWrites += 1;
        if (watchLockWrites === 4) return Promise.resolve(false);
      }
      return store.compareAndSwap(key, expectedVersion, body, fenceToken);
    },
  };
}

function postedComments(stub: StubServer, prNumber: number): StubHit[] {
  return stub
    .getHits()
    .filter(
      ({ method, path }) =>
        method === "POST" &&
        path === `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    );
}

describe("watchOnce", () => {
  it("answers a seeded review question exactly once across repeated passes", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/reviews", {
      ...repository,
      pullNumber: harness.prNumber,
      user: "owner",
      state: "COMMENTED",
      comments: [
        {
          body: "Open question for summarize: which cases support this?",
          path: "src/model.ts",
          line: 1,
        },
      ],
    });

    expect((await watchOnce(watchInput(harness))).status).toBe("actions_taken");
    expect((await watchOnce(watchInput(harness))).status).toBe("quiet");
    expect((await watchOnce(watchInput(harness))).status).toBe("quiet");

    const comments = postedComments(harness.stub, harness.prNumber);
    expect(comments).toHaveLength(1);
    const body = String(
      (comments[0]?.body as Record<string, unknown> | undefined)?.body,
    );
    expect(body).toContain(validCaseIds[0]);
    expect(body).toContain(validCaseIds[1]);
    expect(body).not.toContain("private-case-content");
    expect(
      (await lifecycleEvents(harness.store)).filter(
        ({ kind }) => kind === "comment_posted",
      ),
    ).toHaveLength(1);
  });

  it("answers an open question in a submitted review body", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/reviews", {
      ...repository,
      pullNumber: harness.prNumber,
      user: "owner",
      state: "COMMENTED",
      body: "Open question: what evidence supports summarize?",
    });

    await expect(watchOnce(watchInput(harness))).resolves.toMatchObject({
      status: "actions_taken",
      actions: [expect.objectContaining({ type: "evidence_replied" })],
    });
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    expect((await watchOnce(watchInput(harness))).status).toBe("quiet");
  });

  it("answers an unhandled human issue comment without magic wording", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/issue-comments", {
      ...repository,
      pullNumber: harness.prNumber,
      author: "owner",
      body: "why is the bound only 0.78?",
    });

    await watchOnce(watchInput(harness));
    await watchOnce(watchInput(harness));

    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    const body = String(
      (
        postedComments(harness.stub, harness.prNumber)[0]?.body as
          Record<string, unknown> | undefined
      )?.body,
    );
    expect(body).toContain("1 invalid case ID omitted");
    expect(body).not.toContain("private-case-content");
  });

  it("recovers a posted evidence reply when its first response is lost", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/issue-comments", {
      ...repository,
      pullNumber: harness.prNumber,
      author: "owner",
      body: "Open question for summarize: show the evidence.",
    });
    let loseResponse = true;
    const lossyClient: GithubClient = {
      ...harness.githubClient,
      async createIssueComment(input) {
        const posted = await harness.githubClient.createIssueComment(input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("simulated lost response");
        }
        return posted;
      },
    };

    await expect(watchOnce(watchInput(harness, lossyClient))).rejects.toThrow(
      "simulated lost response",
    );
    await expect(watchOnce(watchInput(harness))).resolves.toMatchObject({
      status: "actions_taken",
      actions: [expect.objectContaining({ type: "evidence_replied" })],
    });

    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    expect(
      (await lifecycleEvents(harness.store)).filter(
        ({ kind }) => kind === "comment_posted",
      ),
    ).toHaveLength(1);
  });

  it("marks affected verdicts and acknowledges changes requested once", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/reviews", {
      ...repository,
      pullNumber: harness.prNumber,
      user: "owner",
      state: "CHANGES_REQUESTED",
      body: "Please re-prove summarize against this objection.",
    });

    await expect(watchOnce(watchInput(harness))).resolves.toMatchObject({
      status: "actions_taken",
      phase: "reproving",
    });
    await watchOnce(watchInput(harness));

    const stored = await harness.store.get(verdictKey("project", familyId));
    expect(stored).not.toBeNull();
    expect(
      JSON.parse(Buffer.from(stored!.body).toString("utf8")),
    ).toMatchObject({
      familyId,
      reproof_requested: true,
      reproof_request_ids: [`review:${harness.prNumber}:1`],
    });
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    expect(
      (await lifecycleEvents(harness.store)).filter(
        ({ kind }) => kind === "reproof_started",
      ),
    ).toHaveLength(1);
  });

  it.each(["changes_requested", "base_branch_advanced"] as const)(
    "renews its fence before a %s verdict mutation",
    async (reason) => {
      const harness = await createHarness();
      if (reason === "changes_requested") {
        await control(harness.stub, "/__test/reviews", {
          ...repository,
          pullNumber: harness.prNumber,
          user: "owner",
          state: "CHANGES_REQUESTED",
          body: "Please re-prove this result.",
        });
      } else {
        await control(harness.stub, "/__test/advance-base", {
          ...repository,
          branch: "main",
          tree: { README: "advanced\n" },
        });
      }
      const fencedStore = fenceOutBeforeVerdictMutation(harness.store);

      await expect(
        watchOnce(watchInput(harness, harness.githubClient, fencedStore)),
      ).rejects.toThrow("Lost the fenced PR watch lock");

      const stored = await harness.store.get(verdictKey("project", familyId));
      expect(stored).not.toBeNull();
      expect(
        JSON.parse(Buffer.from(stored!.body).toString("utf8")),
      ).not.toHaveProperty("reproof_requested");
      expect(
        (await lifecycleEvents(harness.store)).filter(
          ({ kind }) => kind === "reproof_started",
        ),
      ).toEqual([]);
    },
  );

  it("waits on one CI failure pass and closes after the same failure persists", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [
        { name: "unit test", conclusion: "failure" },
        { name: "docs", conclusion: "failure" },
      ],
    });

    const first = await watchOnce(watchInput(harness));
    expect(first.status).toBe("actions_taken");
    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: harness.prNumber,
      }),
    ).resolves.toMatchObject({ state: "open" });
    expect(await lifecycleEvents(harness.store)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pr_closed_rejected" }),
      ]),
    );
    const firstComment = postedComments(harness.stub, harness.prNumber)[0];
    const firstCommentBody = String(
      (firstComment?.body as Record<string, unknown> | undefined)?.body,
    );
    expect(firstCommentBody).toContain("unit test");
    expect(firstCommentBody).toContain(
      "Diagnosis: repo-validation (fix-repo-validation)",
    );
    expect(firstCommentBody).not.toContain("docs");
    expect(first.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ci_failure_observed",
          detail: expect.objectContaining({
            issueClass: "repo-validation",
            nextAction: "fix-repo-validation",
          }),
        }),
      ]),
    );
    expect(await remediationEvidenceArtifacts(harness.store)).toEqual([
      expect.objectContaining({
        status: "draft",
        proof: expect.objectContaining({
          baseline_gate_statuses: { "repo-ci": "fail" },
          post_fix_snapshot_id: null,
          validation: expect.objectContaining({ status: "failed" }),
        }),
        residual_risks: expect.arrayContaining([expect.any(String)]),
      }),
    ]);

    const second = await watchOnce(watchInput(harness));
    expect(second.status).toBe("actions_taken");
    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: harness.prNumber,
      }),
    ).resolves.toMatchObject({ state: "closed", merged: false });
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    expect(await lifecycleEvents(harness.store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pr_closed_rejected" }),
        expect.objectContaining({ kind: "watch_ended" }),
      ]),
    );
    expect((await watchOnce(watchInput(harness))).status).toBe("quiet");
  });

  it("resets CI persistence when a completed check is rerun", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [{ name: "unit test", conclusion: "failure" }],
    });
    await watchOnce(watchInput(harness));

    await control(harness.stub, "/__test/check-run-conclusions", {
      ...repository,
      ref: harness.head,
      runs: [{ name: "unit test", conclusion: "success" }],
    });
    expect((await watchOnce(watchInput(harness))).status).toBe("quiet");
    const proven = (await remediationEvidenceArtifacts(harness.store)).find(
      ({ status }) => status === "proven",
    );
    expect(proven).toMatchObject({
      status: "proven",
      proof: {
        baseline_gate_statuses: { "repo-ci": "fail" },
        post_fix_snapshot_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        target_improved: true,
        regressed_gate_ids: [],
        validation: {
          status: "passed",
          commands: ["unit test"],
          evidence_refs: [expect.stringMatching(/^github-check-run:/)],
        },
      },
    });

    await control(harness.stub, "/__test/check-run-conclusions", {
      ...repository,
      ref: harness.head,
      runs: [{ name: "unit test", conclusion: "failure" }],
    });
    expect((await watchOnce(watchInput(harness))).status).toBe("actions_taken");
    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: harness.prNumber,
      }),
    ).resolves.toMatchObject({ state: "open" });
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(2);

    await watchOnce(watchInput(harness));
    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: harness.prNumber,
      }),
    ).resolves.toMatchObject({ state: "closed" });
  });

  it("does not prove remediation evidence when only some baseline failures pass", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [
        { name: "unit test", conclusion: "failure" },
        { name: "build", conclusion: "failure" },
      ],
    });
    await watchOnce(watchInput(harness));

    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [{ name: "unit test", conclusion: "success" }],
    });
    await watchOnce(watchInput(harness));

    expect(
      (await remediationEvidenceArtifacts(harness.store)).map(
        ({ status }) => status,
      ),
    ).toEqual(["draft"]);
  });

  it("does not prove remediation evidence while a baseline failure is pending", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [{ name: "unit test", conclusion: "failure" }],
    });
    await watchOnce(watchInput(harness));

    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [
        { name: "unit test", status: "pending", conclusion: null },
        { name: "build", conclusion: "success" },
      ],
    });
    await watchOnce(watchInput(harness));

    expect(
      (await remediationEvidenceArtifacts(harness.store)).map(
        ({ status }) => status,
      ),
    ).toEqual(["draft"]);
  });

  it.each(["cancelled", "timed_out", "action_required", "neutral", "skipped"])(
    "does not prove remediation evidence for a completed %s baseline check",
    async (conclusion) => {
      const harness = await createHarness();
      await control(harness.stub, "/__test/check-runs", {
        ...repository,
        ref: harness.head,
        runs: [{ name: "unit test", conclusion: "failure" }],
      });
      await watchOnce(watchInput(harness));

      await control(harness.stub, "/__test/check-runs", {
        ...repository,
        ref: harness.head,
        runs: [
          { name: "unit test", conclusion },
          { name: "build", conclusion: "success" },
        ],
      });
      await watchOnce(watchInput(harness));

      expect(
        (await remediationEvidenceArtifacts(harness.store)).map(
          ({ status }) => status,
        ),
      ).toEqual(["draft"]);
    },
  );

  it("counts persisted failure observations when a check disappears for one pass", async () => {
    const harness = await createHarness();
    let checkPass = 0;
    const intermittentClient: GithubClient = {
      ...harness.githubClient,
      async listCheckRunsForRef() {
        checkPass += 1;
        const checkRuns =
          checkPass === 2
            ? []
            : [
                {
                  id: 91,
                  name: "unit test",
                  headSha: harness.head,
                  status: "completed" as const,
                  conclusion: "failure",
                  startedAt: "2026-01-01T00:00:00.000Z",
                  completedAt: "2026-01-01T00:00:01.000Z",
                },
              ];
        return { totalCount: checkRuns.length, checkRuns };
      },
    };

    await watchOnce(watchInput(harness, intermittentClient));
    expect(
      (await watchOnce(watchInput(harness, intermittentClient))).status,
    ).toBe("quiet");
    await watchOnce(watchInput(harness, intermittentClient));
    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: harness.prNumber,
      }),
    ).resolves.toMatchObject({ state: "closed" });
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
  });

  it("closes when one failing check persists as another failure appears", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      runs: [{ name: "unit test", conclusion: "failure" }],
    });
    await watchOnce(watchInput(harness));
    await control(harness.stub, "/__test/check-runs", {
      ...repository,
      ref: harness.head,
      append: true,
      runs: [{ name: "build", conclusion: "failure" }],
    });

    await watchOnce(watchInput(harness));

    await expect(
      harness.githubClient.getPullRequest({
        ...repository,
        pullNumber: harness.prNumber,
      }),
    ).resolves.toMatchObject({ state: "closed" });
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    expect(await lifecycleEvents(harness.store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pr_closed_rejected",
          detail: expect.objectContaining({ checkNames: ["unit test"] }),
        }),
      ]),
    );
  });

  it("records a merge and ends without making later GitHub calls", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/merge", {
      ...repository,
      pullNumber: harness.prNumber,
    });

    expect((await watchOnce(watchInput(harness))).status).toBe("actions_taken");
    expect(await lifecycleEvents(harness.store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pr_merged" }),
        expect.objectContaining({ kind: "watch_ended" }),
      ]),
    );
    const hitCount = harness.stub.getHits().length;
    expect((await watchOnce(watchInput(harness))).status).toBe("quiet");
    expect(harness.stub.getHits()).toHaveLength(hitCount);
    expect((await derivePrState(watchInput(harness))).phase).toBe("ended");
  });

  it("records a human close as a terminal rejection", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/close", {
      ...repository,
      pullNumber: harness.prNumber,
    });

    await watchOnce(watchInput(harness));

    expect(await lifecycleEvents(harness.store)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pr_closed_rejected",
          runSpecDigest: "run-spec-1",
          detail: expect.objectContaining({ reason: "closed_unmerged" }),
        }),
        expect.objectContaining({ kind: "watch_ended" }),
      ]),
    );
  });

  it("marks every family when the base branch advances", async () => {
    const harness = await createHarness();
    await control(harness.stub, "/__test/advance-base", {
      ...repository,
      branch: "main",
      tree: { README: "advanced\n" },
    });

    await expect(watchOnce(watchInput(harness))).resolves.toMatchObject({
      status: "actions_taken",
      phase: "reproving",
    });
    await watchOnce(watchInput(harness));

    const events = await lifecycleEvents(harness.store);
    expect(
      events.filter(
        ({ kind, detail }) =>
          kind === "reproof_started" &&
          typeof detail === "object" &&
          detail !== null &&
          !Array.isArray(detail) &&
          detail.reason === "base_branch_advanced",
      ),
    ).toHaveLength(1);
    expect(postedComments(harness.stub, harness.prNumber)).toHaveLength(1);
    const stored = await harness.store.get(verdictKey("project", familyId));
    expect(stored).not.toBeNull();
    expect(
      JSON.parse(Buffer.from(stored!.body).toString("utf8")),
    ).toMatchObject({
      reproof_requested: true,
      reproof_request_ids: [expect.stringMatching(/^base:/)],
    });
  });

  it("lets only one concurrent worker hold the fenced PR lock", async () => {
    const harness = await createHarness();
    let releaseFirst: (() => void) | undefined;
    let announceFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const firstCanContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const blockedClient: GithubClient = {
      ...harness.githubClient,
      async getPullRequest(input) {
        announceFirst?.();
        await firstCanContinue;
        return harness.githubClient.getPullRequest(input);
      },
    };

    const first = watchOnce(watchInput(harness, blockedClient));
    await firstEntered;
    await expect(watchOnce(watchInput(harness))).resolves.toMatchObject({
      status: "lock_held",
      actions: [],
    });
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ status: "quiet" });
  });
});
