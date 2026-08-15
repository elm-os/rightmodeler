import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  computeRunSpecDigest,
  FsStore,
  jsonValueSchema,
} from "@rightmodeler/core";
import {
  approveDrift,
  detectDrift,
  type CorpusDefinition,
  type CorpusManifest,
  type HistoricalRunBundle,
} from "@rightmodeler/kernel";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCorpus,
  openAiJsonlAdapter,
  parseTraceRecords,
  scrubRuns,
  writeCorpus,
  langfuseAdapter,
  type Corpus,
} from "./data/index.js";
import {
  approveDriftProposal,
  DriftServiceError,
  publishDriftProposal,
  readActiveCorpus,
  runDrift,
  type RunDriftResult,
} from "./drift.js";
import { executeCli } from "./cli.js";
import { assertContractArtifact } from "./contract-validation.js";
import { writeCheckpoint } from "./state.js";

interface TraceRecordOptions {
  readonly caseId: string;
  readonly family: string;
  readonly model: string;
  readonly prompt?: string;
  readonly output?: string;
  readonly timestamp?: string;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly retryCount?: number;
  readonly evaluator?: string;
  readonly evaluatorVersion?: string;
}

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly storeRoot: string;
  readonly store: FsStore;
  readonly parentCorpusVersionId: string;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function traceRecord(options: TraceRecordOptions): Record<string, unknown> {
  return {
    case_id: options.caseId,
    name: options.family,
    model: options.model,
    messages: [
      { role: "user", content: options.prompt ?? "Classify this request" },
    ],
    response: {
      model: options.model,
      choices: [
        {
          message: {
            role: "assistant",
            content: options.output ?? '{"status":"open"}',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
    ...(options.timestamp === undefined
      ? {}
      : { timestamp: options.timestamp }),
    ...(options.costUsd === undefined ? {} : { cost_usd: options.costUsd }),
    ...(options.durationMs === undefined
      ? {}
      : { duration_ms: options.durationMs }),
    ...(options.retryCount === undefined
      ? {}
      : { retry_count: options.retryCount }),
    ...(options.evaluator === undefined
      ? {}
      : { evaluator: options.evaluator }),
    ...(options.evaluatorVersion === undefined
      ? {}
      : { evaluator_version: options.evaluatorVersion }),
  };
}

function traceText(records: readonly Record<string, unknown>[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

async function createFixture(
  records: readonly Record<string, unknown>[],
): Promise<Fixture> {
  return createCorpusFixture(
    buildCorpus(scrubRuns(openAiJsonlAdapter.adapt(records)).runs, {
      seed: 42,
    }),
  );
}

async function createCorpusFixture(corpus: Corpus): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-drift-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const storeRoot = join(root, "store");
  await mkdir(repo);
  const store = new FsStore(storeRoot);
  await writeCorpus(store, "project", corpus);
  const outputKey = "project/setup/corpus-fixture.json";
  await store.putImmutable(
    outputKey,
    Buffer.from(
      canonicalJson({
        corpusVersionId: corpus.corpusVersionId,
        seed: corpus.seed,
        caseCount: corpus.cases.length,
        strata: corpus.strata.map((stratum) => ({ ...stratum })),
      }),
      "utf8",
    ),
  );
  await writeCheckpoint(store, "project", "corpus", {
    inputDigest: "fixture",
    outputKey,
    completedAt: "2026-07-13T12:00:00.000Z",
  });
  return {
    root,
    repo,
    storeRoot,
    store,
    parentCorpusVersionId: corpus.corpusVersionId,
  };
}

async function writeTrace(
  fixture: Fixture,
  name: string,
  records: readonly Record<string, unknown>[],
): Promise<string> {
  const path = join(fixture.root, name);
  await writeFile(path, traceText(records), "utf8");
  return path;
}

async function storeJson(store: FsStore, key: string): Promise<unknown> {
  const entry = await store.get(key);
  expect(entry).not.toBeNull();
  return JSON.parse(Buffer.from(entry!.body).toString("utf8")) as unknown;
}

async function replaceStoreEntry(
  store: FsStore,
  key: string,
  body: Uint8Array,
): Promise<void> {
  const entry = await store.get(key);
  expect(entry).not.toBeNull();
  expect(
    await store.compareAndSwap(key, entry!.version, body, entry!.fenceToken),
  ).toBe(true);
}

async function replaceActivePointer(
  store: FsStore,
  corpusVersionId: string,
  contentDigest = `sha256:${corpusVersionId}`,
): Promise<void> {
  const key = "project/corpus/active.json";
  const entry = await store.get(key);
  expect(entry).not.toBeNull();
  expect(
    await store.compareAndSwap(
      key,
      entry!.version,
      Buffer.from(
        canonicalJson({ version: 1, corpusVersionId, contentDigest }),
        "utf8",
      ),
      entry!.fenceToken,
    ),
  ).toBe(true);
}

async function createModelDriftProposal(): Promise<{
  fixture: Fixture;
  traces: string;
  proposed: RunDriftResult;
}> {
  const fixture = await createFixture([
    traceRecord({
      caseId: "trajectory-a",
      family: "support",
      model: "acme/large-1",
    }),
  ]);
  const traces = await writeTrace(fixture, "candidate.jsonl", [
    traceRecord({
      caseId: "trajectory-a",
      family: "support",
      model: "acme/small-1",
    }),
  ]);
  const proposed = await runDrift({
    repo: fixture.repo,
    store: fixture.storeRoot,
    traces,
  });
  return { fixture, traces, proposed };
}

describe("drift service", () => {
  it("persists stable family, model, and new-step drift with a rendered proposal", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
      }),
    ]);
    const traces = await writeTrace(fixture, "candidate.jsonl", [
      traceRecord({
        caseId: "trajectory-a",
        family: "triage",
        model: "acme/small-1",
      }),
      traceRecord({
        caseId: "trajectory-a",
        family: "triage",
        model: "acme/small-1",
        prompt: "A new second step",
      }),
    ]);

    const result = await runDrift({
      repo: fixture.repo,
      store: fixture.storeRoot,
      traces,
    });

    expect(result.proposal).toMatchObject({
      status: "proposed",
      approval: null,
      parent_corpus_version_id: `sha256:${fixture.parentCorpusVersionId}`,
    });
    expect(result.proposal.signals).toEqual(
      expect.arrayContaining(["evaluator", "model"]),
    );
    expect(result.proposal.proposed_changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "add", signal: "none" }),
        expect.objectContaining({ action: "relabel", signal: "evaluator" }),
        expect.objectContaining({ action: "relabel", signal: "model" }),
      ]),
    );
    expect(
      result.proposal.proposed_changes.filter(
        ({ action }) => action === "retire",
      ),
    ).toEqual([]);
    expect(await storeJson(fixture.store, result.proposalKey)).toEqual(
      result.proposal,
    );
    expect(await readFile(result.reportPath, "utf8")).toContain(
      "# Corpus drift proposal",
    );
    expect(
      await fixture.store.get(
        result.proposalKey.replace("proposed", "approved"),
      ),
    ).toBeNull();
    expect(
      await fixture.store.get(
        result.proposalKey.replace("proposed", "published"),
      ),
    ).toBeNull();
  });

  it("fails loudly when the new trace batch cannot be parsed", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
      }),
    ]);
    const traces = join(fixture.root, "invalid.jsonl");
    await writeFile(traces, '{"messages":[]}\nnot-json', "utf8");

    await expect(
      runDrift({
        repo: fixture.repo,
        store: fixture.storeRoot,
        traces,
      }),
    ).rejects.toThrow("Invalid JSON object at trace line 2");

    const partiallyInvalid = join(fixture.root, "partially-invalid.jsonl");
    await writeFile(
      partiallyInvalid,
      traceText([
        traceRecord({
          caseId: "trajectory-a",
          family: "support",
          model: "acme/small-1",
        }),
        { case_id: "broken", messages: [] },
      ]),
      "utf8",
    );
    await expect(
      runDrift({
        repo: fixture.repo,
        store: fixture.storeRoot,
        traces: partiallyInvalid,
      }),
    ).rejects.toThrow("dropped 1 unmappable record");
  });

  it("names a malformed active corpus pointer", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
      }),
    ]);
    await readActiveCorpus({ repo: fixture.repo, store: fixture.storeRoot });
    const key = "project/corpus/active.json";
    const active = await fixture.store.get(key);
    expect(active).not.toBeNull();
    expect(
      await fixture.store.compareAndSwap(
        key,
        active!.version,
        Buffer.from("{}", "utf8"),
        active!.fenceToken,
      ),
    ).toBe(true);

    await expect(
      readActiveCorpus({ repo: fixture.repo, store: fixture.storeRoot }),
    ).rejects.toMatchObject({
      code: "active_corpus_malformed",
    } satisfies Partial<DriftServiceError>);
  });

  it("maps test_approved_drift_publishes_new_immutable_parented_version and advances future comparisons", async () => {
    const { fixture, proposed, traces } = await createModelDriftProposal();

    const approved = await approveDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
      actor: "tester",
      reason: "reviewed model drift",
      timestamp: "2026-07-13T12:00:00.000Z",
    });
    const activeBeforePublish = await storeJson(
      fixture.store,
      "project/corpus/active.json",
    );
    expect(approved.proposal.status).toBe("approved");
    expect(activeBeforePublish).toMatchObject({
      corpusVersionId: fixture.parentCorpusVersionId,
    });

    const published = await publishDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
    });
    const manifest = (await storeJson(
      fixture.store,
      published.manifestKey,
    )) as {
      version: string;
      content_digest: string;
      parent_version: string;
      cases: Array<{ case_id: string }>;
    };
    const benchmarkCases = (await storeJson(
      fixture.store,
      published.benchmarkCasesKey,
    )) as { version: string; cases: Array<{ case_id: string }> };
    const internalManifest = (await storeJson(
      fixture.store,
      `project/corpus/corpus-${published.corpusVersionId}.json`,
    )) as { cases: Array<{ caseId: string }> };
    const activeAfterPublish = await storeJson(
      fixture.store,
      "project/corpus/active.json",
    );

    assertContractArtifact("corpus-drift-proposal", proposed.proposal);
    assertContractArtifact("corpus-drift-proposal", approved.proposal);
    assertContractArtifact("corpus-drift-proposal", published.proposal);
    assertContractArtifact("corpus-manifest", manifest);
    assertContractArtifact("benchmark-cases", benchmarkCases);

    expect(published.proposal.status).toBe("published");
    expect(published.corpusVersionId).toBe(proposed.candidateCorpusVersionId);
    expect(manifest.parent_version).toBe(
      proposed.proposal.parent_corpus_version_id,
    );
    expect(manifest.version).toBe("2");
    expect(benchmarkCases.version).toBe("2");
    expect(manifest.cases.map(({ case_id }) => case_id)).toEqual(
      internalManifest.cases.map(({ caseId }) => caseId),
    );
    expect(benchmarkCases.cases).toEqual(manifest.cases);
    expect(activeAfterPublish).toEqual({
      version: 1,
      corpusVersionId: published.corpusVersionId,
      contentDigest: manifest.content_digest,
    });
    expect(await fixture.store.get(published.benchmarkCasesKey)).not.toBeNull();
    expect(
      await fixture.store.get(
        `project/corpus/corpus-${published.corpusVersionId}.json`,
      ),
    ).not.toBeNull();
    expect(await storeJson(fixture.store, proposed.proposalKey)).toMatchObject({
      status: "proposed",
      approval: null,
    });
    expect(await storeJson(fixture.store, approved.proposalKey)).toMatchObject({
      status: "approved",
      approval: { actor: "tester" },
    });
    expect(await storeJson(fixture.store, published.proposalKey)).toMatchObject(
      {
        status: "published",
        approval: { actor: "tester" },
      },
    );

    const next = await runDrift({
      repo: fixture.repo,
      store: fixture.storeRoot,
      traces,
    });
    expect(next.proposal.parent_corpus_version_id).toBe(
      manifest.content_digest,
    );
    expect(next.proposal.signals).toEqual(["none"]);
    expect(next.proposal.proposed_changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "no-change",
          detail: expect.stringContaining("not evaluated"),
        }),
      ]),
    );
    await expect(
      approveDriftProposal({
        repo: fixture.repo,
        store: fixture.storeRoot,
        proposalId: proposed.proposal.proposal_id,
        actor: "tester",
        reason: "reviewed model drift",
      }),
    ).rejects.toThrow("published drift cannot be re-approved");
  });

  it("maps test_publish_requires_approved_proposal", async () => {
    const { fixture, proposed } = await createModelDriftProposal();

    await expect(
      publishDriftProposal({
        repo: fixture.repo,
        store: fixture.storeRoot,
        proposalId: proposed.proposal.proposal_id,
      }),
    ).rejects.toThrow("corpus publication requires an approved drift proposal");
    expect(
      await fixture.store.get(
        proposed.proposalKey.replace("proposed", "published"),
      ),
    ).toBeNull();
  });

  it("runs propose, approve, and publish through the CLI", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
      }),
    ]);
    const traces = await writeTrace(fixture, "candidate.jsonl", [
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/small-1",
      }),
    ]);
    const common = [
      "--repo",
      fixture.repo,
      "--store",
      fixture.storeRoot,
      "--output",
      "json",
    ];

    const proposed = await runCliJson([...common, "drift", "--traces", traces]);
    expect(proposed.code, proposed.stderr).toBe(0);
    expect(proposed.value.proposal.status).toBe("proposed");

    const approved = await runCliJson([
      ...common,
      "drift",
      "approve",
      "--proposal",
      proposed.value.proposal.proposal_id,
      "--actor",
      "tester",
    ]);
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.value.proposal.status).toBe("approved");

    const published = await runCliJson([
      ...common,
      "drift",
      "publish",
      "--proposal",
      proposed.value.proposal.proposal_id,
    ]);
    expect(published.code, published.stderr).toBe(0);
    expect(published.value.proposal.status).toBe("published");
  });

  it("reports an invalid proposal id with a named code", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
      }),
    ]);

    const result = await runCli([
      "--repo",
      fixture.repo,
      "--store",
      fixture.storeRoot,
      "--output",
      "json",
      "drift",
      "approve",
      "--proposal",
      "not-a-proposal-id",
      "--actor",
      "tester",
    ]);

    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "drift_proposal_missing",
    });
  });

  it("names malformed proposed and candidate artifacts", async () => {
    const proposedFixture = await createModelDriftProposal();
    await replaceStoreEntry(
      proposedFixture.fixture.store,
      proposedFixture.proposed.proposalKey,
      Buffer.from("{", "utf8"),
    );

    await expect(
      approveDriftProposal({
        repo: proposedFixture.fixture.repo,
        store: proposedFixture.fixture.storeRoot,
        proposalId: proposedFixture.proposed.proposal.proposal_id,
        actor: "tester",
      }),
    ).rejects.toMatchObject({
      code: "drift_artifact_malformed",
    } satisfies Partial<DriftServiceError>);

    const candidateFixture = await createModelDriftProposal();
    await replaceStoreEntry(
      candidateFixture.fixture.store,
      candidateFixture.proposed.proposalKey.replace(
        "proposed.json",
        "candidate.json",
      ),
      Buffer.from("{}", "utf8"),
    );

    await expect(
      publishDriftProposal({
        repo: candidateFixture.fixture.repo,
        store: candidateFixture.fixture.storeRoot,
        proposalId: candidateFixture.proposed.proposal.proposal_id,
      }),
    ).rejects.toMatchObject({
      code: "drift_artifact_malformed",
    } satisfies Partial<DriftServiceError>);
  });

  it("fails loudly when immutable approval or publication snapshots are tampered", async () => {
    const { fixture, proposed } = await createModelDriftProposal();
    const approval = {
      actor: "tester",
      timestamp: "2026-07-13T12:00:00.000Z",
      reason: null,
    };
    const tampered = {
      ...proposed.proposal,
      signals: ["tool"],
      approval,
    };
    const approvedKey = proposed.proposalKey.replace("proposed", "approved");
    await fixture.store.putImmutable(
      approvedKey,
      Buffer.from(JSON.stringify({ ...tampered, status: "approved" }), "utf8"),
    );

    await expect(
      approveDriftProposal({
        repo: fixture.repo,
        store: fixture.storeRoot,
        proposalId: proposed.proposal.proposal_id,
        actor: "tester",
      }),
    ).rejects.toMatchObject({
      code: "drift_artifact_malformed",
      message: expect.stringContaining(
        "drift proposal digest does not match its contents",
      ),
    } satisfies Partial<DriftServiceError>);

    const publishedKey = proposed.proposalKey.replace("proposed", "published");
    await fixture.store.putImmutable(
      publishedKey,
      Buffer.from(JSON.stringify({ ...tampered, status: "published" }), "utf8"),
    );
    await expect(
      publishDriftProposal({
        repo: fixture.repo,
        store: fixture.storeRoot,
        proposalId: proposed.proposal.proposal_id,
      }),
    ).rejects.toMatchObject({
      code: "drift_artifact_malformed",
      message: expect.stringContaining(
        "drift proposal digest does not match its contents",
      ),
    } satisfies Partial<DriftServiceError>);
  });

  it("refuses publication after the active corpus moves away from the proposal parent", async () => {
    const { fixture, proposed } = await createModelDriftProposal();
    await approveDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
      actor: "tester",
    });
    await replaceActivePointer(fixture.store, "f".repeat(64));

    await expect(
      publishDriftProposal({
        repo: fixture.repo,
        store: fixture.storeRoot,
        proposalId: proposed.proposal.proposal_id,
      }),
    ).rejects.toMatchObject({
      name: "DriftServiceError",
      code: "stale_corpus_parent",
    } satisfies Partial<DriftServiceError>);
    expect(
      await fixture.store.get(
        proposed.proposalKey.replace("proposed.json", "corpus-manifest.json"),
      ),
    ).toBeNull();
    expect(
      await fixture.store.get(
        proposed.proposalKey.replace("proposed.json", "benchmark-cases.json"),
      ),
    ).toBeNull();
    expect(
      await fixture.store.get(
        `project/corpus/corpus-${proposed.candidateCorpusVersionId}.json`,
      ),
    ).toBeNull();
  });

  it("resumes publication after the active-pointer commit", async () => {
    const { fixture, proposed } = await createModelDriftProposal();
    await approveDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
      actor: "tester",
    });
    const published = await publishDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
    });
    await rm(
      join(
        fixture.storeRoot,
        ".rightmodeler-store",
        "entries",
        published.proposalKey,
      ),
      { recursive: true },
    );

    const resumed = await publishDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
    });

    expect(resumed.proposal.status).toBe("published");
    expect(resumed.corpusVersionId).toBe(published.corpusVersionId);
    expect(await fixture.store.get(resumed.proposalKey)).not.toBeNull();
  });

  it("preserves reviewed splits when one of six cases changes content", async () => {
    const parentRecords = Array.from({ length: 6 }, (_, index) =>
      traceRecord({
        caseId: `trajectory-${index}`,
        family: "support",
        model: "acme/large-1",
        prompt: `Prompt ${index}`,
      }),
    );
    const fixture = await createFixture(parentRecords);
    const traces = await writeTrace(
      fixture,
      "candidate-six.jsonl",
      parentRecords.map((record, index) =>
        index === 0
          ? {
              ...record,
              model: "acme/small-1",
              response: {
                ...(record.response as object),
                model: "acme/small-1",
              },
            }
          : record,
      ),
    );
    const common = [
      "--repo",
      fixture.repo,
      "--store",
      fixture.storeRoot,
      "--output",
      "json",
    ];

    const proposed = await runCliJson([...common, "drift", "--traces", traces]);
    expect(proposed.code, proposed.stderr).toBe(0);
    expect(proposed.value.proposal.exposed_holdout_case_ids).toEqual([]);
    const approved = await runCliJson([
      ...common,
      "drift",
      "approve",
      "--proposal",
      proposed.value.proposal.proposal_id,
      "--actor",
      "tester",
    ]);
    expect(approved.code, approved.stderr).toBe(0);
    const published = await runCliJson([
      ...common,
      "drift",
      "publish",
      "--proposal",
      proposed.value.proposal.proposal_id,
    ]);

    expect(published.code, published.stderr).toBe(0);
    expect(published.value.proposal.status).toBe("published");
  });

  it("refuses a genuine exposed holdout before publication writes", async () => {
    const fixture = await createFixture(
      Array.from({ length: 6 }, (_, index) =>
        traceRecord({
          caseId: `trajectory-${index}`,
          family: "support",
          model: "acme/large-1",
          prompt: `Prompt ${index}`,
        }),
      ),
    );
    const active = await readActiveCorpus({
      repo: fixture.repo,
      store: fixture.storeRoot,
    });
    const holdout = active.corpus.cases.find(
      ({ split }) => split === "holdout",
    );
    if (holdout === undefined) throw new Error("fixture has no holdout case");
    const candidateCorpus: Corpus = {
      ...active.corpus,
      contractVersion: (active.corpus.contractVersion ?? 1) + 1,
      cases: active.corpus.cases.map((corpusCase) => ({
        ...corpusCase,
        split:
          corpusCase.caseId === holdout.caseId ? "shortlist" : corpusCase.split,
      })),
    };
    const parentInputs = contractDriftInputs(
      active.corpus,
      active.contentDigest,
      null,
    );
    const candidateInputs = contractDriftInputs(
      candidateCorpus,
      `sha256:${candidateCorpus.corpusVersionId}`,
      active.contentDigest,
    );
    const approved = approveDrift(
      detectDrift(
        parentInputs.manifest,
        parentInputs.bundle,
        candidateInputs.bundle,
        candidateInputs.definition,
      ),
      "tester",
      null,
      "2026-08-01T12:00:00.000Z",
    );
    expect(approved.exposed_holdout_case_ids).toEqual([holdout.caseId]);
    expect(approved.replacement_holdout_case_ids).toEqual([]);
    const proposalDigest = approved.proposal_id.slice("sha256:".length);
    const prefix = `project/corpus/drift/${proposalDigest}`;
    await fixture.store.putImmutable(
      `${prefix}/candidate.json`,
      Buffer.from(
        canonicalJson(
          jsonValueSchema.parse({
            version: 1,
            parentCorpusVersionId: active.corpus.corpusVersionId,
            parentContentDigest: active.contentDigest,
            candidateCorpus,
          }),
        ),
        "utf8",
      ),
    );
    await fixture.store.putImmutable(
      `${prefix}/approved.json`,
      Buffer.from(canonicalJson(jsonValueSchema.parse(approved)), "utf8"),
    );
    const activeBefore = await storeJson(
      fixture.store,
      "project/corpus/active.json",
    );

    const result = await runCli([
      "--repo",
      fixture.repo,
      "--store",
      fixture.storeRoot,
      "--output",
      "json",
      "drift",
      "publish",
      "--proposal",
      approved.proposal_id,
    ]);

    expect(result.code).toBe(10);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "exposed_holdout_unreplaced",
    });
    expect(
      await storeJson(fixture.store, "project/corpus/active.json"),
    ).toEqual(activeBefore);
    expect(
      await fixture.store.get(`${prefix}/corpus-manifest.json`),
    ).toBeNull();
    expect(
      await fixture.store.get(`${prefix}/benchmark-cases.json`),
    ).toBeNull();
    expect(await fixture.store.get(`${prefix}/published.json`)).toBeNull();
  });

  it("names duplicate drift cases before invoking the kernel", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
      }),
    ]);
    const active = await readActiveCorpus({
      repo: fixture.repo,
      store: fixture.storeRoot,
    });
    const validCandidate: Corpus = {
      ...active.corpus,
      contractVersion: (active.corpus.contractVersion ?? 1) + 1,
    };
    const parentInputs = contractDriftInputs(
      active.corpus,
      active.contentDigest,
      null,
    );
    const candidateInputs = contractDriftInputs(
      validCandidate,
      `sha256:${validCandidate.corpusVersionId}`,
      active.contentDigest,
    );
    const approved = approveDrift(
      detectDrift(
        parentInputs.manifest,
        parentInputs.bundle,
        candidateInputs.bundle,
        candidateInputs.definition,
      ),
      "tester",
      null,
      "2026-08-01T12:00:00.000Z",
    );
    const proposalDigest = approved.proposal_id.slice("sha256:".length);
    const prefix = `project/corpus/drift/${proposalDigest}`;
    await fixture.store.putImmutable(
      `${prefix}/candidate.json`,
      Buffer.from(
        canonicalJson(
          jsonValueSchema.parse({
            version: 1,
            parentCorpusVersionId: active.corpus.corpusVersionId,
            parentContentDigest: active.contentDigest,
            candidateCorpus: {
              ...validCandidate,
              cases: [
                validCandidate.cases[0]!,
                { ...validCandidate.cases[0]! },
              ],
            },
          }),
        ),
        "utf8",
      ),
    );
    await fixture.store.putImmutable(
      `${prefix}/approved.json`,
      Buffer.from(canonicalJson(jsonValueSchema.parse(approved)), "utf8"),
    );

    const result = await runCli([
      "--repo",
      fixture.repo,
      "--store",
      fixture.storeRoot,
      "--output",
      "json",
      "drift",
      "publish",
      "--proposal",
      approved.proposal_id,
    ]);

    expect(result.code).toBe(10);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "duplicate_drift_case",
    });
  });

  it("keeps call identity stable when timestamped OpenAI lines reorder", async () => {
    const records = Array.from({ length: 3 }, (_, index) =>
      traceRecord({
        caseId: "shared-trajectory",
        family: "support",
        model: "acme/large-1",
        prompt: `Prompt ${index}`,
        timestamp: `2026-08-01T12:00:0${index}.000Z`,
      }),
    );
    const fixture = await createFixture(records);
    const traces = await writeTrace(fixture, "reordered.jsonl", [
      records[2]!,
      records[0]!,
      records[1]!,
    ]);

    const proposed = await runDrift({
      repo: fixture.repo,
      store: fixture.storeRoot,
      traces,
    });

    expect(proposed.proposal.signals).toEqual(["none"]);
    expect(
      proposed.proposal.proposed_changes.filter(({ action }) =>
        ["add", "retire", "relabel", "red-team"].includes(action),
      ),
    ).toEqual([]);
  });

  it("keeps source run identities distinct across traces in one session", async () => {
    const records = [
      langfuseRecord("trace-1", "shared-session", "acme/large-1", "00"),
      langfuseRecord("trace-2", "shared-session", "acme/large-1", "01"),
    ];
    const fixture = await createCorpusFixture(
      buildCorpus(scrubRuns(langfuseAdapter.adapt(records)).runs, { seed: 42 }),
    );
    const candidateRecords = records.map((record) => ({
      ...record,
      provided_model_name: "acme/small-1",
    }));
    const traces = await writeTrace(
      fixture,
      "langfuse-candidate.jsonl",
      candidateRecords,
    );
    const proposed = await runDrift({
      repo: fixture.repo,
      store: fixture.storeRoot,
      traces,
    });
    await approveDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
      actor: "tester",
    });
    const published = await publishDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
    });
    const manifest = (await storeJson(
      fixture.store,
      published.manifestKey,
    )) as { cases: Array<{ source_run_id: string }> };

    expect(manifest.cases).toHaveLength(2);
    expect(
      new Set(manifest.cases.map(({ source_run_id }) => source_run_id)).size,
    ).toBe(2);
  });

  it("detects real comparable cost and latency drift", async () => {
    const fixture = await createFixture([
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
        costUsd: 0.1,
        durationMs: 100,
      }),
    ]);
    const traces = await writeTrace(fixture, "metrics.jsonl", [
      traceRecord({
        caseId: "trajectory-a",
        family: "support",
        model: "acme/large-1",
        costUsd: 0.13,
        durationMs: 121,
      }),
    ]);
    const parent = await readActiveCorpus({
      repo: fixture.repo,
      store: fixture.storeRoot,
    });

    const proposed = await runDrift({
      repo: fixture.repo,
      store: fixture.storeRoot,
      traces,
    });

    expect(proposed.proposal.signals).toEqual(
      expect.arrayContaining(["cost", "latency"]),
    );
    expect(proposed.candidateCorpusVersionId).not.toBe(
      parent.corpus.corpusVersionId,
    );
    await approveDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
      actor: "tester",
    });
    const published = await publishDriftProposal({
      repo: fixture.repo,
      store: fixture.storeRoot,
      proposalId: proposed.proposal.proposal_id,
    });
    const next = await readActiveCorpus({
      repo: fixture.repo,
      store: fixture.storeRoot,
    });

    expect(published.corpusVersionId).toBe(proposed.candidateCorpusVersionId);
    expect(next.corpus.cases.map(({ caseId }) => caseId)).toEqual(
      parent.corpus.cases.map(({ caseId }) => caseId),
    );
  });

  it("names drift dimensions that old evidence cannot evaluate", async () => {
    const { proposed } = await createModelDriftProposal();

    expect(proposed.proposal.proposed_changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "cost",
          detail: "cost drift not evaluated: a real cost observation is absent",
        }),
        expect.objectContaining({
          signal: "latency",
          detail:
            "latency drift not evaluated: a real duration observation is absent",
        }),
        expect.objectContaining({
          signal: "evaluator",
          detail: expect.stringContaining("risk drift not evaluated"),
        }),
      ]),
    );
  });
});

