import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  assessmentSchema,
  callSiteInventoryKey,
  canonicalJson,
  completeRun,
  computeRunSpecDigest,
  createRun,
  executionSchema,
  factSchema,
  factsPrefix,
  failRun,
  FsStore,
  jsonValueSchema,
  reportKey,
  requestAttemptSchema,
  runMetaSchema,
  runsPrefix,
  setupPrefix,
  spendEventSchema,
  stepKey,
  stepRecordSchema,
  stepsPrefix,
  verdictKey,
  verdictsPrefix,
  type Assessment,
  type Fact,
  type JsonValue,
  type RunMeta,
  type Store,
} from "@rightmodeler/core";
import {
  aggregate,
  evaluateGates,
  pickJudge,
  ReleaseGatePolicy,
  selectWinner,
  type AggregationFact,
  type FamilyVerdict,
  type GateResult,
  type WinnerSelection,
} from "@rightmodeler/kernel";
import {
  BudgetRefusalError,
  createBudget,
  createProvider,
  ProviderConfigurationError,
  replayModeA,
  shortlist,
  type ModelCatalogEntry,
  type RecordedCase,
  type ReplayStep,
} from "@rightmodeler/replay";
import {
  createMatcherRegistry,
  detectTech,
  evaluateCoverage,
  reconcile,
  scan,
} from "@rightmodeler/scanner";
import { z } from "zod";

import {
  auditSample,
  auditTabulate,
  buildCorpus,
  detectFormat,
  FormatDetectionError,
  normalizedRunSchema,
  parseTraceRecords,
  scrubRuns,
  traceAdapters,
  writeCorpus,
  type AuditWorksheet,
  type Corpus,
} from "./data/index.js";
import { ProtocolError, Reporter } from "./protocol.js";
import {
  putMutableJson,
  readJson,
  readSetupState,
  writeCheckpoint,
  type Checkpoint,
  type SetupState,
} from "./state.js";

export const PIPELINE_STAGES = [
  "scan",
  "ingest",
  "reconcile",
  "scrub",
  "corpus",
  "audit-sample",
  "shortlist",
  "replay",
  "aggregate",
  "report",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type StageState = "complete" | "stale" | "pending";

const PROJECT_ID = "project";
const CORPUS_SEED = 42;
const AUDIT_SAMPLE_LIMIT = 20;
const SHORTLIST_TOP = 3;
const AVAILABILITY_FLOOR = 0.7;
const GATE_POLICY_VERSION = "phase-a-v2";
const API_KEY_ENV_DEFAULT = "RIGHTMODELER_API_KEY";
const RELEASE_GATE_POLICY = new ReleaseGatePolicy({
  gatePolicyVersion: GATE_POLICY_VERSION,
  qualityFloor: 0.85,
  availabilityFloor: AVAILABILITY_FLOOR,
});

const scanOutputSchema = z.strictObject({
  records: z.array(stepRecordSchema),
});
const ingestOutputSchema = z.strictObject({
  format: z.enum(["otel-genai", "openai-jsonl"]),
  runs: z.array(normalizedRunSchema),
});
const scrubOutputSchema = z.strictObject({
  runs: z.array(normalizedRunSchema),
  redactions: z.array(
    z.strictObject({
      runIndex: z.number().int().nonnegative(),
      stepIndex: z.number().int().nonnegative(),
      kind: z.enum(["email", "phone"]),
    }),
  ),
});
const corpusOutputSchema = z.strictObject({
  corpusVersionId: z.string().min(1),
  seed: z.number().int(),
  caseCount: z.number().int().positive(),
  strata: z.array(
    z.strictObject({
      family: z.string().min(1),
      corpusShare: z.number().nonnegative(),
      trafficShare: z.number().nonnegative(),
    }),
  ),
});
const replayPlanCaseSchema = z.strictObject({
  family: z.string().min(1),
  caseId: z.string().min(1),
  stepId: z.string().min(1),
  trajectoryId: z.string().min(1),
  corpusSplit: z.enum(["shortlist", "holdout"]),
  task: z.string(),
  system: z.string().optional(),
  messages: z.array(z.record(z.string(), z.json())),
  contextTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().positive(),
  referenceOutput: z.json(),
});
const replayPlanStepSchema = z.strictObject({
  family: z.string().min(1),
  stepId: z.string().min(1),
  evidenceQuestionId: z.string().min(1),
  currentModel: z.string().min(1).nullable(),
  needsTools: z.boolean(),
  needsStructuredOutput: z.boolean(),
  observedContextTokens: z.number().int().nonnegative(),
});
const replayPlanSchema = z.strictObject({
  top: z.number().int().positive(),
  sampleSizes: z.record(z.string(), z.number().int().positive()),
  steps: z.array(replayPlanStepSchema),
  cases: z.array(replayPlanCaseSchema),
});
const modelCatalogSchema = z.strictObject({
  id: z.string().min(1),
  family: z.string().min(1),
  contextLength: z.number().int().nonnegative(),
  pricing: z
    .strictObject({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
    })
    .nullable(),
  supportsTools: z.boolean(),
  supportsStructuredOutput: z.boolean(),
});
const replayOutputSchema = z.strictObject({
  completed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  candidates: z.array(
    z.strictObject({
      stepId: z.string().min(1),
      candidates: z.array(modelCatalogSchema),
      droppedByTop: z.number().int().nonnegative(),
      abstention: z
        .strictObject({
          kind: z.literal("current-model-absent"),
          message: z.string(),
        })
        .optional(),
    }),
  ),
});
const gateResultSchema = z.strictObject({
  id: z.enum([
    "zero-unsafe-substitutions",
    "quality",
    "evidence-coverage",
    "required-abstention",
    "availability",
  ]),
  pass: z.boolean(),
  reason: z.string(),
});
const selectionEstimateSchema = z.strictObject({
  point: z.number(),
  lower: z.number(),
  upper: z.number(),
  confidence: z.literal(0.95),
  comparisons: z.number().int().positive(),
  evaluatorKind: z.string().min(1),
  method: z.enum(["wilson", "cluster_bootstrap"]),
});
const selectionSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("no_shortlist_passer"),
    shortlistedCandidateIds: z.array(z.string()),
    holdoutRequired: z.literal(false),
  }),
  z.strictObject({
    status: z.literal("confirmation_required"),
    shortlistedCandidateIds: z.array(z.string()),
    confirmedCandidateId: z.string(),
    holdoutRequired: z.literal(true),
  }),
  z.strictObject({
    status: z.enum(["holdout_failed", "selected"]),
    shortlistedCandidateIds: z.array(z.string()),
    confirmedCandidateId: z.string(),
    selectedCandidateId: z.string().optional(),
    selectionAdjustedEstimate: selectionEstimateSchema,
    holdoutRequired: z.literal(false),
  }),
]);
const familyOutcomeSchema = z.strictObject({
  familyId: z.string().min(1),
  verdict: z.custom<FamilyVerdict>(isFamilyVerdict),
  selection: selectionSchema,
  gates: z.array(gateResultSchema),
  decisionDisplay: z.enum([
    "recommend",
    "recommend (gated)",
    "reject",
    "abstain",
    "inconclusive",
  ]),
  effectiveRecommendation: z.boolean(),
});
const aggregateOutputSchema = z.strictObject({
  allVerdicts: z.array(z.custom<FamilyVerdict>(isFamilyVerdict)),
  families: z.array(familyOutcomeSchema),
});
const auditWorksheetSchema = z.strictObject({
  seed: z.number().int(),
  populationSize: z.number().int().nonnegative(),
  cases: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      family: z.string().min(1),
      systemPrompt: z.string().optional(),
      messages: z.array(z.json()),
      acceptedOutput: z.json(),
      verdict: z.enum(["", "correct", "incorrect", "ambiguous"]),
      note: z.string(),
    }),
  ),
});

