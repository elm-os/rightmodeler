import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  caseKey,
  computeRunSpecDigest,
  FsStore,
  jsonValueSchema,
  reportKey,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import {
  approveDrift,
  assignDriftSplit,
  assertDriftProposalIntegrity,
  detectDrift,
  publishDrift,
  type ApprovedCorpusDriftProposal,
  type CorpusCaseDefinition,
  type CorpusDefinition,
  type CorpusDriftProposal,
  type CorpusManifest,
  type DriftNotEvaluated,
  type HistoricalRun,
  type HistoricalRunBundle,
  type ProposedCorpusDriftProposal,
  type PublishedCorpusDriftProposal,
} from "@rightmodeler/kernel";
import { z } from "zod";

import {
  adaptWithReport,
  buildCorpus,
  detectFormat,
  parseTraceRecords,
  refreshCorpusVersionId,
  scrubRuns,
  strictRuns,
  traceAdapters,
  writeCorpus,
  type Corpus,
  type CorpusCaseContent,
} from "./data/index.js";
import {
  assertContractArtifact,
  putContractArtifact,
} from "./contract-validation.js";
import { readJson, readSetupState } from "./state.js";

const PROJECT_ID = "project";
const ACTIVE_CORPUS_KEY = `${PROJECT_ID}/corpus/active.json`;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const corpusVersionIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const corpusCaseContentSchema = z.strictObject({
  family: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
  messages: z.array(z.json()),
  output: z.json(),
  trajectoryId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
});
const corpusCaseObservationSchema = z.strictObject({
  traceId: z.string().min(1).optional(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  timestamp: z.string().min(1).optional(),
  costUsd: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  toolCalls: z.array(z.json()),
  evaluator: z.json().optional(),
  evaluatorVersion: z.json().optional(),
  retryCount: z.number().int().nonnegative().optional(),
});
const corpusManifestSchema = z.strictObject({
  corpusVersionId: corpusVersionIdSchema,
  contractVersion: z.number().int().positive().optional(),
  seed: z.number().int(),
  cases: z.array(
    z.strictObject({
      caseId: corpusVersionIdSchema,
      family: z.string().min(1),
      split: z.enum(["shortlist", "holdout"]),
      observation: corpusCaseObservationSchema.optional(),
    }),
  ),
  strata: z.array(
    z.strictObject({
      family: z.string().min(1),
      corpusShare: z.number().nonnegative(),
      trafficShare: z.number().nonnegative(),
    }),
  ),
});
const corpusOutputSchema = z.strictObject({
  corpusVersionId: corpusVersionIdSchema,
  seed: z.number().int(),
  caseCount: z.number().int().positive(),
  strata: corpusManifestSchema.shape.strata,
});
const activeCorpusSchema = z.strictObject({
  version: z.literal(1),
  corpusVersionId: corpusVersionIdSchema,
  contentDigest: sha256Schema,
});
const driftChangeSchema = z.strictObject({
  action: z.enum(["add", "relabel", "retire", "red-team", "no-change"]),
  case_id: z.string().min(1),
  signal: z.enum([
    "input",
    "tool",
    "evaluator",
    "acceptance",
    "model",
    "cost",
    "latency",
    "retry",
    "trajectory",
    "none",
  ]),
  detail: z.string().min(1),
});
const approvalSchema = z.strictObject({
  actor: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  reason: z.string().nullable(),
});
const proposalSchema = z.strictObject({
  version: z.string(),
  proposal_id: sha256Schema,
  parent_corpus_version_id: sha256Schema,
  candidate_definition_digest: sha256Schema,
  status: z.enum(["proposed", "approved", "rejected", "published"]),
  proposed_changes: z.array(driftChangeSchema).min(1),
  signals: z.array(driftChangeSchema.shape.signal),
  exposed_holdout_case_ids: z.array(z.string().min(1)),
  replacement_holdout_case_ids: z.array(z.string().min(1)),
  approval: approvalSchema.nullable(),
});
const proposedProposalSchema = proposalSchema.extend({
  status: z.literal("proposed"),
  approval: z.null(),
});
const approvedProposalSchema = proposalSchema.extend({
  status: z.literal("approved"),
  approval: approvalSchema,
});
const publishedProposalSchema = proposalSchema.extend({
  status: z.literal("published"),
  approval: approvalSchema,
});
const candidateArtifactSchema = z.strictObject({
  version: z.literal(1),
  parentCorpusVersionId: corpusVersionIdSchema,
  parentContentDigest: sha256Schema,
  candidateCorpus: z.strictObject({
    corpusVersionId: corpusVersionIdSchema,
    contractVersion: z.number().int().positive().optional(),
    seed: z.number().int(),
    cases: z.array(
      z.strictObject({
        caseId: corpusVersionIdSchema,
        content: corpusCaseContentSchema,
        split: z.enum(["shortlist", "holdout"]),
        observation: corpusCaseObservationSchema.optional(),
      }),
    ),
    strata: corpusManifestSchema.shape.strata,
  }),
});

export type DriftServiceErrorCode =
  | "active_corpus_missing"
  | "active_corpus_malformed"
  | "drift_artifact_malformed"
  | "drift_candidate_missing"
  | "drift_proposal_missing"
  | "duplicate_drift_case"
  | "exposed_holdout_unreplaced"
  | "stale_corpus_parent";

export class DriftServiceError extends Error {
  readonly code: DriftServiceErrorCode;

  constructor(code: DriftServiceErrorCode, message: string) {
    super(message);
    this.name = "DriftServiceError";
    this.code = code;
  }
}

export interface RunDriftOptions {
  readonly repo: string;
  readonly store?: string;
  readonly traces: string;
}

export interface ApproveDriftProposalOptions {
  readonly repo: string;
  readonly store?: string;
  readonly proposalId: string;
  readonly actor: string;
  readonly reason?: string;
  readonly timestamp?: string;
}

export interface PublishDriftProposalOptions {
  readonly repo: string;
  readonly store?: string;
  readonly proposalId: string;
}

export interface RunDriftResult {
  readonly proposal: ProposedCorpusDriftProposal;
  readonly candidateCorpusVersionId: string;
  readonly proposalKey: string;
  readonly reportPath: string;
}

export interface ActiveCorpusResult {
  readonly corpus: Corpus;
  readonly contentDigest: string;
}

export async function readActiveCorpus(options: {
  readonly repo: string;
  readonly store?: string;
}): Promise<ActiveCorpusResult> {
  return loadActiveCorpus(context(options).store);
}

export async function readCorpusVersion(
  options: { readonly repo: string; readonly store?: string },
  corpusVersionId: string,
): Promise<Corpus> {
  return loadCorpusVersion(context(options).store, corpusVersionId);
}

export interface ApproveDriftProposalResult {
  readonly proposal: ApprovedCorpusDriftProposal;
  readonly proposalKey: string;
}

export interface PublishDriftProposalResult {
  readonly proposal: PublishedCorpusDriftProposal;
  readonly corpusVersionId: string;
  readonly proposalKey: string;
  readonly manifestKey: string;
  readonly benchmarkCasesKey: string;
}

export async function runDrift(
  options: RunDriftOptions,
): Promise<RunDriftResult> {
  const { store, storeRoot } = context(options);
  const parent = await loadActiveCorpus(store);
  const traceText = await readFile(resolve(options.traces), "utf8");
  const records = parseTraceRecords(traceText);
  const adapter = detectFormat(traceText, traceAdapters);
  const runs = strictRuns(adapter.name, adaptWithReport(adapter, records));
  const candidateCorpus = buildCorpus(scrubRuns(runs).runs, {
    seed: parent.corpus.seed,
  });
  candidateCorpus.contractVersion = (parent.corpus.contractVersion ?? 1) + 1;
  preserveParentSplits(parent.corpus, candidateCorpus);
  refreshCorpusVersionId(candidateCorpus);
  const parentInputs = driftInputs(parent.corpus, parent.contentDigest, null);
  const candidate = driftInputs(
    candidateCorpus,
    digestId(candidateCorpus.corpusVersionId),
    parent.contentDigest,
  );
  const proposal = detectDrift(
    parentInputs.manifest,
    parentInputs.bundle,
    candidate.bundle,
    candidate.definition,
  );
  const keys = driftKeys(proposal.proposal_id);
  validateProposalArtifact(proposedProposalSchema, proposal, "Drift proposal");
  assertContractArtifact("corpus-drift-proposal", proposal);

  await putImmutableJson(store, keys.candidate, {
    version: 1,
    parentCorpusVersionId: parent.corpus.corpusVersionId,
    parentContentDigest: parent.contentDigest,
    candidateCorpus,
  });
  await putContractArtifact(
    store,
    keys.proposed,
    "corpus-drift-proposal",
    proposal,
  );
  const markdown = renderDriftProposal(proposal);
  await store.putImmutable(keys.report, Buffer.from(markdown, "utf8"));
  const reportPath = join(storeRoot, keys.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, markdown, "utf8");

  return {
    proposal,
    candidateCorpusVersionId: candidateCorpus.corpusVersionId,
    proposalKey: keys.proposed,
    reportPath,
  };
}

export async function approveDriftProposal(
  options: ApproveDriftProposalOptions,
): Promise<ApproveDriftProposalResult> {
  const { store } = context(options);
  const keys = driftKeys(options.proposalId);
  const published = await store.get(keys.published);
  if (published !== null) {
    validateProposalArtifact(
      publishedProposalSchema,
      parseArtifactEntry(published.body, "Published drift proposal"),
      "Published drift proposal",
    );
    throw new Error("published drift cannot be re-approved");
  }
  const existing = await store.get(keys.approved);
  if (existing !== null) {
    const approved = validateProposalArtifact(
      approvedProposalSchema,
      parseArtifactEntry(existing.body, "Approved drift proposal"),
      "Approved drift proposal",
    );
    if (
      approved.approval.actor === options.actor &&
      approved.approval.reason === (options.reason ?? null)
    ) {
      return { proposal: approved, proposalKey: keys.approved };
    }
    throw new Error(
      "drift proposal is already approved with different approval metadata",
    );
  }

  const proposed = validateProposalArtifact(
    proposedProposalSchema,
    await requiredArtifactJson(
      store,
      keys.proposed,
      "drift_proposal_missing",
      "Proposed drift proposal",
    ),
    "Proposed drift proposal",
  );
  const approved = approveDrift(
    proposed,
    options.actor,
    options.reason ?? null,
    options.timestamp,
  );
  validateProposalArtifact(
    approvedProposalSchema,
    approved,
    "Approved drift proposal",
  );
  await putContractArtifact(
    store,
    keys.approved,
    "corpus-drift-proposal",
    approved,
  );
  return { proposal: approved, proposalKey: keys.approved };
}

export async function publishDriftProposal(
  options: PublishDriftProposalOptions,
): Promise<PublishDriftProposalResult> {
  const { store } = context(options);
  const keys = driftKeys(options.proposalId);
  const publishedEntry = await store.get(keys.published);
  if (publishedEntry !== null) {
    const proposal = validateProposalArtifact(
      publishedProposalSchema,
      parseArtifactEntry(publishedEntry.body, "Published drift proposal"),
      "Published drift proposal",
    );
    const candidate = validateCandidateArtifact(
      await requiredArtifactJson(
        store,
        keys.candidate,
        "drift_candidate_missing",
        "Drift candidate",
      ),
    );
    return publicationResult(proposal, candidate.candidateCorpus, keys);
  }

  const proposal = await proposalForPublication(store, keys);
  const candidateArtifact = validateCandidateArtifact(
    await requiredArtifactJson(
      store,
      keys.candidate,
      "drift_candidate_missing",
      "Drift candidate",
    ),
  );
  const parentCorpus = await loadCorpusVersion(
    store,
    candidateArtifact.parentCorpusVersionId,
  );
  const parent = driftInputs(
    parentCorpus,
    candidateArtifact.parentContentDigest,
    null,
  );
  const candidate = driftInputs(
    candidateArtifact.candidateCorpus,
    digestId(candidateArtifact.candidateCorpus.corpusVersionId),
    candidateArtifact.parentContentDigest,
  );
  if (
    new Set(proposal.replacement_holdout_case_ids).size <
    new Set(proposal.exposed_holdout_case_ids).size
  ) {
    throw new DriftServiceError(
      "exposed_holdout_unreplaced",
      "Every exposed holdout requires a replacement holdout case",
    );
  }
  let published: ReturnType<typeof publishDrift>;
  try {
    published = publishDrift(
      parent.manifest,
      candidate.bundle,
      candidate.definition,
      proposal,
    );
  } catch (error) {
    if (error instanceof DriftServiceError) throw error;
    throw new DriftServiceError(
      "drift_artifact_malformed",
      `Drift artifacts failed integrity validation: ${errorMessage(error)}`,
    );
  }
  validateProposalArtifact(
    publishedProposalSchema,
    published.proposal,
    "Published drift proposal",
  );
  assertContractArtifact("corpus-drift-proposal", published.proposal);
  assertContractArtifact("corpus-manifest", published.manifest);
  assertContractArtifact("benchmark-cases", published.benchmark_cases);
  await advanceActiveCorpus(
    store,
    parentCorpus.corpusVersionId,
    candidateArtifact.parentContentDigest,
    candidateArtifact.candidateCorpus.corpusVersionId,
    published.manifest.content_digest,
  );
  await writeCorpus(store, PROJECT_ID, candidateArtifact.candidateCorpus);
  await putContractArtifact(
    store,
    keys.manifest,
    "corpus-manifest",
    published.manifest,
  );
  await putContractArtifact(
    store,
    keys.benchmarkCases,
    "benchmark-cases",
    published.benchmark_cases,
  );
  await putContractArtifact(
    store,
    keys.published,
    "corpus-drift-proposal",
    published.proposal,
  );
  return publicationResult(
    published.proposal,
    candidateArtifact.candidateCorpus,
    keys,
  );
}

async function proposalForPublication(
  store: Store,
  keys: ReturnType<typeof driftKeys>,
): Promise<CorpusDriftProposal> {
  const approved = await store.get(keys.approved);
  if (approved !== null) {
    return validateProposalArtifact(
      approvedProposalSchema,
      parseArtifactEntry(approved.body, "Approved drift proposal"),
      "Approved drift proposal",
    );
  }
  return validateProposalArtifact(
    proposedProposalSchema,
    await requiredArtifactJson(
      store,
      keys.proposed,
      "drift_proposal_missing",
      "Proposed drift proposal",
    ),
    "Proposed drift proposal",
  );
}

async function loadActiveCorpus(store: Store): Promise<{
  corpus: Corpus;
  contentDigest: string;
}> {
  for (;;) {
    const active = await store.get(ACTIVE_CORPUS_KEY);
    if (active !== null) {
      const pointer = parseActiveCorpusPointer(active.body);
      return {
        corpus: await loadCorpusVersion(store, pointer.corpusVersionId),
        contentDigest: pointer.contentDigest,
      };
    }

    const state = await readSetupState(store, PROJECT_ID);
    const checkpoint = state.stages.corpus;
    if (checkpoint === undefined) {
      throw new DriftServiceError(
        "active_corpus_missing",
        "Corpus drift requires an existing active corpus",
      );
    }
    let output: z.infer<typeof corpusOutputSchema>;
    try {
      output = corpusOutputSchema.parse(
        await readJson(store, checkpoint.outputKey),
      );
    } catch (error) {
      throw new DriftServiceError(
        "active_corpus_malformed",
        `Corpus checkpoint output is malformed: ${errorMessage(error)}`,
      );
    }
    const body = Buffer.from(
      canonicalJson({
        version: 1,
        corpusVersionId: output.corpusVersionId,
        contentDigest: digestId(output.corpusVersionId),
      }),
      "utf8",
    );
    if (await store.compareAndSwap(ACTIVE_CORPUS_KEY, 0, body, 0)) {
      return {
        corpus: await loadCorpusVersion(store, output.corpusVersionId),
        contentDigest: digestId(output.corpusVersionId),
      };
    }
  }
}

async function loadCorpusVersion(
  store: Store,
  corpusVersionId: string,
): Promise<Corpus> {
  try {
    const parsedId = corpusVersionIdSchema.parse(corpusVersionId);
    const manifest = corpusManifestSchema.parse(
      await requiredJson(
        store,
        `${PROJECT_ID}/corpus/corpus-${parsedId}.json`,
        "active_corpus_missing",
      ),
    );
    const cases = await Promise.all(
      manifest.cases.map(async (item) => {
        const content = corpusCaseContentSchema.parse(
          await requiredJson(
            store,
            caseKey(PROJECT_ID, item.caseId),
            "active_corpus_missing",
          ),
        );
        if (content.family !== item.family) {
          throw new Error(
            `Corpus case ${item.caseId} does not match its manifest family`,
          );
        }
        return {
          caseId: item.caseId,
          content,
          split: item.split,
          ...(item.observation === undefined
            ? {}
            : { observation: item.observation }),
        };
      }),
    );
    return {
      corpusVersionId: manifest.corpusVersionId,
      contractVersion: manifest.contractVersion ?? 1,
      seed: manifest.seed,
      cases,
      strata: manifest.strata,
    };
  } catch (error) {
    if (
      error instanceof DriftServiceError &&
      error.code === "active_corpus_missing"
    ) {
      throw error;
    }
    throw new DriftServiceError(
      "active_corpus_malformed",
      `Corpus version ${corpusVersionId} is malformed: ${errorMessage(error)}`,
    );
  }
}

async function advanceActiveCorpus(
  store: Store,
  parentCorpusVersionId: string,
  parentContentDigest: string,
  candidateCorpusVersionId: string,
  candidateContentDigest: string,
): Promise<void> {
  const active = await store.get(ACTIVE_CORPUS_KEY);
  if (active === null) {
    throw new DriftServiceError(
      "active_corpus_missing",
      "Corpus drift requires an existing active corpus",
    );
  }
  const pointer = parseActiveCorpusPointer(active.body);
  if (
    pointer.corpusVersionId === candidateCorpusVersionId &&
    pointer.contentDigest === candidateContentDigest
  ) {
    return;
  }
  if (
    pointer.corpusVersionId !== parentCorpusVersionId ||
    pointer.contentDigest !== parentContentDigest
  ) {
    throw new DriftServiceError(
      "stale_corpus_parent",
      `Drift proposal parent ${parentCorpusVersionId} is stale; active corpus is ${pointer.corpusVersionId}`,
    );
  }
  const body = Buffer.from(
    canonicalJson({
      version: 1,
      corpusVersionId: candidateCorpusVersionId,
      contentDigest: candidateContentDigest,
    }),
    "utf8",
  );
  if (
    !(await store.compareAndSwap(
      ACTIVE_CORPUS_KEY,
      active.version,
      body,
      active.fenceToken,
    ))
  ) {
    const raced = await store.get(ACTIVE_CORPUS_KEY);
    const racedPointer =
      raced === null ? null : parseActiveCorpusPointer(raced.body);
    if (
      racedPointer?.corpusVersionId === candidateCorpusVersionId &&
      racedPointer.contentDigest === candidateContentDigest
    ) {
      return;
    }
    throw new DriftServiceError(
      "stale_corpus_parent",
      "Active corpus changed while the drift proposal was publishing",
    );
  }
}

function driftInputs(
  corpus: Corpus,
  contentDigest: string,
  parentVersion: string | null,
): {
  manifest: CorpusManifest;
  definition: CorpusDefinition;
  bundle: HistoricalRunBundle;
} {
  const cases = corpus.cases
    .map(toCaseDefinition)
    .sort((left, right) => compareText(left.case_id, right.case_id));
  assertUniqueDriftCases(cases);
  const bundle: HistoricalRunBundle = {
    version: "1",
    bundle_id: corpus.corpusVersionId,
    runs: corpus.cases
      .map(toHistoricalRun)
      .sort((left, right) => compareText(left.id, right.id)),
  };
  const definition: CorpusDefinition = {
    version: String(corpus.contractVersion ?? 1),
    corpus_id: "rightmodeler",
    parent_version: parentVersion,
    cases,
  };
  return {
    definition,
    bundle,
    manifest: {
      version: String(corpus.contractVersion ?? 1),
      corpus_id: "rightmodeler",
      corpus_version: String(corpus.contractVersion ?? 1),
      parent_version: parentVersion,
      source_bundle_id: corpus.corpusVersionId,
      content_digest: contentDigest,
      cases,
    },
  };
}

function toCaseDefinition(
  corpusCase: Corpus["cases"][number],
): CorpusCaseDefinition {
  const sourceId = sourceRunId(corpusCase);
  const hasTools = observedToolCalls(corpusCase).length > 0;
  return {
    case_id: corpusCase.caseId,
    source_run_id: sourceId,
    pipeline_family: hasTools ? "tool-trajectory" : "reference-freeform",
    workload_label: corpusCase.content.family,
    split: corpusCase.split === "shortlist" ? "working" : "holdout",
    risk: "normal",
    required_evidence: hasTools ? "trajectory" : "reference",
    checks: {},
  };
}

function toHistoricalRun(corpusCase: Corpus["cases"][number]): HistoricalRun {
  const observation = corpusCase.observation;
  const calls = observedToolCalls(corpusCase);
  const evaluator =
    observation?.evaluator ??
    (calls.length > 0 ? "tool-trajectory" : undefined);
  const notEvaluated: DriftNotEvaluated[] = [];
  const unavailable = (
    signal: DriftNotEvaluated["signal"],
    dimension: string,
    reason: string,
  ) => notEvaluated.push({ signal, dimension, reason });

  if (observation?.costUsd === undefined) {
    unavailable("cost", "cost", "a real cost observation is absent");
  }
  if (observation?.durationMs === undefined) {
    unavailable("latency", "latency", "a real duration observation is absent");
  }
  if (evaluator === undefined) {
    unavailable("evaluator", "evaluator", "trace evaluator metadata is absent");
  }
  if (observation?.evaluatorVersion === undefined) {
    unavailable(
      "evaluator",
      "evaluator version",
      "trace evaluator-version metadata is absent",
    );
  }
  if (observation?.retryCount === undefined) {
    unavailable("retry", "retry", "trace retry metadata is absent");
  }
  unavailable(
    "evaluator",
    "risk",
    "trace data has no reviewed risk label; the case defaults to normal risk",
  );
  unavailable(
    "evaluator",
    "checks",
    "trace data has no reviewed deterministic checks; the case uses no checks",
  );
  if (calls.length === 0) {
    unavailable(
      "evaluator",
      "pipeline family",
      "trace data does not identify a benchmark family; the case defaults to reference-freeform",
    );
  }

  return {
    id: sourceRunId(corpusCase),
    prompt: promptValue(corpusCase.content),
    model: corpusCase.content.model,
    success: true,
    tool_calls: calls,
    trajectory: corpusCase.content.trajectoryId,
    ...(observation?.costUsd === undefined
      ? {}
      : { cost_usd: observation.costUsd }),
    ...(observation?.durationMs === undefined
      ? {}
      : { duration_ms: observation.durationMs }),
    ...(evaluator === undefined ? {} : { evaluator }),
    ...(observation?.evaluatorVersion === undefined
      ? {}
      : { evaluator_version: observation.evaluatorVersion }),
    ...(observation?.retryCount === undefined
      ? {}
      : { retry_count: observation.retryCount }),
    not_evaluated: notEvaluated,
  };
}

function observedToolCalls(corpusCase: Corpus["cases"][number]): JsonValue[] {
  return (
    corpusCase.observation?.toolCalls ??
    extractToolCalls(corpusCase.content.output)
  );
}

function extractToolCalls(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) return value.flatMap(extractToolCalls);
  if (typeof value !== "object" || value === null) return [];
  const direct = value.tool_calls ?? value.toolCalls;
  if (Array.isArray(direct)) return direct;
  return Object.values(value).flatMap(extractToolCalls);
}

