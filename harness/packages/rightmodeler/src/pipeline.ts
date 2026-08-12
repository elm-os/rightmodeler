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
  type AggregationFact,
  type FamilyVerdict,
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
import { createMatcherRegistry, reconcile, scan } from "@rightmodeler/scanner";
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
const SHORTLIST_TOP = 1;
const QUALITY_FLOOR = 0.7;
const AVAILABILITY_FLOOR = 0.7;
const GATE_POLICY_VERSION = "phase-a-v1";
const API_KEY_ENV_DEFAULT = "RIGHTMODELER_API_KEY";

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
  corpusSplit: z.literal("shortlist"),
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
  corpusSplit: z.literal("shortlist"),
  selectionStage: z.literal("shortlist"),
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
    return {
      stages: await planPipeline(options),
      executedStages: [],
      verdicts: await readCurrentVerdicts(context.store, context.projectId),
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

  return {
    stages: await planPipeline(options),
    executedStages,
    verdicts: await readCurrentVerdicts(context.store, context.projectId),
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
    extra.qualityFloor = QUALITY_FLOOR;
    extra.availabilityFloor = AVAILABILITY_FLOOR;
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
      left.localeCompare(right),
  );
  const steps: Array<ReplayStep & { family: string }> = [];
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
        corpusSplit: "shortlist",
        selectionStage: "shortlist",
      });
    }
    familyCases.forEach((corpusCase, index) => {
      const step = assignedRecords[index % assignedRecords.length]!;
      cases.push({
        family,
        caseId: corpusCase.caseId,
        stepId: step.stepId,
        trajectoryId: corpusCase.content.trajectoryId,
        corpusSplit: "shortlist",
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
  const candidates = shortlist(plan.steps, catalog, { top: plan.top });
  const budget = createBudget({
    store: context.store,
    projectId: context.projectId,
    runId,
    authorizedTotalUsd: context.maxCostUsd,
  });
  const result = await replayModeA({
    steps: plan.steps,
    cases: plan.cases,
    candidates,
    provider,
    judge: {
      judgeModel: "phase-a-reference-judge",
      chat: async () =>
        JSON.stringify({
          verdict: "equivalent",
          score: 1,
          justification: "Equivalent under the Phase A reference evaluator.",
        }),
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
  const key = artifactKey(context, "replay", inputDigestValue);
  await putImmutableJson(context.store, key, {
    completed: result.completed,
    skipped: result.skipped,
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
  const facts = await readFacts(context.store, context.projectId);
  const executions = facts.flatMap((fact) => {
    const parsed = executionSchema.safeParse(fact);
    return parsed.success ? [parsed.data] : [];
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
    replay.candidates.map((item) => [item.stepId, item.candidates]),
  );
  const expectedByFamily = new Map(
    Object.keys(plan.sampleSizes).map((family) => [
      family,
      plan.cases
        .filter((item) => item.family === family)
        .map((item) => ({
          caseId: item.caseId,
          stratumId: family,
          evaluatorKind: "judge",
        })),
    ]),
  );
  const aggregationFacts: AggregationFact[] = executions.map((execution) => {
    const family = familyByCase.get(execution.caseId);
    if (family === undefined) {
      throw new Error(
        `Replay execution has no assigned family: ${execution.executionId}`,
      );
    }
    const assessment = assessments.get(execution.executionId);
    const selected = selectedByStep
      .get(execution.stepId)
      ?.find(({ id }) => id === execution.candidateId);
    if (selected === undefined) {
      throw new Error(
        `Replay execution has no selected candidate: ${execution.executionId}`,
      );
    }
    const judge =
      assessment === undefined ? undefined : judgeMetadata(assessment);
    return {
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
      expectedEvaluatorAssignments: expectedByFamily.get(family)!,
      stratumId: family,
      requiredAbstention: false,
      requiresDeterministicEvidence: false,
      hasDeterministicEvidence: false,
      ...(judge === undefined ? {} : judge),
    };
  });
  const verdicts = aggregate(aggregationFacts, {
    gatePolicyVersion: GATE_POLICY_VERSION,
    qualityFloor: QUALITY_FLOOR,
    availabilityFloor: AVAILABILITY_FLOOR,
  });
  const byFamily = new Map<string, FamilyVerdict>();
  for (const verdict of verdicts) {
    const existing = byFamily.get(verdict.familyId);
    if (existing !== undefined) {
      throw new Error(
        `Phase A expected one candidate verdict for family ${verdict.familyId}`,
      );
    }
    byFamily.set(verdict.familyId, verdict);
    await putMutableJson(
      context.store,
      verdictKey(context.projectId, verdict.familyId),
      jsonValue(verdict),
    );
  }
  const key = artifactKey(context, "aggregate", inputDigestValue);
  await putImmutableJson(context.store, key, { verdicts });
  return key;
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

async function repositoryDigest(
  repo: string,
  storeRoot: string,
): Promise<string> {
  const ignored = new Set([
    ".git",
    ".rightmodeler",
    "node_modules",
    "dist",
    "build",
    ".venv",
    "__pycache__",
  ]);
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (absolute === storeRoot) continue;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolute);
      } else if (entry.isFile()) {
        files.push({
          path: relative(repo, absolute).split(sep).join("/"),
          sha256: sha256(await readFile(absolute)),
        });
      }
    }
  }
  await visit(repo);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return digest(files);
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
  caps: Array<{ name: string; value: number; family?: string }>;
}

async function buildReport(context: PipelineContext): Promise<ReportData> {
  const verdicts = await readCurrentVerdicts(context.store, context.projectId);
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
  const worksheet = await loadCurrent(
    context,
    "audit-sample",
    auditWorksheetSchema,
  );
  return {
    verdicts,
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
  for (const verdict of report.verdicts) {
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
      `| ${verdict.familyId} | ${verdict.decision} | ${evaluatorRates} | ${verdict.availability.availableExecutions}/${verdict.availability.executions} (${formatRate(verdict.availability.rate)}) | ${verdict.excludedExecutions}/${verdict.nExecutions} (${formatRate(verdict.excludedFraction)}) | ${formatRate(verdict.worstCaseBound)} | ${confidence} | ${verdict.decision === "abstain" ? verdict.abstainReason : ""} |`,
    );
  }
  lines.push(
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
        `- ${cap.name}${cap.family === undefined ? "" : ` (${cap.family})`}: ${cap.value}`,
    ),
    "",
  );
  return lines.join("\n");
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

function parseVerdict(value: unknown): FamilyVerdict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Family verdict must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.familyId !== "string" ||
    !["recommend", "reject", "abstain", "inconclusive"].includes(
      String(record.decision),
    ) ||
    !Array.isArray(record.evaluatorKinds)
  ) {
    throw new Error("Family verdict is malformed");
  }
  return value as FamilyVerdict;
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
    left.familyId.localeCompare(right.familyId),
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
}): Promise<{ report: unknown; recommends: boolean }> {
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
  const report = await readJson(
    context.store,
    reportKey(context.projectId, "report.json"),
  );
  const verdicts = await readCurrentVerdicts(context.store, context.projectId);
  return {
    report,
    recommends: verdicts.some(({ decision }) => decision === "recommend"),
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
  runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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