interface PipelineContext {
  repo: string;
  storeRoot: string;
  store: Store;
  projectId: string;
  traces?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  maxCostUsd?: number;
  reporter: Reporter;
}

export interface PipelineOptions {
  repo: string;
  store?: string;
  traces?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxCostUsd?: number;
  through?: PipelineStage;
  plan?: boolean;
  reporter: Reporter;
}

export interface StagePlanEntry {
  stage: PipelineStage;
  state: StageState;
}

export interface PipelineResult {
  stages: StagePlanEntry[];
  executedStages: PipelineStage[];
  verdicts: FamilyVerdict[];
  familyOutcomes?: FamilyOutcome[];
  reportPath?: string;
  recommendationExists: boolean;
}

interface FamilyOutcome {
  familyId: string;
  verdict: FamilyVerdict;
  selection: WinnerSelection;
  gates: GateResult[];
  decisionDisplay: FamilyVerdict["decision"] | "recommend (gated)";
  effectiveRecommendation: boolean;
}

export async function planPipeline(
  options: PipelineOptions,
): Promise<StagePlanEntry[]> {
  const context = createContext(options);
  const stages = stagesThrough(options.through);
  const state = await readSetupState(context.store, context.projectId);
  const result: StagePlanEntry[] = [];
  let upstreamCurrent = true;

  for (const stage of stages) {
    const checkpoint = state.stages[stage];
    const digestValue: string | undefined = upstreamCurrent
      ? await inputDigest(stage, context, state)
      : undefined;
    const exists =
      checkpoint !== undefined &&
      (await checkpointOutputExists(context, stage, checkpoint));
    const current: boolean =
      digestValue !== undefined &&
      checkpoint?.inputDigest === digestValue &&
      exists;
    const stageState: StageState = current
      ? "complete"
      : checkpoint === undefined
        ? "pending"
        : "stale";
    result.push({ stage, state: stageState });
    upstreamCurrent = current;
  }
  return result;
}

export async function runPipeline(
  options: PipelineOptions,
): Promise<PipelineResult> {
  const context = createContext(options);
  if (options.plan) {
    const verdicts = await readCurrentVerdicts(
      context.store,
      context.projectId,
    );
    return {
      stages: await planPipeline(options),
      executedStages: [],
      verdicts,
      recommendationExists: false,
    };
  }

  const run = await createRun(context.store, {
    projectId: context.projectId,
    type: "init",
    phase: options.through ?? "report",
  });
  const executedStages: PipelineStage[] = [];
  try {
    for (const stage of stagesThrough(options.through)) {
      const state = await readSetupState(context.store, context.projectId);
      const digest = await requiredInputDigest(stage, context, state);
      const checkpoint = state.stages[stage];
      if (
        checkpoint?.inputDigest === digest &&
        (await checkpointOutputExists(context, stage, checkpoint))
      ) {
        context.reporter.event({ event: "stage_skipped", stage });
        continue;
      }

      context.reporter.event({ event: "stage_started", stage });
      const outputKey = await executeStage(stage, context, digest, run.runId);
      await writeCheckpoint(context.store, context.projectId, stage, {
        inputDigest: digest,
        outputKey,
        completedAt: new Date().toISOString(),
      });
      executedStages.push(stage);
      context.reporter.event({ event: "stage_completed", stage });
    }
    await completeRun(context.store, context.projectId, run.runId);
  } catch (error) {
    await failRun(context.store, context.projectId, run.runId);
    throw normalizePipelineError(error, context);
  }

  const verdicts = await readCurrentVerdicts(context.store, context.projectId);
  const state = await readSetupState(context.store, context.projectId);
  const aggregateOutput =
    state.stages.aggregate === undefined
      ? undefined
      : await loadAggregateOutput(context);
  return {
    stages: await planPipeline(options),
    executedStages,
    verdicts,
    ...(aggregateOutput === undefined
      ? {}
      : { familyOutcomes: aggregateOutput.families }),
    ...(state.stages.report === undefined
      ? {}
      : { reportPath: reportPath(context) }),
    recommendationExists:
      aggregateOutput?.families.some(
        ({ effectiveRecommendation }) => effectiveRecommendation,
      ) ?? false,
  };
}

function createContext(options: PipelineOptions): PipelineContext {
  const repo = resolve(options.repo);
  const storeRoot = resolve(options.store ?? join(repo, ".rightmodeler"));
  return {
    repo,
    storeRoot,
    store: new FsStore(storeRoot),
    projectId: PROJECT_ID,
    traces: options.traces === undefined ? undefined : resolve(options.traces),
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv ?? API_KEY_ENV_DEFAULT,
    maxCostUsd: options.maxCostUsd,
    reporter: options.reporter,
  };
}

function stagesThrough(through?: PipelineStage): PipelineStage[] {
  if (through === undefined) return [...PIPELINE_STAGES];
  return PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(through) + 1);
}