function preserveParentSplits(parent: Corpus, candidate: Corpus): void {
  const parentSplits = new Map<string, Corpus["cases"][number]["split"]>();
  for (const corpusCase of parent.cases) {
    const identity = sourceRunId(corpusCase);
    if (parentSplits.has(identity)) {
      throw new DriftServiceError(
        "duplicate_drift_case",
        `Parent corpus has duplicate stable case identity ${identity}`,
      );
    }
    parentSplits.set(identity, corpusCase.split);
  }

  const candidateIdentities = new Set<string>();
  for (const corpusCase of candidate.cases) {
    const identity = sourceRunId(corpusCase);
    if (candidateIdentities.has(identity)) {
      throw new DriftServiceError(
        "duplicate_drift_case",
        `Candidate corpus has duplicate stable case identity ${identity}`,
      );
    }
    candidateIdentities.add(identity);
    corpusCase.split =
      parentSplits.get(identity) ?? assignDriftSplit(identity, candidate.seed);
  }
}

function assertUniqueDriftCases(cases: readonly CorpusCaseDefinition[]): void {
  const caseIds = new Set<string>();
  const sourceRunIds = new Set<string>();
  for (const corpusCase of cases) {
    if (caseIds.has(corpusCase.case_id)) {
      throw new DriftServiceError(
        "duplicate_drift_case",
        `Drift input has duplicate case_id ${corpusCase.case_id}`,
      );
    }
    if (sourceRunIds.has(corpusCase.source_run_id)) {
      throw new DriftServiceError(
        "duplicate_drift_case",
        `Drift input has duplicate source_run_id ${corpusCase.source_run_id}`,
      );
    }
    caseIds.add(corpusCase.case_id);
    sourceRunIds.add(corpusCase.source_run_id);
  }
}