function langfuseRecord(
  traceId: string,
  sessionId: string,
  model: string,
  second: string,
): Record<string, unknown> {
  return {
    id: `observation-${traceId}`,
    trace_id: traceId,
    parent_observation_id: "",
    type: "GENERATION",
    name: "support",
    start_time: `2026-08-01 12:00:${second}.000000`,
    session_id: sessionId,
    input: JSON.stringify({ messages: [{ role: "user", content: traceId }] }),
    output: JSON.stringify({ role: "assistant", content: "ok" }),
    provided_model_name: model,
    usage_details: { input: 10, output: 4, total: 14 },
  };
}

function contractDriftInputs(
  corpus: Corpus,
  contentDigest: string,
  parentVersion: string | null,
): {
  manifest: CorpusManifest;
  definition: CorpusDefinition;
  bundle: HistoricalRunBundle;
} {
  const cases = corpus.cases
    .map((corpusCase) => ({
      case_id: corpusCase.caseId,
      source_run_id: computeRunSpecDigest({
        traceId:
          corpusCase.observation?.traceId ?? corpusCase.content.trajectoryId,
        stepIndex: corpusCase.content.stepIndex,
      }),
      pipeline_family: "reference-freeform" as const,
      workload_label: corpusCase.content.family,
      split:
        corpusCase.split === "shortlist"
          ? ("working" as const)
          : ("holdout" as const),
      risk: "normal" as const,
      required_evidence: "reference" as const,
      checks: {},
    }))
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
  const version = String(corpus.contractVersion ?? 1);
  const bundle: HistoricalRunBundle = {
    version: "1",
    bundle_id: corpus.corpusVersionId,
    runs: corpus.cases.map((corpusCase) => ({
      id: computeRunSpecDigest({
        traceId:
          corpusCase.observation?.traceId ?? corpusCase.content.trajectoryId,
        stepIndex: corpusCase.content.stepIndex,
      }),
      prompt: canonicalJson({ messages: corpusCase.content.messages }),
      model: corpusCase.content.model,
      success: true,
    })),
  };
  return {
    bundle,
    definition: {
      version,
      corpus_id: "rightmodeler",
      parent_version: parentVersion,
      cases,
    },
    manifest: {
      version,
      corpus_id: "rightmodeler",
      corpus_version: version,
      parent_version: parentVersion,
      source_bundle_id: corpus.corpusVersionId,
      content_digest: contentDigest,
      cases,
    },
  };
}

async function runCli(args: readonly string[]): Promise<{
  code: number;
  stderr: string;
  stdout: string;
}> {
  let stdout = "";
  let stderr = "";
  const code = await executeCli([...args], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stderr, stdout };
}

async function runCliJson(args: readonly string[]): Promise<{
  code: number;
  stderr: string;
  value: {
    proposal: {
      proposal_id: string;
      status: string;
      exposed_holdout_case_ids: string[];
    };
  };
}> {
  const result = await runCli(args);
  return {
    code: result.code,
    stderr: result.stderr,
    value: JSON.parse(result.stdout) as {
      proposal: {
        proposal_id: string;
        status: string;
        exposed_holdout_case_ids: string[];
      };
    },
  };
}