async function inputDigest(
  stage: PipelineStage,
  context: PipelineContext,
  state: SetupState,
): Promise<string | undefined> {
  if (stage === "scan") {
    return repositoryDigest(context.repo, context.storeRoot);
  }
  if (stage === "ingest") {
    if (context.traces === undefined) return state.stages.ingest?.inputDigest;
    try {
      const body = await readFile(context.traces);
      return digest({ stage, traceSha256: sha256(body) });
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  const previous = PIPELINE_STAGES[PIPELINE_STAGES.indexOf(stage) - 1]!;
  const upstream = state.stages[previous];
  if (upstream === undefined) return undefined;
  const extra: Record<string, JsonValue> = {};
  if (stage === "corpus") extra.seed = CORPUS_SEED;
  if (stage === "audit-sample") extra.limit = AUDIT_SAMPLE_LIMIT;
  if (stage === "shortlist") extra.top = SHORTLIST_TOP;
  if (stage === "replay") {
    if (context.baseUrl === undefined) return state.stages.replay?.inputDigest;
    extra.provider = digest({
      baseUrl: context.baseUrl,
      apiKeyEnv: context.apiKeyEnv,
      maxCostUsd: context.maxCostUsd ?? null,
    });
  }
  if (stage === "aggregate") {
    extra.gatePolicyVersion = GATE_POLICY_VERSION;
    extra.qualityFloor = RELEASE_GATE_POLICY.qualityFloor;
    extra.availabilityFloor = RELEASE_GATE_POLICY.availabilityFloor;
  }
  return digest({ stage, upstream: upstream.inputDigest, ...extra });
}

async function requiredInputDigest(
  stage: PipelineStage,
  context: PipelineContext,
  state: SetupState,
): Promise<string> {
  const value = await inputDigest(stage, context, state);
  if (value !== undefined) return value;
  if (stage === "ingest") {
    throw new ProtocolError({
      exitCode: 2,
      code: "missing_traces_path",
      message: "A trace input path is required when ingest is reached.",
      remedy:
        "Pass --traces <path> with an OTel GenAI JSON or OpenAI JSONL trace file.",
    });
  }
  if (stage === "replay") {
    throw new ProtocolError({
      exitCode: 2,
      code: "missing_provider_configuration",
      message: "Provider configuration is required when replay is reached.",
      remedy:
        "Pass --base-url <url> and, if needed, --api-key-env <environment-variable-name>.",
    });
  }
  throw new Error(`Cannot run ${stage} before its upstream stage is complete`);
}

async function executeStage(
  stage: PipelineStage,
  context: PipelineContext,
  inputDigestValue: string,
  runId: string,
): Promise<string> {
  switch (stage) {
    case "scan":
      return executeScan(context, inputDigestValue);
    case "ingest":
      return executeIngest(context, inputDigestValue);
    case "reconcile":
      return executeReconcile(context, inputDigestValue);
    case "scrub":
      return executeScrub(context, inputDigestValue);
    case "corpus":
      return executeCorpus(context, inputDigestValue);
    case "audit-sample":
      return executeAuditSample(context, inputDigestValue);
    case "shortlist":
      return executeShortlist(context, inputDigestValue);
    case "replay":
      return executeReplay(context, inputDigestValue, runId);
    case "aggregate":
      return executeAggregate(context, inputDigestValue);
    case "report":
      return executeReport(context, inputDigestValue);
  }
}

async function executeScan(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const records = scan(
    context.repo,
    createMatcherRegistry(),
    context.projectId,
  );
  const coverage = evaluateCoverage({
    stepRecords: records,
    fileUniverse: (await repositoryFiles(context.repo, context.storeRoot)).map(
      ({ path }) => path,
    ),
    detectedTech: detectTech(context.repo),
  });
  if (!coverage.pass) {
    const failures = coverage.failures
      .map(
        (failure) =>
          `${failure.code}: ${failure.language} (${failure.dependencies.join(", ")})`,
      )
      .join("; ");
    throw new ProtocolError({
      exitCode: 2,
      code: "coverage_gate_failed",
      message: `Scanner coverage gate failed: ${failures}`,
      remedy: "Add matcher coverage for the listed AI dependency surfaces.",
    });
  }
  for (const record of records) {
    await putMutableJson(
      context.store,
      stepKey(context.projectId, record.stepId),
      jsonValue(record),
    );
  }
  const key = artifactKey(context, "scan", inputDigestValue);
  await putImmutableJson(context.store, key, { records });
  await putMutableJson(
    context.store,
    callSiteInventoryKey(context.projectId),
    jsonValue({ records }),
  );
  return key;
}

async function executeIngest(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const tracePath = context.traces;
  if (tracePath === undefined) {
    throw new ProtocolError({
      exitCode: 2,
      code: "missing_traces_path",
      message: "A trace input path is required when ingest is reached.",
      remedy:
        "Pass --traces <path> with an OTel GenAI JSON or OpenAI JSONL trace file.",
    });
  }
  let text: string;
  try {
    text = await readFile(tracePath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new ProtocolError({
        exitCode: 2,
        code: "missing_traces_path",
        message: `Trace input does not exist: ${tracePath}`,
        remedy: "Pass --traces <path> pointing to an existing trace file.",
      });
    }
    throw error;
  }
  const adapter = detectFormat(text, traceAdapters);
  const runs = adapter.adapt(parseTraceRecords(text));
  const key = artifactKey(context, "ingest", inputDigestValue);
  await putImmutableJson(context.store, key, {
    format: adapter.name,
    runs,
  });
  return key;
}

async function executeReconcile(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const scanOutput = await loadScan(context);
  const ingestOutput = await loadIngest(context);
  const result = reconcile(
    ingestOutput.runs.flatMap((run) => run.steps),
    scanOutput.records,
  );
  const key = artifactKey(context, "reconcile", inputDigestValue);
  await putImmutableJson(context.store, key, {
    matchedTraceSteps: result.traceSteps.filter(
      ({ status }) => status === "matched",
    ).length,
    ambiguousTraceSteps: result.ambiguousTraceSteps.length,
    unmatchedTraceSteps: result.unmatchedTraceSteps.length,
    matchedCallSites: result.callSites.filter(
      ({ status }) => status === "matched",
    ).length,
    ambiguousCallSites: result.ambiguousCallSites.length,
    unmatchedCallSites: result.unmatchedCallSites.length,
    ambiguityReasons: [
      ...new Set(
        result.ambiguousTraceSteps.flatMap(({ reason }) =>
          reason === undefined ? [] : [reason],
        ),
      ),
    ],
  });
  return key;
}

async function executeScrub(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const result = scrubRuns((await loadIngest(context)).runs);
  const key = artifactKey(context, "scrub", inputDigestValue);
  await putImmutableJson(context.store, key, result);
  return key;
}

async function executeCorpus(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const corpus = buildCorpus((await loadScrub(context)).runs, {
    seed: CORPUS_SEED,
  });
  await writeCorpus(context.store, context.projectId, corpus);
  const key = artifactKey(context, "corpus", inputDigestValue);
  await putImmutableJson(context.store, key, corpusOutput(corpus));
  return key;
}

async function executeAuditSample(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const runs = (await loadScrub(context)).runs;
  const size = Math.min(
    AUDIT_SAMPLE_LIMIT,
    buildCorpus(runs, { seed: CORPUS_SEED }).cases.length,
  );
  const worksheet = auditSample(runs, { size, seed: CORPUS_SEED });
  const key = artifactKey(context, "audit-sample", inputDigestValue);
  await putImmutableJson(context.store, key, worksheet);
  return key;
}

async function executeShortlist(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const records = (await loadScan(context)).records;
  const runs = (await loadScrub(context)).runs;
  const corpus = buildCorpus(runs, { seed: CORPUS_SEED });
  const replayableSteps = records.filter(
    (record) =>
      !record.capabilityRequirements.includes("tools") &&
      !record.capabilityRequirements.includes("structured_output"),
  );
  if (replayableSteps.length === 0) {
    throw new Error("No replayable text call sites were found");
  }

  const families = [
    ...new Set(corpus.cases.map(({ content }) => content.family)),
  ].sort(
    (left, right) =>
      corpus.cases.filter(({ content }) => content.family === right).length -
        corpus.cases.filter(({ content }) => content.family === left).length ||
      compareText(left, right),
  );
  const steps: Array<Omit<ReplayStep, "corpusSplit"> & { family: string }> = [];
  const cases: Array<RecordedCase & { family: string }> = [];
  const sampleSizes: Record<string, number> = {};
  const unusedSteps = new Set(replayableSteps.map(({ stepId }) => stepId));
  for (const [familyIndex, family] of families.entries()) {
    const familyCases = corpus.cases.filter(
      ({ content }) => content.family === family,
    );
    sampleSizes[family] = familyCases.length;
    const preferred = replayableSteps.filter(
      (record) =>
        unusedSteps.has(record.stepId) &&
        !record.callSite.path.endsWith(".yaml") &&
        !record.callSite.path.endsWith(".yml"),
    );
    const fallback = replayableSteps.filter((record) =>
      unusedSteps.has(record.stepId),
    );
    const assignedRecords = (preferred.length > 0 ? preferred : fallback).slice(
      0,
      familyIndex === 0 ? 2 : 1,
    );
    if (assignedRecords.length === 0) {
      throw new Error(
        `No distinct replayable call site remains for family ${family}`,
      );
    }
    const assignedStepIds = assignedRecords.map(({ stepId }) => stepId);
    assignedStepIds.forEach((stepId) => unusedSteps.delete(stepId));
    const evidenceQuestionId = computeRunSpecDigest({
      corpusVersionId: corpus.corpusVersionId,
      family,
      stepIds: assignedStepIds,
      gatePolicyVersion: GATE_POLICY_VERSION,
      replayMode: "single_shot",
    });
    for (const stepId of assignedStepIds) {
      const record = assignedRecords.find(
        (candidate) => candidate.stepId === stepId,
      )!;
      steps.push({
        family,
        stepId,
        evidenceQuestionId,
        currentModel: record.currentModel,
        needsTools: record.capabilityRequirements.includes("tools"),
        needsStructuredOutput:
          record.capabilityRequirements.includes("structured_output"),
        observedContextTokens: 0,
      });
    }
    for (const split of ["shortlist", "holdout"] as const) {
      familyCases
        .filter((corpusCase) => corpusCase.split === split)
        .forEach((corpusCase, index) => {
          const step = assignedRecords[index % assignedRecords.length]!;
          cases.push({
            family,
            caseId: corpusCase.caseId,
            stepId: step.stepId,
            trajectoryId: corpusCase.content.trajectoryId,
            corpusSplit: split,
            task: `Evaluate the ${family} response for the recorded request.`,
            ...(corpusCase.content.systemPrompt === undefined
              ? {}
              : { system: corpusCase.content.systemPrompt }),
            messages: chatMessages(corpusCase.content.messages),
            contextTokens: 0,
            maxOutputTokens: 256,
            referenceOutput: corpusCase.content.output,
          });
        });
    }
  }

  const key = artifactKey(context, "shortlist", inputDigestValue);
  await putImmutableJson(context.store, key, {
    top: SHORTLIST_TOP,
    sampleSizes,
    steps,
    cases,
  });
  return key;
}

async function executeReplay(
  context: PipelineContext,
  inputDigestValue: string,
  runId: string,
): Promise<string> {
  if (context.baseUrl === undefined) {
    throw new ProtocolError({
      exitCode: 2,
      code: "missing_provider_configuration",
      message: "Provider configuration is required when replay is reached.",
      remedy:
        "Pass --base-url <url> and, if needed, --api-key-env <environment-variable-name>.",
    });
  }
  const plan = await loadReplayPlan(context);
  const provider = createProvider({
    providerId: "configured-provider",
    baseUrl: context.baseUrl,
    apiKeyEnv: context.apiKeyEnv,
  });
  const catalog = await provider.listModels();
  const replaySteps = (split: "shortlist" | "holdout"): ReplayStep[] =>
    plan.steps.map((step) => ({
      ...step,
      corpusSplit: split,
      selectionStage: split,
    }));
  const candidates = shortlist(replaySteps("shortlist"), catalog, {
    top: plan.top,
  });
  const budget = createBudget({
    store: context.store,
    projectId: context.projectId,
    runId,
    authorizedTotalUsd: context.maxCostUsd,
  });
  let completed = 0;
  let skipped = 0;
  const runCells = async (
    split: "shortlist" | "holdout",
    assignments: typeof candidates,
  ): Promise<void> => {
    const candidateFamilies = [
      ...new Set(
        assignments.flatMap(({ candidates }) =>
          candidates.map(({ family }) => family),
        ),
      ),
    ];
    for (const candidateFamily of candidateFamilies) {
      const familyAssignments = assignments.map((assignment) => ({
        ...assignment,
        candidates: assignment.candidates.filter(
          ({ family }) => family === candidateFamily,
        ),
      }));
      const stepIds = new Set(
        familyAssignments
          .filter(({ candidates }) => candidates.length > 0)
          .map(({ stepId }) => stepId),
      );
      const referenceFamilies = new Set(
        plan.steps
          .filter(({ stepId }) => stepIds.has(stepId))
          .map(({ currentModel }) => modelFamily(currentModel)),
      );
      if (referenceFamilies.size !== 1) {
        throw new Error(
          `Replay candidates span multiple reference families: ${[...referenceFamilies].join(", ")}`,
        );
      }
      const referenceFamily = [...referenceFamilies][0]!;
      const judgeModel = pickJudge(
        catalog.map((model) => ({
          id: model.id,
          family: model.family,
          context_length: model.contextLength,
          pricing:
            model.pricing === null
              ? null
              : {
                  prompt: model.pricing.input,
                  completion: model.pricing.output,
                },
          supported_parameters: model.supportsStructuredOutput
            ? ["structured_outputs"]
            : [],
        })),
        { candidateFamily, referenceFamily },
      );
      const result = await replayModeA({
        steps: replaySteps(split),
        cases: plan.cases,
        candidates: familyAssignments,
        provider,
        judge: {
          judgeModel,
          chat: async (request) =>
            (
              await provider.chat({
                model: request.model,
                messages: request.messages.map((message) => ({ ...message })),
                temperature: request.temperature,
                maxOutputTokens: 256,
                responseFormat: jsonValue(request.responseFormat),
              })
            ).content,
        },
        store: context.store,
        budget,
        concurrency: 4,
      });
      const budgetBlock = result.blocked.find(({ kind }) => kind === "budget");
      if (budgetBlock !== undefined) {
        const requiredCap = requiredCapFromMessage(budgetBlock.message);
        throw new ProtocolError({
          exitCode: 3,
          code: "budget_cap_refusal",
          message: budgetBlock.message,
          remedy:
            requiredCap === undefined
              ? "Raise --max-cost-usd to the required cap and rerun."
              : `Rerun with --max-cost-usd ${requiredCap}.`,
        });
      }
      if (result.blocked.length > 0) {
        throw new Error(
          `Replay has blocked cells: ${result.blocked.map(({ message }) => message).join("; ")}`,
        );
      }
      completed += result.completed;
      skipped += result.skipped;
    }
  };

  await runCells("shortlist", candidates);
  const shortlistVerdicts = aggregate(
    await materializeAggregationFacts(context, plan, candidates),
    aggregateOptions(),
  ).filter(({ corpusSplit }) => corpusSplit === "shortlist");
  const shortlistSelections = new Map(
    Object.keys(plan.sampleSizes).map((family) => [
      family,
      selectWinner(
        verdictsByCandidate(
          shortlistVerdicts.filter((verdict) => verdict.familyId === family),
        ),
        RELEASE_GATE_POLICY,
      ),
    ]),
  );
  const holdoutCandidates = candidates.map((assignment) => ({
    ...assignment,
    candidates: assignment.candidates.filter((candidate) => {
      const family = plan.steps.find(
        ({ stepId }) => stepId === assignment.stepId,
      )?.family;
      if (family === undefined) return false;
      const selection = shortlistSelections.get(family);
      return (
        selection?.status === "confirmation_required" &&
        selection.confirmedCandidateId === candidate.id
      );
    }),
  }));
  await runCells("holdout", holdoutCandidates);
  const key = artifactKey(context, "replay", inputDigestValue);
  await putImmutableJson(context.store, key, {
    completed,
    skipped,
    candidates,
  });
  return key;
}

async function executeAggregate(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const plan = await loadReplayPlan(context);
  const replay = await loadReplayOutput(context);
  const allVerdicts = aggregate(
    await materializeAggregationFacts(context, plan, replay.candidates),
    aggregateOptions(),
  );
  const families: FamilyOutcome[] = [];
  for (const familyId of Object.keys(plan.sampleSizes).sort(compareText)) {
    const familyVerdicts = allVerdicts.filter(
      (verdict) => verdict.familyId === familyId,
    );
    const selection = selectWinner(
      verdictsByCandidate(familyVerdicts),
      RELEASE_GATE_POLICY,
    );
    const verdict = effectiveVerdict(familyVerdicts, selection);
    const gates = evaluateGates([verdict], RELEASE_GATE_POLICY);
    const effectiveRecommendation =
      selection.status === "selected" && gates.every(({ pass }) => pass);
    const decisionDisplay =
      verdict.decision === "recommend" && !effectiveRecommendation
        ? "recommend (gated)"
        : verdict.decision;
    const outcome: FamilyOutcome = {
      familyId,
      verdict,
      selection,
      gates,
      decisionDisplay,
      effectiveRecommendation,
    };
    families.push(outcome);
    await putMutableJson(
      context.store,
      verdictKey(context.projectId, familyId),
      jsonValue(verdict),
    );
  }
  const key = artifactKey(context, "aggregate", inputDigestValue);
  await putImmutableJson(context.store, key, { allVerdicts, families });
  return key;
}

async function materializeAggregationFacts(
  context: PipelineContext,
  plan: z.infer<typeof replayPlanSchema>,
  candidates: z.infer<typeof replayOutputSchema>["candidates"],
): Promise<AggregationFact[]> {
  const facts = await readFacts(context.store, context.projectId);
  const evidenceQuestionIds = new Set(
    plan.steps.map(({ evidenceQuestionId }) => evidenceQuestionId),
  );
  const executions = facts.flatMap((fact) => {
    const parsed = executionSchema.safeParse(fact);
    return parsed.success &&
      evidenceQuestionIds.has(parsed.data.evidenceQuestionId)
      ? [parsed.data]
      : [];
  });
  const assessments = new Map(
    facts.flatMap((fact) => {
      const parsed = assessmentSchema.safeParse(fact);
      return parsed.success
        ? ([[parsed.data.executionId, parsed.data]] as const)
        : [];
    }),
  );
  const familyByCase = new Map(
    plan.cases.map((item) => [item.caseId, item.family]),
  );
  const selectedByStep = new Map(
    candidates.map((item) => [item.stepId, item.candidates]),
  );
  const expectedAssignments = (
    family: string,
    candidateId: string,
    corpusSplit: "shortlist" | "holdout",
  ) =>
    plan.cases
      .filter(
        (item) =>
          item.family === family &&
          item.corpusSplit === corpusSplit &&
          selectedByStep.get(item.stepId)?.some(({ id }) => id === candidateId),
      )
      .map((item) => ({
        caseId: item.caseId,
        stratumId: family,
        evaluatorKind: "judge",
      }));
  return executions.flatMap((execution): AggregationFact[] => {
    const family = familyByCase.get(execution.caseId);
    if (family === undefined) {
      return [];
    }
    const assessment = assessments.get(execution.executionId);
    const selected = selectedByStep
      .get(execution.stepId)
      ?.find(({ id }) => id === execution.candidateId);
    if (selected === undefined) {
      return [];
    }
    const judge =
      assessment === undefined ? undefined : judgeMetadata(assessment);
    if (
      execution.corpusSplit !== "shortlist" &&
      execution.corpusSplit !== "holdout"
    ) {
      return [];
    }
    return [
      {
        execution,
        assessment,
        gatePolicyVersion: GATE_POLICY_VERSION,
        familyId: family,
        candidateFamily: selected.family,
        evaluatorKind: "judge",
        candidateCostUsd: blendedPrice(selected),
        referenceCeilingMultiplier: 1,
        unsafeSubstitution: false,
        evidenceCovered: true,
        expectedEvaluatorAssignments: expectedAssignments(
          family,
          execution.candidateId,
          execution.corpusSplit,
        ),
        stratumId: family,
        requiredAbstention: false,
        requiresDeterministicEvidence: false,
        hasDeterministicEvidence: false,
        ...(judge === undefined ? {} : judge),
      },
    ];
  });
}

function aggregateOptions() {
  return {
    gatePolicyVersion: RELEASE_GATE_POLICY.gatePolicyVersion,
    qualityFloor: RELEASE_GATE_POLICY.qualityFloor,
    availabilityFloor: RELEASE_GATE_POLICY.availabilityFloor,
  };
}

function verdictsByCandidate(verdicts: readonly FamilyVerdict[]) {
  const pending = new Map<
    string,
    { shortlist?: FamilyVerdict; holdout?: FamilyVerdict }
  >();
  for (const verdict of verdicts) {
    const current = pending.get(verdict.candidateId) ?? {};
    if (verdict.corpusSplit === "shortlist") {
      current.shortlist = verdict;
    } else {
      current.holdout = verdict;
    }
    pending.set(verdict.candidateId, current);
  }
  return Object.fromEntries(
    [...pending.entries()].map(([candidateId, candidate]) => {
      if (candidate.shortlist === undefined) {
        throw new Error(`Candidate ${candidateId} has no shortlist verdict`);
      }
      return [candidateId, { ...candidate, shortlist: candidate.shortlist }];
    }),
  );
}

function effectiveVerdict(
  verdicts: readonly FamilyVerdict[],
  selection: WinnerSelection,
): FamilyVerdict {
  if (
    selection.status === "selected" ||
    selection.status === "holdout_failed"
  ) {
    const holdout = verdicts.find(
      (verdict) =>
        verdict.candidateId === selection.confirmedCandidateId &&
        verdict.corpusSplit === "holdout",
    );
    if (holdout !== undefined) return holdout;
  }
  const shortlist = verdicts
    .filter(({ corpusSplit }) => corpusSplit === "shortlist")
    .sort(
      (left, right) =>
        left.candidateCostUsd - right.candidateCostUsd ||
        compareText(left.candidateId, right.candidateId),
    )[0];
  if (shortlist === undefined) {
    throw new Error("Family selection has no shortlist verdict");
  }
  return shortlist;
}

function modelFamily(modelId: string | null): string {
  if (modelId === null) return "unknown";
  return modelId.split("/", 1)[0] ?? "unknown";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reportPath(context: PipelineContext): string {
  return join(context.storeRoot, reportKey(context.projectId, "report.md"));
}

async function executeReport(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const report = await buildReport(context);
  const jsonKey = reportKey(context.projectId, "report.json");
  const markdownKey = reportKey(context.projectId, "report.md");
  await putMutableJson(context.store, jsonKey, jsonValue(report));
  await putMutableText(context.store, markdownKey, renderReport(report));
  return jsonKey;
}

async function checkpointOutputExists(
  context: PipelineContext,
  stage: PipelineStage,
  checkpoint: Checkpoint,
): Promise<boolean> {
  if ((await context.store.get(checkpoint.outputKey)) === null) return false;
  if (stage !== "report") return true;
  return (
    (await context.store.get(reportKey(context.projectId, "report.md"))) !==
    null
  );
}

async function loadScan(context: PipelineContext) {
  return loadCurrent(context, "scan", scanOutputSchema);
}

async function loadIngest(context: PipelineContext) {
  return loadCurrent(context, "ingest", ingestOutputSchema);
}

async function loadScrub(context: PipelineContext) {
  return loadCurrent(context, "scrub", scrubOutputSchema);
}

async function loadCorpusSummary(context: PipelineContext) {
  return loadCurrent(context, "corpus", corpusOutputSchema);
}

async function loadReplayPlan(context: PipelineContext) {
  return loadCurrent(context, "shortlist", replayPlanSchema);
}

async function loadReplayOutput(context: PipelineContext) {
  return loadCurrent(context, "replay", replayOutputSchema);
}

async function loadAggregateOutput(context: PipelineContext) {
  return loadCurrent(context, "aggregate", aggregateOutputSchema);
}

async function loadCurrent<T>(
  context: PipelineContext,
  stage: PipelineStage,
  schema: z.ZodType<T>,
): Promise<T> {
  const state = await readSetupState(context.store, context.projectId);
  const checkpoint = state.stages[stage];
  if (checkpoint === undefined) throw new Error(`${stage} has not completed`);
  return schema.parse(await readJson(context.store, checkpoint.outputKey));
}

function artifactKey(
  context: PipelineContext,
  stage: PipelineStage,
  inputDigestValue: string,
): string {
  return `${setupPrefix(context.projectId)}${stage}-${inputDigestValue}.json`;
}

async function putImmutableJson(
  store: Store,
  key: string,
  value: unknown,
): Promise<void> {
  await store.putImmutable(
    key,
    Buffer.from(canonicalJson(jsonValue(value)), "utf8"),
  );
}

async function putMutableText(
  store: Store,
  key: string,
  value: string,
): Promise<void> {
  const body = Buffer.from(value, "utf8");
  for (;;) {
    const entry = await store.get(key);
    if (entry !== null && Buffer.from(entry.body).equals(body)) return;
    const won = await store.compareAndSwap(
      key,
      entry?.version ?? 0,
      body,
      entry?.fenceToken ?? 0,
    );
    if (won) return;
  }
}

function jsonValue(value: unknown): JsonValue {
  return jsonValueSchema.parse(value);
}

function digest(value: JsonValue): string {
  return computeRunSpecDigest(value);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function repositoryFiles(
  repo: string,
  storeRoot: string,
): Promise<Array<{ absolute: string; path: string }>> {
  const ignored = new Set([
    ".git",
    ".rightmodeler",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "__pycache__",
  ]);
  const files: Array<{ absolute: string; path: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (absolute === storeRoot) continue;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          absolute,
          path: relative(repo, absolute).split(sep).join("/"),
        });
      }
    }
  }
  await visit(repo);
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function repositoryDigest(
  repo: string,
  storeRoot: string,
): Promise<string> {
  return digest(
    await Promise.all(
      (await repositoryFiles(repo, storeRoot)).map(async (file) => ({
        path: file.path,
        sha256: sha256(await readFile(file.absolute)),
      })),
    ),
  );
}

function corpusOutput(corpus: Corpus) {
  return {
    corpusVersionId: corpus.corpusVersionId,
    seed: corpus.seed,
    caseCount: corpus.cases.length,
    strata: corpus.strata,
  };
}

function chatMessages(
  messages: readonly JsonValue[],
): Record<string, JsonValue>[] {
  return messages.map((message, index) => {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    ) {
      throw new Error(`Recorded message ${index + 1} must be an object`);
    }
    return message;
  });
}