function sourceRunId(corpusCase: Corpus["cases"][number]): string {
  return computeRunSpecDigest({
    traceId: corpusCase.observation?.traceId ?? corpusCase.content.trajectoryId,
    stepIndex: corpusCase.content.stepIndex,
  });
}

function promptValue(content: CorpusCaseContent): string {
  return canonicalJson({
    ...(content.systemPrompt === undefined
      ? {}
      : { systemPrompt: content.systemPrompt }),
    messages: content.messages,
  });
}

function context(options: { repo: string; store?: string }): {
  store: Store;
  storeRoot: string;
} {
  const repo = resolve(options.repo);
  const storeRoot = resolve(options.store ?? join(repo, ".rightmodeler"));
  return {
    store: new FsStore(storeRoot),
    storeRoot,
  };
}

function driftKeys(proposalId: string): {
  candidate: string;
  proposed: string;
  approved: string;
  published: string;
  manifest: string;
  benchmarkCases: string;
  report: string;
} {
  const parsed = sha256Schema.safeParse(proposalId);
  if (!parsed.success) {
    throw new DriftServiceError(
      "drift_proposal_missing",
      `Unknown drift proposal: ${proposalId}`,
    );
  }
  const digest = parsed.data.slice("sha256:".length);
  const prefix = `${PROJECT_ID}/corpus/drift/${digest}`;
  return {
    candidate: `${prefix}/candidate.json`,
    proposed: `${prefix}/proposed.json`,
    approved: `${prefix}/approved.json`,
    published: `${prefix}/published.json`,
    manifest: `${prefix}/corpus-manifest.json`,
    benchmarkCases: `${prefix}/benchmark-cases.json`,
    report: reportKey(PROJECT_ID, `drift-${digest}.md`),
  };
}