function blendedPrice(candidate: ModelCatalogEntry): number {
  if (candidate.pricing === null) return 0;
  return (3 * candidate.pricing.input + candidate.pricing.output) / 4;
}

function judgeMetadata(assessment: Assessment):
  | {
      judgeModel: string;
      orderConsistent: boolean;
    }
  | undefined {
  const artifact = assessment.artifactRef;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact)
  ) {
    return undefined;
  }
  return typeof artifact.judgeModel === "string" &&
    typeof artifact.orderConsistent === "boolean"
    ? {
        judgeModel: artifact.judgeModel,
        orderConsistent: artifact.orderConsistent,
      }
    : undefined;
}

function requiredCapFromMessage(message: string): string | undefined {
  return /raise it to at least \$([0-9.]+)/.exec(message)?.[1];
}

function normalizePipelineError(
  error: unknown,
  context: PipelineContext,
): unknown {
  if (error instanceof ProtocolError) return error;
  if (error instanceof FormatDetectionError) {
    return new ProtocolError({
      exitCode: 2,
      code: "ambiguous_trace_format",
      message: error.message,
      remedy:
        "Provide a trace file that unambiguously matches one supported format.",
    });
  }
  if (error instanceof ProviderConfigurationError) {
    return new ProtocolError({
      exitCode: 2,
      code: "missing_provider_configuration",
      message: error.message,
      remedy: `Set ${context.apiKeyEnv} or pass --api-key-env with the name of a populated environment variable.`,
    });
  }
  if (error instanceof BudgetRefusalError) {
    return new ProtocolError({
      exitCode: 3,
      code: "budget_cap_refusal",
      message: error.message,
      remedy: `Rerun with --max-cost-usd ${error.requiredCapUsd}.`,
    });
  }
  return error;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

interface ReportData {
  verdicts: FamilyVerdict[];
  families: FamilyOutcome[];
  judgeDisagreement: {
    disagreements: number;
    assessments: number;
    rate: number;
  };
  spend: {
    events: number;
    totalCostUsd: number;
    byActor: Record<string, { events: number; costUsd: number }>;
  };
  stratumWeights: {
    basis: "corpus_only";
    weights: Array<{
      family: string;
      corpusShare: number;
      trafficShare: number;
    }>;
  };
  caps: Array<{
    name: string;
    value: number;
    family?: string;
    stepId?: string;
  }>;
}

async function buildReport(context: PipelineContext): Promise<ReportData> {
  const aggregateOutput = await loadAggregateOutput(context);
  const verdicts = aggregateOutput.families.map(({ verdict }) => verdict);
  const facts = await readFacts(context.store, context.projectId);
  const assessments = facts.flatMap((fact) => {
    const parsed = assessmentSchema.safeParse(fact);
    return parsed.success ? [parsed.data] : [];
  });
  const consistency = assessments.flatMap((assessment) => {
    const metadata = judgeMetadata(assessment);
    return metadata === undefined ? [] : [metadata.orderConsistent];
  });
  const spends = facts.flatMap((fact) => {
    const parsed = spendEventSchema.safeParse(fact);
    return parsed.success ? [parsed.data] : [];
  });
  const byActor: Record<string, { events: number; costUsd: number }> = {};
  for (const spend of spends) {
    const actor = byActor[spend.actor] ?? { events: 0, costUsd: 0 };
    actor.events += 1;
    actor.costUsd += spend.costUsd;
    byActor[spend.actor] = actor;
  }
  const corpus = await loadCorpusSummary(context);
  const plan = await loadReplayPlan(context);
  const replay = await loadReplayOutput(context);
  const worksheet = await loadCurrent(
    context,
    "audit-sample",
    auditWorksheetSchema,
  );
  return {
    verdicts,
    families: aggregateOutput.families,
    judgeDisagreement: {
      disagreements: consistency.filter((value) => !value).length,
      assessments: consistency.length,
      rate:
        consistency.length === 0
          ? 0
          : consistency.filter((value) => !value).length / consistency.length,
    },
    spend: {
      events: spends.length,
      totalCostUsd: spends.reduce((total, spend) => total + spend.costUsd, 0),
      byActor,
    },
    stratumWeights: { basis: "corpus_only", weights: corpus.strata },
    caps: [
      { name: "top-N shortlist", value: plan.top },
      { name: "audit sample size", value: worksheet.cases.length },
      ...Object.entries(plan.sampleSizes).map(([family, value]) => ({
        name: "replay sample size",
        family,
        value,
      })),
      ...replay.candidates.map(({ stepId, droppedByTop }) => ({
        name: "droppedByTop",
        stepId,
        value: droppedByTop,
      })),
    ],
  };
}

function renderReport(report: ReportData): string {
  const lines = [
    "# Rightmodeler report",
    "",
    "## Family verdicts",
    "",
    "| Family | Decision | Evaluator rates | Availability | Excluded | Worst-case bound | Confidence band | Abstain reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const family of report.families) {
    const verdict = family.verdict;
    const evaluatorRates = verdict.evaluatorKinds
      .map(
        (kind) =>
          `${kind.evaluatorKind}: ${kind.passes}/${kind.trials} (${formatRate(kind.passRate)})`,
      )
      .join("; ");
    const confidence = verdict.naiveInterval
      ? `${formatRate(verdict.naiveInterval.lower)} to ${formatRate(verdict.naiveInterval.upper)}`
      : `${formatRate(verdict.clusterBootstrapLow ?? 0)} lower`;
    lines.push(
      `| ${verdict.familyId} | ${family.decisionDisplay} | ${evaluatorRates} | ${verdict.availability.availableExecutions}/${verdict.availability.executions} (${formatRate(verdict.availability.rate)}) | ${verdict.excludedExecutions}/${verdict.nExecutions} (${formatRate(verdict.excludedFraction)}) | ${formatRate(verdict.worstCaseBound)} | ${confidence} | ${verdict.decision === "abstain" ? formatAbstention(verdict.abstainReason) : ""} |`,
    );
  }
  lines.push(
    "",
    "## Gates",
    "",
    "| Family | Gate | Result | Reason |",
    "| --- | --- | --- | --- |",
    ...report.families.flatMap((family) =>
      family.gates.map(
        (gate) =>
          `| ${family.familyId} | ${gate.id} | ${gate.pass ? "pass" : "fail"} | ${gate.reason} |`,
      ),
    ),
    "",
    "## Selection",
    "",
    "| Family | Status | Shortlisted candidates | Confirmed candidate | Selection-adjusted estimate |",
    "| --- | --- | --- | --- | --- |",
    ...report.families.map((family) => {
      const selection = family.selection;
      const confirmed =
        selection.status === "no_shortlist_passer"
          ? ""
          : selection.confirmedCandidateId;
      const estimate =
        selection.status === "selected" || selection.status === "holdout_failed"
          ? `${formatRate(selection.selectionAdjustedEstimate.lower)} to ${formatRate(selection.selectionAdjustedEstimate.upper)} (${selection.selectionAdjustedEstimate.method}, ${selection.selectionAdjustedEstimate.comparisons} comparisons)`
          : "";
      return `| ${family.familyId} | ${selection.status} | ${selection.shortlistedCandidateIds.join(", ")} | ${confirmed} | ${estimate} |`;
    }),
    "",
    "## Judge disagreement",
    "",
    `${report.judgeDisagreement.disagreements}/${report.judgeDisagreement.assessments} (${formatRate(report.judgeDisagreement.rate)})`,
    "",
    "## Spend",
    "",
    `Total: $${report.spend.totalCostUsd.toFixed(8)} across ${report.spend.events} events.`,
    "",
    "## Stratum weights (corpus_only)",
    "",
    "| Family | Corpus share | Traffic share |",
    "| --- | --- | --- |",
    ...report.stratumWeights.weights.map(
      (weight) =>
        `| ${weight.family} | ${formatRate(weight.corpusShare)} | ${formatRate(weight.trafficShare)} |`,
    ),
    "",
    "## Caps",
    "",
    ...report.caps.map(
      (cap) =>
        `- ${cap.name}${cap.family === undefined ? "" : ` (${cap.family})`}${cap.stepId === undefined ? "" : ` (${cap.stepId})`}: ${cap.value}`,
    ),
    "",
  );
  return lines.join("\n");
}

function formatAbstention(abstention: {
  reason: string;
  observed: number;
  required: number;
}): string {
  return `${abstention.reason} (${formatNumber(abstention.observed)} of ${formatNumber(abstention.required)})`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : formatRate(value);
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function readFacts(store: Store, projectId: string): Promise<Fact[]> {
  const facts: Fact[] = [];
  for (const key of await store.list(factsPrefix(projectId))) {
    const value = await readJson(store, key);
    facts.push(factSchema.parse(value));
  }
  return facts;
}

function isFamilyVerdict(value: unknown): value is FamilyVerdict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.familyId === "string" &&
    ["recommend", "reject", "abstain", "inconclusive"].includes(
      String(record.decision),
    ) &&
    Array.isArray(record.evaluatorKinds)
  );
}