function renderDriftProposal(proposal: ProposedCorpusDriftProposal): string {
  const changes = proposal.proposed_changes.map(
    (change) =>
      `- \`${change.action}\` \`${change.case_id}\` (\`${change.signal}\`): ${change.detail}`,
  );
  return [
    "# Corpus drift proposal",
    "",
    `Status: ${proposal.status}`,
    `Proposal: \`${proposal.proposal_id}\``,
    `Parent corpus: \`${proposal.parent_corpus_version_id}\``,
    `Signals: ${proposal.signals.map((signal) => `\`${signal}\``).join(", ")}`,
    "",
    "## Proposed changes",
    "",
    ...changes,
    "",
    "## Holdout review",
    "",
    `Exposed: ${proposal.exposed_holdout_case_ids.length === 0 ? "none" : proposal.exposed_holdout_case_ids.join(", ")}`,
    `Replacements: ${proposal.replacement_holdout_case_ids.length === 0 ? "none" : proposal.replacement_holdout_case_ids.join(", ")}`,
    "",
  ].join("\n");
}

function publicationResult(
  proposal: PublishedCorpusDriftProposal,
  corpus: Corpus,
  keys: ReturnType<typeof driftKeys>,
): PublishDriftProposalResult {
  return {
    proposal,
    corpusVersionId: corpus.corpusVersionId,
    proposalKey: keys.published,
    manifestKey: keys.manifest,
    benchmarkCasesKey: keys.benchmarkCases,
  };
}

async function requiredJson(
  store: Store,
  key: string,
  code: DriftServiceErrorCode,
): Promise<unknown> {
  const entry = await store.get(key);
  if (entry === null) {
    throw new DriftServiceError(code, `Store output is missing: ${key}`);
  }
  return parseEntry(entry.body);
}

async function requiredArtifactJson(
  store: Store,
  key: string,
  missingCode: DriftServiceErrorCode,
  label: string,
): Promise<unknown> {
  const entry = await store.get(key);
  if (entry === null) {
    throw new DriftServiceError(missingCode, `Store output is missing: ${key}`);
  }
  return parseArtifactEntry(entry.body, label);
}

function parseArtifactEntry(body: Uint8Array, label: string): unknown {
  try {
    return parseEntry(body);
  } catch (error) {
    throw new DriftServiceError(
      "drift_artifact_malformed",
      `${label} is malformed: ${errorMessage(error)}`,
    );
  }
}

function validateProposalArtifact<T extends CorpusDriftProposal>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  try {
    const proposal = schema.parse(value);
    assertDriftProposalIntegrity(proposal);
    return proposal;
  } catch (error) {
    if (error instanceof DriftServiceError) throw error;
    throw new DriftServiceError(
      "drift_artifact_malformed",
      `${label} is malformed: ${errorMessage(error)}`,
    );
  }
}

function validateCandidateArtifact(
  value: unknown,
): z.infer<typeof candidateArtifactSchema> {
  try {
    return candidateArtifactSchema.parse(value);
  } catch (error) {
    throw new DriftServiceError(
      "drift_artifact_malformed",
      `Drift candidate is malformed: ${errorMessage(error)}`,
    );
  }
}

function parseEntry(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
}

function parseActiveCorpusPointer(
  body: Uint8Array,
): z.infer<typeof activeCorpusSchema> {
  try {
    return activeCorpusSchema.parse(parseEntry(body));
  } catch (error) {
    throw new DriftServiceError(
      "active_corpus_malformed",
      `Active corpus pointer is malformed: ${errorMessage(error)}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function putImmutableJson(
  store: Store,
  key: string,
  value: unknown,
): Promise<void> {
  await store.putImmutable(
    key,
    Buffer.from(canonicalJson(jsonValueSchema.parse(value)), "utf8"),
  );
}

function digestId(corpusVersionId: string): string {
  return `sha256:${corpusVersionIdSchema.parse(corpusVersionId)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