function parseVerdict(value: unknown): FamilyVerdict {
  if (!isFamilyVerdict(value)) {
    throw new Error("Family verdict is malformed");
  }
  return value;
}

async function readCurrentVerdicts(
  store: Store,
  projectId: string,
): Promise<FamilyVerdict[]> {
  const verdicts: FamilyVerdict[] = [];
  for (const key of await store.list(verdictsPrefix(projectId))) {
    verdicts.push(parseVerdict(await readJson(store, key)));
  }
  return verdicts.sort((left, right) =>
    compareText(left.familyId, right.familyId),
  );
}

export async function runAuditTabulate(options: {
  repo: string;
  store?: string;
  worksheet?: string;
}): Promise<ReturnType<typeof auditTabulate>> {
  const context = createContext({
    ...options,
    reporter: new Reporter("human", {
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  });
  const worksheet: AuditWorksheet = options.worksheet
    ? auditWorksheetSchema.parse(
        JSON.parse(await readFile(resolve(options.worksheet), "utf8")),
      )
    : await loadCurrent(context, "audit-sample", auditWorksheetSchema);
  const result = auditTabulate(worksheet);
  await putMutableJson(
    context.store,
    `${setupPrefix(context.projectId)}audit-result.json`,
    jsonValue(result),
  );
  return result;
}

export async function readReport(options: {
  repo: string;
  store?: string;
}): Promise<{
  report: ReportData;
  reportPath: string;
  recommends: boolean;
}> {
  const context = createContext({
    ...options,
    reporter: new Reporter("human", {
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  });
  const state = await readSetupState(context.store, context.projectId);
  const aggregateCheckpoint = state.stages.aggregate;
  if (aggregateCheckpoint === undefined) {
    throw new Error("aggregate has not completed");
  }
  await executeReport(
    context,
    digest({ stage: "report", upstream: aggregateCheckpoint.inputDigest }),
  );
  const report = await buildReport(context);
  const aggregateOutput = await loadAggregateOutput(context);
  return {
    report,
    reportPath: reportPath(context),
    recommends: aggregateOutput.families.some(
      ({ effectiveRecommendation }) => effectiveRecommendation,
    ),
  };
}

export async function readStatus(options: {
  repo: string;
  store?: string;
}): Promise<unknown> {
  const context = createContext({
    ...options,
    reporter: new Reporter("human", {
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  });
  const stepCounts: Record<string, number> = {};
  for (const key of await context.store.list(stepsPrefix(context.projectId))) {
    const record = stepRecordSchema.parse(await readJson(context.store, key));
    stepCounts[record.status] = (stepCounts[record.status] ?? 0) + 1;
  }
  const factCounts: Record<string, number> = {
    Execution: 0,
    RequestAttempt: 0,
    Assessment: 0,
    SpendEvent: 0,
  };
  for (const fact of await readFacts(context.store, context.projectId)) {
    if (executionSchema.safeParse(fact).success) factCounts.Execution += 1;
    else if (requestAttemptSchema.safeParse(fact).success)
      factCounts.RequestAttempt += 1;
    else if (assessmentSchema.safeParse(fact).success)
      factCounts.Assessment += 1;
    else if (spendEventSchema.safeParse(fact).success)
      factCounts.SpendEvent += 1;
  }
  const corpus = await maybeLoadCorpus(context);
  const runs: RunMeta[] = [];
  for (const key of await context.store.list(runsPrefix(context.projectId))) {
    runs.push(runMetaSchema.parse(await readJson(context.store, key)));
  }
  runs.sort((left, right) => compareText(right.startedAt, left.startedAt));
  return {
    stepsByStatus: stepCounts,
    factCounts,
    corpusVersion: corpus?.corpusVersionId ?? null,
    lastRun: runs[0] ?? null,
  };
}

async function maybeLoadCorpus(
  context: PipelineContext,
): Promise<z.infer<typeof corpusOutputSchema> | undefined> {
  const state = await readSetupState(context.store, context.projectId);
  return state.stages.corpus === undefined
    ? undefined
    : corpusOutputSchema.parse(
        await readJson(context.store, state.stages.corpus.outputKey),
      );
}
