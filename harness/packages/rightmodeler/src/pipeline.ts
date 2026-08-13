import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  assessmentSchema,
  callSiteInventoryKey,
  canonicalJson,
  cascadeFindingSchema,
  completeRun,
  computeRunSpecDigest,
  createRun,
  executionSchema,
  factKey,
  factSchema,
  factsPrefix,
  failRun,
  FsStore,
  jsonValueSchema,
  lifecycleEventSchema,
  mintAssessmentId,
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
  type CascadeFinding,
  type Fact,
  type JsonValue,
  type LifecycleEvent,
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
  type JudgeChat,
  type WinnerSelection,
} from "@rightmodeler/kernel";
import {
  BudgetRefusalError,
  confirmSwapSet,
  createBudget,
  createDockerExecutor,
  createProvider,
  ProviderConfigurationError,
  replayModeA,
  shortlist,
  type ModelCatalogEntry,
  type ModeBCase,
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
import {
  applySwaps,
  type ApplyCascadeStatus,
  type ApplyResult,
  type ApplyVerdict,
} from "./apply/index.js";
import {
  blastRadius,
  captureConventions,
  resolveOwners,
  type CapturedConventions,
} from "./enrich/index.js";
import {
  createBraintrustEvaluator,
  pollEvaluator,
  preferEvaluatorWhenReachable,
  resolveBraintrustEvaluatorConfig,
  type BraintrustEvaluatorConfig,
  type ResolvedBraintrustEvaluatorConfig,
} from "./evaluators/braintrust.js";
import type {
  EvaluatorCaseResult,
  EvaluatorProvider,
} from "./evaluators/types.js";
import type { GithubClient } from "./github/index.js";
import { ProtocolError, Reporter } from "./protocol.js";
import {
  putMutableJson,
  readJson,
  readSetupState,
  writeCheckpoint,
  type Checkpoint,
  type SetupState,
} from "./state.js";
import { watchOnce, type WatchResult } from "./watch/index.js";

const execFileAsync = promisify(execFile);

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
  "confirm",
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
  revision: z.string().min(1),
  records: z.array(stepRecordSchema),
});
const reconcileOutputSchema = z.strictObject({
  records: z.array(stepRecordSchema),
  matchedTraceSteps: z.number().int().nonnegative(),
  ambiguousTraceSteps: z.number().int().nonnegative(),
  unmatchedTraceSteps: z.number().int().nonnegative(),
  matchedCallSites: z.number().int().nonnegative(),
  ambiguousCallSites: z.number().int().nonnegative(),
  unmatchedCallSites: z.number().int().nonnegative(),
  ambiguityReasons: z.array(z.string()),
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
  evaluation: z.strictObject({
    evaluatorKind: z.string().min(1),
    gateMetric: z.string().min(1),
    assessmentAbsences: z.array(
      z.strictObject({
        executionId: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
  }),
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
    "recommend (unconfirmed)",
    "reject",
    "abstain",
    "inconclusive",
  ]),
  effectiveRecommendation: z.boolean(),
  confirmation: z
    .strictObject({
      status: z.enum([
        "not_required",
        "blocked",
        "confirmed",
        "isolated",
        "inconclusive",
      ]),
      runSetsUsed: z.number().int().nonnegative(),
      culprits: z.array(z.array(z.string().min(1))),
      cascadeSeedStepId: z.string().min(1).nullable(),
      maxRunSets: z.number().int().nonnegative().optional(),
      requiredMaxRunSets: z.number().int().nonnegative().optional(),
      blocker: z.string().min(1).optional(),
    })
    .optional(),
});
const aggregateOutputSchema = z.strictObject({
  allVerdicts: z.array(z.custom<FamilyVerdict>(isFamilyVerdict)),
  families: z.array(familyOutcomeSchema),
});
const confirmOutputSchema = aggregateOutputSchema.extend({
  confirmedFamilies: z.number().int().nonnegative(),
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
  evaluator?: ResolvedBraintrustEvaluatorConfig;
  modeBConfig?: ModeBConfig;
  modeBConfigPath?: string;
  reporter: Reporter;
}

export interface PipelineOptions {
  repo: string;
  store?: string;
  traces?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxCostUsd?: number;
  evaluator?: BraintrustEvaluatorConfig;
  modeBConfigPath?: string;
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

export interface ApplyPipelineOptions {
  readonly repo: string;
  readonly store?: string;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly githubRepo: string;
  readonly dryRun: boolean;
}

export interface WatchPipelineOptions {
  readonly repo: string;
  readonly store?: string;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly githubRepo: string;
  readonly prNumber: number;
}

export type RunApplyResult =
  | ApplyResult
  | {
      readonly status: "refused";
      readonly reasons: readonly [
        {
          readonly code: "previously_rejected";
          readonly message: string;
          readonly detail: JsonValue;
        },
      ];
    };

interface FamilyOutcome {
  familyId: string;
  verdict: FamilyVerdict;
  selection: WinnerSelection;
  gates: GateResult[];
  decisionDisplay:
    FamilyVerdict["decision"] | "recommend (gated)" | "recommend (unconfirmed)";
  effectiveRecommendation: boolean;
  confirmation?: {
    status:
      "not_required" | "blocked" | "confirmed" | "isolated" | "inconclusive";
    runSetsUsed: number;
    culprits: string[][];
    cascadeSeedStepId: string | null;
    maxRunSets?: number;
    requiredMaxRunSets?: number;
    blocker?: string;
  };
}

const modeBConfigSchema = z.strictObject({
  version: z.literal("1"),
  image: z.string().min(1),
  appSpec: z.strictObject({
    mountPath: z.string().min(1),
    command: z.array(z.string().min(1)).min(1),
    installCommand: z.array(z.string().min(1)).min(1).optional(),
  }),
  stepMap: z.record(z.string().min(1), z.string().min(1)),
  confirmMaxRunSets: z.number().int().nonnegative().optional(),
});

export type ModeBConfig = z.infer<typeof modeBConfigSchema>;

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
  const decisionOutput =
    state.stages.aggregate === undefined
      ? undefined
      : await loadDecisionOutput(context);
  return {
    stages: await planPipeline(options),
    executedStages,
    verdicts,
    ...(decisionOutput === undefined
      ? {}
      : { familyOutcomes: decisionOutput.families }),
    ...(state.stages.report === undefined
      ? {}
      : { reportPath: reportPath(context) }),
    recommendationExists:
      decisionOutput?.families.some(
        ({ effectiveRecommendation }) => effectiveRecommendation,
      ) ?? false,
  };
}

export async function runApply(
  options: ApplyPipelineOptions,
): Promise<RunApplyResult> {
  const context = createHeadlessContext(options);
  const prepared = await prepareApply(context);
  const terminal = await terminalApplyResult({
    store: context.store,
    owner: options.owner,
    repo: options.githubRepo,
    verdicts: prepared.verdicts,
  });
  if (terminal !== null) return terminal;
  return applySwaps({
    store: context.store,
    repoDir: context.repo,
    githubClient: options.githubClient,
    owner: options.owner,
    repo: options.githubRepo,
    conventions: prepared.conventions,
    verdicts: prepared.verdicts,
    dryRun: options.dryRun,
  });
}

export async function runWatch(
  options: WatchPipelineOptions,
): Promise<WatchResult> {
  const context = createHeadlessContext(options);
  const prepared = await prepareApply(context);
  return watchOnce({
    store: context.store,
    repoDir: context.repo,
    githubClient: options.githubClient,
    owner: options.owner,
    repo: options.githubRepo,
    prNumber: options.prNumber,
    conventions: prepared.conventions,
    verdicts: prepared.verdicts,
  });
}

function createHeadlessContext(options: {
  readonly repo: string;
  readonly store?: string;
}): PipelineContext {
  return createContext({
    repo: options.repo,
    store: options.store,
    reporter: new Reporter("human", {
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  });
}

async function prepareApply(context: PipelineContext): Promise<{
  readonly verdicts: readonly ApplyVerdict[];
  readonly conventions: CapturedConventions;
}> {
  const [scanOutput, decisionOutput, plan, reconciled, corpus] =
    await Promise.all([
      loadScan(context),
      loadDecisionOutput(context),
      loadReplayPlan(context),
      loadReconcile(context),
      loadCorpusSummary(context),
    ]);
  const familyByStep = new Map(
    plan.steps.map(({ stepId, family }) => [stepId, family] as const),
  );
  const records = reconciled.records.map((record) => ({
    ...record,
    family: familyByStep.get(record.stepId) ?? record.family,
  }));
  const ownerResolutions = await resolveOwners({
    repoDir: context.repo,
    filePaths: records.map(({ callSite }) => callSite.path),
  });
  const families = decisionOutput.families;
  const radii = blastRadius({
    stepRecords: records,
    verdicts: families.map(({ verdict }) => ({
      ...verdict,
      decision: "recommend" as const,
    })),
    owners: ownerResolutions,
  });
  const verdicts: ApplyVerdict[] = families.map((family) => {
    const familyRecords = plan.steps
      .filter(({ family: familyId }) => familyId === family.familyId)
      .map(({ stepId }) => records.find((record) => record.stepId === stepId))
      .filter((record) => record !== undefined);
    const candidate =
      family.selection.status === "selected"
        ? family.selection.selectedCandidateId
        : undefined;
    const swaps =
      candidate === undefined ||
      familyRecords.some(({ currentModel }) => currentModel === null)
        ? []
        : familyRecords.map((stepRecord) => ({
            stepRecord,
            fromModel: stepRecord.currentModel!,
            toModel: candidate,
          }));
    const radius = radii.find(({ familyId }) => familyId === family.familyId);
    if (radius === undefined) {
      throw new Error(`Missing blast radius for family ${family.familyId}`);
    }
    return {
      verdict: family.verdict,
      releaseGates: family.gates,
      cascadeStatus: applyCascadeStatus(family.confirmation?.status),
      evidence: {
        revision: scanOutput.revision,
        corpusVersionId: corpus.corpusVersionId,
      },
      swaps,
      blastRadius: radius,
      caps: [
        { name: "top-N shortlist", value: plan.top },
        {
          name: "replay sample size",
          value: plan.sampleSizes[family.familyId] ?? 0,
        },
        ...(family.confirmation?.maxRunSets === undefined
          ? []
          : [
              {
                name: "confirm max run sets",
                value: family.confirmation.maxRunSets,
              },
            ]),
      ],
    };
  });
  return {
    verdicts,
    conventions: await captureConventions({ repoDir: context.repo }),
  };
}

function applyRunSpecDigest(
  owner: string,
  repo: string,
  verdicts: readonly ApplyVerdict[],
): string | null {
  const selected = verdicts
    .filter(
      ({ verdict, cascadeStatus }) =>
        verdict.decision === "recommend" &&
        (cascadeStatus === "confirmed" || cascadeStatus === "not-required"),
    )
    .sort((left, right) =>
      compareText(left.verdict.familyId, right.verdict.familyId),
    );
  if (selected.length === 0) return null;
  const evidence = selected[0]!.evidence;
  const gatePolicyVersion = selected[0]!.verdict.gatePolicyVersion;
  if (
    selected.some(
      ({ verdict, releaseGates, evidence: candidate }) =>
        releaseGates.some(({ pass }) => !pass) ||
        candidate.revision !== evidence.revision ||
        candidate.corpusVersionId !== evidence.corpusVersionId ||
        verdict.gatePolicyVersion !== gatePolicyVersion,
    )
  ) {
    return null;
  }
  const swapSet = selected
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
  return computeRunSpecDigest({
    repo: `${owner}/${repo}`,
    evidenceRevision: evidence.revision,
    swapSet,
    corpusVersionId: evidence.corpusVersionId,
  });
}

async function terminalApplyResult({
  store,
  owner,
  repo,
  verdicts,
}: {
  readonly store: Store;
  readonly owner: string;
  readonly repo: string;
  readonly verdicts: readonly ApplyVerdict[];
}): Promise<RunApplyResult | null> {
  const runSpecDigest = applyRunSpecDigest(owner, repo, verdicts);
  if (runSpecDigest === null) return null;
  const matching = (await readFacts(store, PROJECT_ID))
    .flatMap((fact) => {
      const parsed = lifecycleEventSchema.safeParse(fact);
      return parsed.success && parsed.data.runSpecDigest === runSpecDigest
        ? [parsed.data]
        : [];
    })
    .sort(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) ||
        lifecycleKindOrder[left.kind] - lifecycleKindOrder[right.kind] ||
        compareText(left.eventId, right.eventId),
    );
  const terminal = [...matching]
    .reverse()
    .find(({ kind }) => kind === "pr_closed_rejected" || kind === "pr_merged");
  if (terminal === undefined || terminal.prNumber === null) return null;
  if (terminal.kind === "pr_closed_rejected") {
    return {
      status: "refused",
      reasons: [
        {
          code: "previously_rejected",
          message:
            "This evidence and swap set was previously rejected and requires new evidence before it can be proposed again.",
          detail: jsonValue({
            prNumber: terminal.prNumber,
            rejection: terminal.detail,
          }),
        },
      ],
    };
  }

  const opened = matching.find(
    (event) =>
      event.kind === "pr_opened" && event.prNumber === terminal.prNumber,
  );
  const detail = opened === undefined ? undefined : objectValue(opened.detail);
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
    runSpecDigest,
    prNumber: terminal.prNumber,
    branch: detail.branch,
    title: detail.title,
    reviewers: [],
    teamReviewers: [],
  };
}

function applyCascadeStatus(
  status:
    | "not_required"
    | "blocked"
    | "confirmed"
    | "isolated"
    | "inconclusive"
    | undefined,
): ApplyCascadeStatus {
  if (status === "not_required") return "not-required";
  if (
    status === "confirmed" ||
    status === "isolated" ||
    status === "inconclusive"
  ) {
    return status;
  }
  return "blocked";
}

function createContext(options: PipelineOptions): PipelineContext {
  const repo = resolve(options.repo);
  const storeRoot = resolve(options.store ?? join(repo, ".rightmodeler"));
  const modeBConfigPath =
    options.modeBConfigPath === undefined
      ? undefined
      : resolve(options.modeBConfigPath);
  return {
    repo,
    storeRoot,
    store: new FsStore(storeRoot),
    projectId: PROJECT_ID,
    traces: options.traces === undefined ? undefined : resolve(options.traces),
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv ?? API_KEY_ENV_DEFAULT,
    maxCostUsd: options.maxCostUsd,
    ...(options.evaluator === undefined
      ? {}
      : { evaluator: resolveBraintrustEvaluatorConfig(options.evaluator) }),
    ...(modeBConfigPath === undefined
      ? {}
      : {
          modeBConfigPath,
          modeBConfig: readModeBConfig(modeBConfigPath),
        }),
    reporter: options.reporter,
  };
}

function readModeBConfig(path: string): ModeBConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid --modeb-config file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = modeBConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field =
      issue.path.length === 0 ? "modebConfig" : issue.path.join(".");
    throw new Error(`Invalid --modeb-config field ${field}: ${issue.message}`);
  }
  if (
    !parsed.data.appSpec.command.some((part) => part.includes("{caseFile}"))
  ) {
    throw new Error(
      "Invalid --modeb-config field appSpec.command: one argument must contain {caseFile}",
    );
  }
  if (Object.keys(parsed.data.stepMap).length === 0) {
    throw new Error(
      "Invalid --modeb-config field stepMap: at least one canonical step is required",
    );
  }
  if (
    new Set(Object.values(parsed.data.stepMap)).size !==
    Object.keys(parsed.data.stepMap).length
  ) {
    throw new Error(
      "Invalid --modeb-config field stepMap: runtime step headers must be unique",
    );
  }
  return {
    ...parsed.data,
    appSpec: {
      ...parsed.data.appSpec,
      mountPath: resolve(dirname(path), parsed.data.appSpec.mountPath),
    },
  };
}

function evaluatorPlan(context: PipelineContext): JsonValue {
  return context.evaluator === undefined
    ? { evaluatorKind: "judge", gateMetric: "replacement-quality" }
    : {
        evaluatorKind: "braintrust",
        scorers: [...context.evaluator.scorers],
        gateMetric: context.evaluator.gateMetric,
        gateThreshold: context.evaluator.gateThreshold ?? null,
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
  if (stage === "reconcile" && context.modeBConfig !== undefined) {
    extra.stepMap = context.modeBConfig.stepMap;
  }
  if (stage === "corpus") extra.seed = CORPUS_SEED;
  if (stage === "audit-sample") extra.limit = AUDIT_SAMPLE_LIMIT;
  if (stage === "shortlist") extra.top = SHORTLIST_TOP;
  if (stage === "shortlist") {
    extra.evaluatorPlan = evaluatorPlan(context);
    const reproofRequests = await readReproofRequests(
      context.store,
      context.projectId,
    );
    if (reproofRequests.length > 0) {
      extra.reproofRequests = jsonValue(
        reproofRequests.map(({ familyId, requestIds }) => ({
          familyId,
          requestIds,
        })),
      );
    }
  }
  if (stage === "replay") {
    const reproofRequests = await readReproofRequests(
      context.store,
      context.projectId,
    );
    if (
      context.baseUrl === undefined &&
      reproofRequests.some(({ requested }) => requested)
    ) {
      return undefined;
    }
    if (context.baseUrl === undefined) return state.stages.replay?.inputDigest;
    if (reproofRequests.length > 0) {
      extra.reproofRequests = jsonValue(
        reproofRequests.map(({ familyId, requestIds }) => ({
          familyId,
          requestIds,
        })),
      );
    }
    extra.provider = digest({
      baseUrl: context.baseUrl,
      apiKeyEnv: context.apiKeyEnv,
      maxCostUsd: context.maxCostUsd ?? null,
      evaluatorPlan: evaluatorPlan(context),
    });
  }
  if (stage === "aggregate") {
    extra.gatePolicyVersion = GATE_POLICY_VERSION;
    extra.qualityFloor = RELEASE_GATE_POLICY.qualityFloor;
    extra.availabilityFloor = RELEASE_GATE_POLICY.availabilityFloor;
  }
  if (stage === "confirm") {
    const plan = await loadReplayPlan(context);
    const reconciled = await loadReconcile(context);
    const aggregateOutput = await loadAggregateOutput(context);
    const needsConfirmation = aggregateOutput.families.some(
      (family) =>
        family.effectiveRecommendation &&
        familyNeedsConfirmation(family.familyId, plan, reconciled.records),
    );
    extra.modeBConfig =
      context.modeBConfig === undefined
        ? "missing"
        : digest(jsonValue(context.modeBConfig));
    if (context.modeBConfig !== undefined && needsConfirmation) {
      if (context.baseUrl === undefined)
        return state.stages.confirm?.inputDigest;
      extra.provider = digest({
        baseUrl: context.baseUrl,
        apiKeyEnv: context.apiKeyEnv,
        maxCostUsd: context.maxCostUsd ?? null,
      });
    }
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
  if (stage === "confirm") {
    throw new ProtocolError({
      exitCode: 2,
      code: "missing_provider_configuration",
      message: "Provider configuration is required when confirm is reached.",
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
    case "confirm":
      return executeConfirm(context, inputDigestValue, runId);
    case "report":
      return executeReport(context, inputDigestValue);
  }
}

async function executeScan(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const revision = await repositoryRevision(context.repo);
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
  await putImmutableJson(context.store, key, { revision, records });
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
  const maxTrajectoryLength = Math.max(
    ...ingestOutput.runs.map(({ steps }) => steps.length),
  );
  const records = (() => {
    if (context.modeBConfig !== undefined) {
      const byId = new Map(
        scanOutput.records.map((record) => [record.stepId, record]),
      );
      return Object.keys(context.modeBConfig.stepMap).map((stepId) => {
        const record = byId.get(stepId);
        if (record === undefined) {
          throw new Error(
            `Invalid --modeb-config field stepMap.${stepId}: canonical step was not found by scan`,
          );
        }
        return record;
      });
    }
    if (
      scanOutput.records.length > maxTrajectoryLength &&
      scanOutput.records.every(({ currentModel }) => currentModel === null)
    ) {
      return scanOutput.records.slice(0, maxTrajectoryLength);
    }
    return scanOutput.records;
  })();
  const normalizedSteps = records.every(
    ({ currentModel }) => currentModel === null,
  )
    ? ingestOutput.runs
        .filter(({ steps }) => steps.length === records.length)
        .flatMap(({ steps }) => steps)
    : ingestOutput.runs.flatMap(({ steps }) => steps);
  const result = reconcile(normalizedSteps, records);
  const reconciledRecords = result.callSites.map(
    ({ stepRecord }) => stepRecord,
  );
  for (const record of reconciledRecords) {
    await putMutableJson(
      context.store,
      stepKey(context.projectId, record.stepId),
      jsonValue(record),
    );
  }
  const key = artifactKey(context, "reconcile", inputDigestValue);
  await putImmutableJson(context.store, key, {
    records: reconciledRecords,
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
  const records = (await loadReconcile(context)).records;
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
  const reproofRequests = new Map(
    (await readReproofRequests(context.store, context.projectId)).map(
      ({ familyId, requestIds }) => [familyId, requestIds] as const,
    ),
  );
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
    const reproofRequestIds = reproofRequests.get(family) ?? [];
    const evidenceQuestionId = computeRunSpecDigest(
      jsonValue({
        corpusVersionId: corpus.corpusVersionId,
        family,
        stepIds: assignedStepIds,
        gatePolicyVersion: GATE_POLICY_VERSION,
        evaluatorPlan: evaluatorPlan(context),
        replayMode: "single_shot",
        ...(reproofRequestIds.length === 0 ? {} : { reproofRequestIds }),
      }),
    );
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
  const shortlisted = shortlist(replaySteps("shortlist"), catalog, {
    top: plan.top,
  });
  const candidates = shortlisted.map((assignment) => {
    const family = plan.steps.find(
      ({ stepId }) => stepId === assignment.stepId,
    )?.family;
    if (family === undefined) return assignment;
    const familyStepIds = new Set(
      plan.steps
        .filter((step) => step.family === family)
        .map(({ stepId }) => stepId),
    );
    const familyAssignments = shortlisted.filter(({ stepId }) =>
      familyStepIds.has(stepId),
    );
    const commonIds = new Set(
      assignment.candidates
        .map(({ id }) => id)
        .filter((id) =>
          familyAssignments.every((candidate) =>
            candidate.candidates.some((model) => model.id === id),
          ),
        ),
    );
    return {
      ...assignment,
      candidates: assignment.candidates.filter(({ id }) => commonIds.has(id)),
    };
  });
  let externalEvaluator: EvaluatorProvider | undefined;
  if (context.evaluator !== undefined) {
    const configured = createBraintrustEvaluator(context.evaluator);
    externalEvaluator = await preferEvaluatorWhenReachable(
      configured,
      (code, message) => context.reporter.warning(code, message),
    );
  }
  const assessmentAbsences = new Map<string, string>();
  const evaluation = () => ({
    evaluatorKind: externalEvaluator?.id ?? "judge",
    gateMetric:
      externalEvaluator === undefined
        ? "replacement-quality"
        : context.evaluator!.gateMetric,
    assessmentAbsences: [...assessmentAbsences.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([executionId, reason]) => ({ executionId, reason })),
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
      const judge = (() => {
        if (externalEvaluator !== undefined) return undefined;
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
          {
            candidateFamily,
            referenceFamily: [...referenceFamilies][0]!,
          },
        );
        return {
          judgeModel,
          chat: async (request: Parameters<JudgeChat>[0]) =>
            (
              await provider.chat({
                model: request.model,
                messages: request.messages.map((message) => ({ ...message })),
                temperature: request.temperature,
                maxOutputTokens: 256,
                responseFormat: jsonValue(request.responseFormat),
              })
            ).content,
        };
      })();
      const result = await replayModeA({
        steps: replaySteps(split),
        cases: plan.cases,
        candidates: familyAssignments,
        provider,
        ...(judge === undefined ? {} : { judge }),
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
      if (externalEvaluator !== undefined) {
        const absences = await assessExternalExecutions({
          context,
          plan,
          evaluator: externalEvaluator,
          split,
          stepIds,
          candidateIds: new Set(
            familyAssignments.flatMap(({ candidates }) =>
              candidates.map(({ id }) => id),
            ),
          ),
        });
        for (const absence of absences) {
          assessmentAbsences.set(absence.executionId, absence.reason);
        }
      }
    }
  };

  await runCells("shortlist", candidates);
  const shortlistVerdicts = aggregate(
    await materializeAggregationFacts(context, plan, candidates, evaluation()),
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
    evaluation: evaluation(),
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
  const allVerdicts = aggregate(
    await materializeAggregationFacts(
      context,
      plan,
      replay.candidates,
      replay.evaluation,
    ),
    aggregateOptions(),
    cascadeFindings(facts),
  );
  const families = buildFamilyOutcomes(plan, allVerdicts);
  await writeFamilyVerdicts(context, families);
  const key = artifactKey(context, "aggregate", inputDigestValue);
  await putImmutableJson(context.store, key, { allVerdicts, families });
  return key;
}

function buildFamilyOutcomes(
  plan: z.infer<typeof replayPlanSchema>,
  allVerdicts: readonly FamilyVerdict[],
): FamilyOutcome[] {
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
      verdict.decision === "recommend" &&
      selection.status === "selected" &&
      gates.every(({ pass }) => pass);
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
  }
  return families;
}

async function writeFamilyVerdicts(
  context: PipelineContext,
  families: readonly FamilyOutcome[],
): Promise<void> {
  for (const { familyId, verdict } of families) {
    const key = verdictKey(context.projectId, familyId);
    const existing = await context.store.get(key);
    const reproof =
      existing === null
        ? undefined
        : parseReproofRequest(
            JSON.parse(Buffer.from(existing.body).toString("utf8")),
            familyId,
          );
    await putMutableJson(
      context.store,
      key,
      jsonValue(
        reproof === undefined
          ? verdict
          : {
              ...verdict,
              reproof_requested: false,
              reproof_request_ids: reproof.requestIds,
            },
      ),
    );
  }
}

async function executeConfirm(
  context: PipelineContext,
  inputDigestValue: string,
  runId: string,
): Promise<string> {
  const plan = await loadReplayPlan(context);
  const replay = await loadReplayOutput(context);
  const reconciled = await loadReconcile(context);
  const initial = await loadAggregateOutput(context);
  const needsConfirmation = new Set(
    initial.families
      .filter(
        (family) =>
          family.effectiveRecommendation &&
          familyNeedsConfirmation(family.familyId, plan, reconciled.records),
      )
      .map(({ familyId }) => familyId),
  );
  const confirmations = new Map<
    string,
    NonNullable<FamilyOutcome["confirmation"]>
  >();
  let confirmedFamilies = 0;

  if (needsConfirmation.size > 0 && context.modeBConfig === undefined) {
    for (const familyId of needsConfirmation) {
      confirmations.set(familyId, {
        status: "blocked",
        runSetsUsed: 0,
        culprits: [],
        cascadeSeedStepId: null,
        blocker: "Missing --modeb-config for cascade confirmation.",
      });
    }
  } else if (needsConfirmation.size > 0) {
    if (context.baseUrl === undefined) {
      throw new Error("Provider base URL is unavailable for confirmation");
    }
    const config = context.modeBConfig!;
    const provider = createProvider({
      providerId: "configured-provider",
      baseUrl: context.baseUrl,
      apiKeyEnv: context.apiKeyEnv,
    });
    const catalog = await provider.listModels();
    const configuredRecords = configuredStepRecords(config, reconciled.records);
    const orderedRecords = topologicalRecords(configuredRecords);
    const runtimeByCanonical = config.stepMap;
    const runtimeRecords = orderedRecords.map((record) => ({
      stepId: runtimeByCanonical[record.stepId]!,
      currentModel: record.currentModel,
      needsTools: record.capabilityRequirements.includes("tools"),
      needsStructuredOutput:
        record.capabilityRequirements.includes("structured_output"),
      observedContextTokens: 0,
      corpusSplit: "holdout" as const,
      selectionStage: "confirm",
    }));
    const targetStepId = runtimeRecords.at(-1)!.stepId;
    const scrubbedRuns = (await loadScrub(context)).runs;
    const judgeCatalog = catalog.map((model) => ({
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
    }));
    const budget = createBudget({
      store: context.store,
      projectId: context.projectId,
      runId,
      authorizedTotalUsd: context.maxCostUsd,
    });

    for (const familyId of [...needsConfirmation].sort(compareText)) {
      const family = initial.families.find(
        (candidate) => candidate.familyId === familyId,
      )!;
      if (family.selection.status !== "selected") {
        throw new Error(`Family ${familyId} has no selected candidate`);
      }
      const selectedCandidateId = family.selection.selectedCandidateId;
      if (selectedCandidateId === undefined) {
        throw new Error(`Family ${familyId} selection has no candidate id`);
      }
      const selectedCatalogEntry = catalog.find(
        ({ id }) => id === selectedCandidateId,
      );
      if (selectedCatalogEntry === undefined) {
        throw new Error(
          `Selected candidate is absent from the catalog: ${selectedCandidateId}`,
        );
      }
      const referenceFamily = modelFamily(configuredRecords[0]!.currentModel);
      const judgeModel = pickJudge(judgeCatalog, {
        candidateFamily: selectedCatalogEntry.family,
        referenceFamily,
      });
      const cases = confirmationCases(scrubbedRuns, targetStepId, familyId);
      const canonicalSwapStepIds = plan.steps
        .filter((step) => step.family === familyId)
        .map(({ stepId }) => stepId);
      const swapSet = canonicalSwapStepIds.map((stepId) => {
        const record = configuredRecords.find(
          (candidate) => candidate.stepId === stepId,
        );
        if (record?.currentModel === null || record === undefined) {
          throw new Error(
            `Configured confirmation step has no current model: ${stepId}`,
          );
        }
        return {
          stepId: runtimeByCanonical[stepId]!,
          currentModel: record.currentModel,
          candidateModel: selectedCandidateId,
        };
      });
      const maxRunSets =
        config.confirmMaxRunSets ?? defaultConfirmMaxRunSets(swapSet.length);
      const result = await confirmSwapSet({
        family: {
          familyId,
          evidenceQuestionId: family.verdict.evidenceQuestionId,
          stepOrder: orderedRecords
            .filter(({ stepId }) => canonicalSwapStepIds.includes(stepId))
            .map(({ stepId }) => runtimeByCanonical[stepId]!),
        },
        swapSet,
        cases,
        modeB: {
          input: {
            executor: createDockerExecutor({
              maxBytesPerNamespace: 16 * 1024 * 1024,
            }),
            egress: {
              providerId: provider.providerId,
              providerBaseUrl: modeBProviderBaseUrl(context.baseUrl),
              apiKeyEnv: context.apiKeyEnv,
              catalog,
            },
            image: config.image,
            appSpec: {
              mountPath: config.appSpec.mountPath,
              command: (caseFile) =>
                config.appSpec.command.map((part) =>
                  part.replaceAll("{caseFile}", caseFile),
                ),
              ...(config.appSpec.installCommand === undefined
                ? {}
                : { installCommand: config.appSpec.installCommand }),
            },
            concurrency: 4,
          },
          stepRecords: runtimeRecords.map((record) => ({
            ...record,
            evidenceQuestionId: family.verdict.evidenceQuestionId,
          })),
          judge: {
            judgeModel,
            providerId: provider.providerId,
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
        },
        store: context.store,
        budget: { modeB: budget, maxRunSets },
        policy: RELEASE_GATE_POLICY,
      });
      confirmedFamilies += 1;
      confirmations.set(familyId, {
        status: result.verdict,
        runSetsUsed: result.runSetsUsed,
        culprits: result.culprits.map((culprit) => [...culprit]),
        cascadeSeedStepId: result.cascadeSeed ?? null,
        maxRunSets,
        ...(result.requiredMaxRunSets === undefined
          ? {}
          : { requiredMaxRunSets: result.requiredMaxRunSets }),
      });
    }
  }

  const facts = await readFacts(context.store, context.projectId);
  const allVerdicts = aggregate(
    await materializeAggregationFacts(
      context,
      plan,
      replay.candidates,
      replay.evaluation,
    ),
    aggregateOptions(),
    cascadeFindings(facts),
  );
  const families = buildFamilyOutcomes(plan, allVerdicts).map((family) => {
    const confirmation = confirmations.get(family.familyId);
    if (confirmation !== undefined) {
      const blocked = confirmation.status === "blocked";
      return {
        ...family,
        confirmation,
        effectiveRecommendation: blocked
          ? false
          : family.effectiveRecommendation,
        decisionDisplay: blocked
          ? ("recommend (unconfirmed)" as const)
          : family.decisionDisplay,
      };
    }
    return {
      ...family,
      confirmation: {
        status: "not_required" as const,
        runSetsUsed: 0,
        culprits: [],
        cascadeSeedStepId: null,
      },
    };
  });
  await writeFamilyVerdicts(context, families);
  const key = artifactKey(context, "confirm", inputDigestValue);
  await putImmutableJson(context.store, key, {
    allVerdicts,
    families,
    confirmedFamilies,
  });
  return key;
}

function familyNeedsConfirmation(
  familyId: string,
  plan: z.infer<typeof replayPlanSchema>,
  records: readonly z.infer<typeof stepRecordSchema>[],
): boolean {
  const ids = new Set(
    plan.steps
      .filter((step) => step.family === familyId)
      .map(({ stepId }) => stepId),
  );
  return records.some(
    (record) =>
      ids.has(record.stepId) &&
      !(
        record.downstreamStepIds.length === 0 &&
        record.prefixProvenance === "external"
      ),
  );
}

function configuredStepRecords(
  config: ModeBConfig,
  records: readonly z.infer<typeof stepRecordSchema>[],
) {
  const byId = new Map(records.map((record) => [record.stepId, record]));
  return Object.keys(config.stepMap).map((stepId) => {
    const record = byId.get(stepId);
    if (record === undefined) {
      throw new Error(
        `Configured step is missing after reconciliation: ${stepId}`,
      );
    }
    return record;
  });
}

export function topologicalRecords(
  records: readonly z.infer<typeof stepRecordSchema>[],
) {
  const byId = new Map(records.map((record) => [record.stepId, record]));
  if (byId.size !== records.length) {
    throw new Error("Configured confirmation steps contain duplicate ids");
  }
  const indegree = new Map(records.map(({ stepId }) => [stepId, 0]));
  const downstream = new Map<string, string[]>();
  for (const record of records) {
    const selectedDownstream = [
      ...new Set(record.downstreamStepIds.filter((stepId) => byId.has(stepId))),
    ];
    downstream.set(record.stepId, selectedDownstream);
    for (const stepId of selectedDownstream) {
      indegree.set(stepId, indegree.get(stepId)! + 1);
    }
  }
  const compareRecords = (
    left: z.infer<typeof stepRecordSchema>,
    right: z.infer<typeof stepRecordSchema>,
  ) =>
    compareText(left.callSite.path, right.callSite.path) ||
    left.callSite.line - right.callSite.line ||
    compareText(left.stepId, right.stepId);
  const ready = records
    .filter(({ stepId }) => indegree.get(stepId) === 0)
    .sort(compareRecords);
  const ordered: z.infer<typeof stepRecordSchema>[] = [];
  while (ready.length > 0) {
    const record = ready.shift()!;
    ordered.push(record);
    for (const stepId of downstream.get(record.stepId) ?? []) {
      const nextIndegree = indegree.get(stepId)! - 1;
      indegree.set(stepId, nextIndegree);
      if (nextIndegree === 0) {
        ready.push(byId.get(stepId)!);
        ready.sort(compareRecords);
      }
    }
  }
  if (ordered.length !== records.length) {
    throw new Error("Configured confirmation steps contain a dependency cycle");
  }
  return ordered;
}

function defaultConfirmMaxRunSets(swapCount: number): number {
  return Math.max(20, 2 ** Math.min(swapCount, 4) + 4);
}

function confirmationCases(
  runs: z.infer<typeof normalizedRunSchema>[],
  targetStepId: string,
  familyId: string,
): ModeBCase[] {
  return runs
    .filter((run) => run.steps.some(({ family }) => family === familyId))
    .map((run) => {
      const first = run.steps[0];
      const last = run.steps.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error(`Trajectory ${run.traceId} has no confirmation steps`);
      }
      const input = firstJsonText(first.messages);
      const referenceOutput = firstJsonText(last.output);
      return {
        caseId: `confirm-${run.traceId}`,
        stepId: targetStepId,
        trajectoryId: run.traceId,
        corpusSplit: "holdout",
        task: "Reproduce the accepted final response for this recorded trajectory.",
        ...(first.systemPrompt === undefined
          ? {}
          : { system: first.systemPrompt }),
        messages: chatMessages(first.messages),
        contextTokens: Math.max(
          ...run.steps.map(({ usage }) => usage.inputTokens),
        ),
        maxOutputTokens: 256,
        referenceOutput,
        input,
      };
    });
}

function firstJsonText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstJsonTextOrUndefined(item);
      if (text !== undefined) return text;
    }
  } else if (value !== null && typeof value === "object") {
    const text = firstJsonTextOrUndefined(value);
    if (text !== undefined) return text;
  }
  throw new Error("Recorded confirmation data contains no text content");
}

function firstJsonTextOrUndefined(value: JsonValue): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return value
      .map(firstJsonTextOrUndefined)
      .find((item) => item !== undefined);
  }
  if (typeof value.content === "string") return value.content;
  if (typeof value.text === "string") return value.text;
  return [value.parts, value.messages, value.output]
    .map(firstJsonTextOrUndefined)
    .find((item) => item !== undefined);
}

function cascadeFindings(facts: readonly Fact[]): CascadeFinding[] {
  return facts.flatMap((fact) => {
    const parsed = cascadeFindingSchema.safeParse(fact);
    return parsed.success ? [parsed.data] : [];
  });
}

async function assessExternalExecutions(input: {
  context: PipelineContext;
  plan: z.infer<typeof replayPlanSchema>;
  evaluator: EvaluatorProvider;
  split: "shortlist" | "holdout";
  stepIds: ReadonlySet<string>;
  candidateIds: ReadonlySet<string>;
}): Promise<readonly { executionId: string; reason: string }[]> {
  const config = input.context.evaluator;
  if (config === undefined) {
    throw new Error("External evaluator configuration is unavailable");
  }
  const facts = await readFacts(input.context.store, input.context.projectId);
  const assessedGateExecutions = new Set(
    facts.flatMap((fact) => {
      const parsed = assessmentSchema.safeParse(fact);
      return parsed.success &&
        parsed.data.evaluatorId === input.evaluator.id &&
        parsed.data.metricName === config.gateMetric
        ? [parsed.data.executionId]
        : [];
    }),
  );
  const executions = facts.flatMap((fact) => {
    const parsed = executionSchema.safeParse(fact);
    return parsed.success &&
      parsed.data.corpusSplit === input.split &&
      parsed.data.terminalOutcome === "success" &&
      parsed.data.attribution === "ok" &&
      input.stepIds.has(parsed.data.stepId) &&
      input.candidateIds.has(parsed.data.candidateId) &&
      !assessedGateExecutions.has(parsed.data.executionId)
      ? [parsed.data]
      : [];
  });
  if (executions.length === 0) return [];

  const recordedCases = new Map(
    input.plan.cases.map((recordedCase) => [
      `${recordedCase.stepId}\0${recordedCase.caseId}`,
      recordedCase,
    ]),
  );
  const launched = await input.evaluator.launch({
    experimentName: `rightmodeler-${digest({
      evidenceQuestionIds: [
        ...new Set(
          executions.map(({ evidenceQuestionId }) => evidenceQuestionId),
        ),
      ].sort(compareText),
      candidateIds: [...input.candidateIds].sort(compareText),
      split: input.split,
    }).slice(0, 24)}`,
    cases: executions.map((execution) => {
      const recordedCase = recordedCases.get(
        `${execution.stepId}\0${execution.caseId}`,
      );
      if (recordedCase === undefined) {
        throw new Error(
          `Execution ${execution.executionId} has no recorded evaluator case`,
        );
      }
      return {
        caseId: execution.executionId,
        input: jsonValue({
          task: recordedCase.task,
          ...(recordedCase.system === undefined
            ? {}
            : { system: recordedCase.system }),
          messages: recordedCase.messages,
        }),
        expected: recordedCase.referenceOutput,
        output: execution.finalOutput,
      };
    }),
  });
  const status = await pollEvaluator(input.evaluator, launched.providerRunId);
  const results = await input.evaluator.collect(launched.providerRunId);
  const resultsByExecution = new Map(
    results.map((result) => [result.caseId, result]),
  );
  const existingMetrics = new Set(
    facts.flatMap((fact) => {
      const parsed = assessmentSchema.safeParse(fact);
      return parsed.success && parsed.data.evaluatorId === input.evaluator.id
        ? [`${parsed.data.executionId}\0${parsed.data.metricName}`]
        : [];
    }),
  );
  for (const result of results) {
    await persistEvaluatorMetrics(
      input.context,
      input.evaluator,
      config,
      launched.providerRunId,
      result,
      existingMetrics,
    );
  }

  return executions.flatMap((execution) => {
    const result = resultsByExecution.get(execution.executionId);
    if (
      result?.metrics.some(({ metricName }) => metricName === config.gateMetric)
    ) {
      return [];
    }
    return [
      {
        executionId: execution.executionId,
        reason:
          status === "failed"
            ? "external_experiment_failed"
            : result === undefined
              ? "external_event_missing"
              : "external_gate_metric_missing",
      },
    ];
  });
}

async function persistEvaluatorMetrics(
  context: PipelineContext,
  evaluator: EvaluatorProvider,
  config: ResolvedBraintrustEvaluatorConfig,
  providerRunId: string,
  result: EvaluatorCaseResult,
  existingMetrics: Set<string>,
): Promise<void> {
  for (const metric of result.metrics) {
    const key = `${result.caseId}\0${metric.metricName}`;
    if (existingMetrics.has(key)) continue;
    const thresholdApplied =
      metric.passed === null && config.gateThreshold !== undefined;
    if (metric.passed === null && !thresholdApplied) {
      throw new Error(
        `Evaluator metric ${metric.metricName} has no pass decision; configure --evaluator-gate-threshold`,
      );
    }
    const rubricVersion = thresholdApplied
      ? `threshold:${config.gateThreshold}`
      : metric.rubricVersion;
    if (rubricVersion === undefined) {
      throw new Error(
        `Evaluator metric ${metric.metricName} has no rubric version`,
      );
    }
    const assessmentId = mintAssessmentId();
    const assessment = assessmentSchema.parse({
      assessmentId,
      executionId: result.caseId,
      evaluatorId: evaluator.id,
      metricName: metric.metricName,
      score: metric.score,
      passed: thresholdApplied
        ? metric.score >= config.gateThreshold!
        : metric.passed!,
      rubricVersion,
      artifactRef: {
        providerRunId,
        providerArtifact: result.artifactRef ?? null,
      },
    });
    await putImmutableJson(
      context.store,
      factKey(context.projectId, assessmentId),
      assessment,
    );
    existingMetrics.add(key);
  }
}

async function materializeAggregationFacts(
  context: PipelineContext,
  plan: z.infer<typeof replayPlanSchema>,
  candidates: z.infer<typeof replayOutputSchema>["candidates"],
  evaluation: z.infer<typeof replayOutputSchema>["evaluation"],
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
  const assessments = new Map<string, Assessment[]>();
  for (const fact of facts) {
    const parsed = assessmentSchema.safeParse(fact);
    if (!parsed.success) continue;
    const current = assessments.get(parsed.data.executionId) ?? [];
    current.push(parsed.data);
    assessments.set(parsed.data.executionId, current);
  }
  const assessmentAbsences = new Map(
    evaluation.assessmentAbsences.map(({ executionId, reason }) => [
      executionId,
      reason,
    ]),
  );
  if (assessmentAbsences.size !== evaluation.assessmentAbsences.length) {
    throw new Error(
      "External assessment absences contain duplicate executions",
    );
  }
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
        evaluatorKind: evaluation.evaluatorKind,
      }));
  return executions.flatMap((execution): AggregationFact[] => {
    const family = familyByCase.get(execution.caseId);
    if (family === undefined) {
      return [];
    }
    const gateAssessments = (
      assessments.get(execution.executionId) ?? []
    ).filter(
      (assessment) =>
        assessment.metricName === evaluation.gateMetric &&
        (evaluation.evaluatorKind === "judge" ||
          assessment.evaluatorId === evaluation.evaluatorKind),
    );
    if (gateAssessments.length > 1) {
      throw new Error(
        `Execution ${execution.executionId} has duplicate gate metric assessments for ${evaluation.gateMetric}`,
      );
    }
    const assessment = gateAssessments[0];
    const selected = selectedByStep
      .get(execution.stepId)
      ?.find(({ id }) => id === execution.candidateId);
    if (selected === undefined) {
      return [];
    }
    const judge =
      assessment === undefined || evaluation.evaluatorKind !== "judge"
        ? undefined
        : judgeMetadata(assessment);
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
        ...(assessment === undefined &&
        assessmentAbsences.has(execution.executionId)
          ? {
              assessmentAbsentReason: assessmentAbsences.get(
                execution.executionId,
              )!,
            }
          : {}),
        gatePolicyVersion: GATE_POLICY_VERSION,
        familyId: family,
        candidateFamily: selected.family,
        evaluatorKind: evaluation.evaluatorKind,
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

function modeBProviderBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.pathname.replace(/\/$/, "").endsWith("/v1")) {
    url.pathname = url.pathname.replace(/\/?v1\/?$/, "/");
  }
  return url.href.replace(/\/$/, "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

async function loadReconcile(context: PipelineContext) {
  return loadCurrent(context, "reconcile", reconcileOutputSchema);
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

async function loadConfirmOutput(context: PipelineContext) {
  return loadCurrent(context, "confirm", confirmOutputSchema);
}

async function loadDecisionOutput(context: PipelineContext) {
  const state = await readSetupState(context.store, context.projectId);
  return state.stages.confirm === undefined
    ? loadAggregateOutput(context)
    : loadConfirmOutput(context);
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
  return digest({
    revision: await repositoryRevision(repo),
    files: await Promise.all(
      (await repositoryFiles(repo, storeRoot)).map(async (file) => ({
        path: file.path,
        sha256: sha256(await readFile(file.absolute)),
      })),
    ),
  });
}

async function repositoryRevision(repo: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  return stdout.trim();
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
  apply: Array<{
    runSpecDigest: string;
    repo: string;
    prNumber: number | null;
    familyIds: string[];
    state: LifecycleEvent["kind"];
    revision: string;
    corpusVersionId: string;
    gatePolicyVersion: string;
    createdAt: string;
    eventCount: number;
  }>;
}

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

function lifecycleReport(
  events: readonly LifecycleEvent[],
): ReportData["apply"] {
  const grouped = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    grouped.set(event.runSpecDigest, [
      ...(grouped.get(event.runSpecDigest) ?? []),
      event,
    ]);
  }
  return [...grouped.entries()]
    .map(([runSpecDigest, group]) => {
      const ordered = [...group].sort(
        (left, right) =>
          compareText(left.createdAt, right.createdAt) ||
          lifecycleKindOrder[left.kind] - lifecycleKindOrder[right.kind] ||
          compareText(left.eventId, right.eventId),
      );
      const latest = ordered[ordered.length - 1]!;
      const prNumber = [...ordered]
        .reverse()
        .find((event) => event.prNumber !== null)?.prNumber;
      return {
        runSpecDigest,
        repo: latest.repo,
        prNumber: prNumber ?? null,
        familyIds: [...latest.familyIds],
        state: latest.kind,
        revision: latest.evidence.revision,
        corpusVersionId: latest.evidence.corpusVersionId,
        gatePolicyVersion: latest.evidence.gatePolicyVersion,
        createdAt: latest.createdAt,
        eventCount: ordered.length,
      };
    })
    .sort(
      (left, right) =>
        compareText(right.createdAt, left.createdAt) ||
        compareText(left.runSpecDigest, right.runSpecDigest),
    );
}

async function buildReport(context: PipelineContext): Promise<ReportData> {
  const decisionOutput = await loadDecisionOutput(context);
  const verdicts = decisionOutput.families.map(({ verdict }) => verdict);
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
  const lifecycle = facts.flatMap((fact) => {
    const parsed = lifecycleEventSchema.safeParse(fact);
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
    families: decisionOutput.families,
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
      ...decisionOutput.families.flatMap((family) =>
        family.confirmation?.maxRunSets === undefined
          ? []
          : [
              {
                name: "confirm max run sets",
                family: family.familyId,
                value: family.confirmation.maxRunSets,
              },
            ],
      ),
    ],
    apply: lifecycleReport(lifecycle),
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
      `| ${verdict.familyId} | ${family.decisionDisplay} | ${evaluatorRates} | ${verdict.availability.availableExecutions}/${verdict.availability.executions} (${formatRate(verdict.availability.rate)}) | ${verdict.excludedExecutions}/${verdict.nExecutions} (${formatRate(verdict.excludedFraction)}) | ${formatRate(verdict.worstCaseBound)} | ${confidence} | ${verdict.abstainReason === undefined ? "" : formatAbstention(verdict.abstainReason)} |`,
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
    "## Confirm",
    "",
    "Confirmation exhaustively tests swap subsets and may require up to 2^n run sets for n swaps. The default cap is structurally inconclusive at five or more swapped steps; raise the configured cap when an action is shown.",
    "",
    "| Family | Status | Run sets used | Run-set cap | Cascade seed | Culprits | Action | Blocker |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.families.map((family) => {
      const confirmation = family.confirmation;
      const action =
        confirmation?.requiredMaxRunSets === undefined
          ? ""
          : `raise to ${confirmation.requiredMaxRunSets}`;
      return `| ${family.familyId} | ${confirmation?.status ?? "not run"} | ${confirmation?.runSetsUsed ?? 0} | ${confirmation?.maxRunSets ?? ""} | ${confirmation?.cascadeSeedStepId ?? ""} | ${confirmation?.culprits.map((culprit) => culprit.join(" + ")).join("; ") ?? ""} | ${action} | ${confirmation?.blocker ?? ""} |`;
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
  if (report.apply.length > 0) {
    lines.push(
      "## Apply",
      "",
      "| Repository | Pull request | Families | State | Revision | Corpus version | Events |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...report.apply.map(
        (apply) =>
          `| ${apply.repo} | ${apply.prNumber ?? ""} | ${apply.familyIds.join(", ")} | ${apply.state} | ${apply.revision} | ${apply.corpusVersionId} | ${apply.eventCount} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

function formatAbstention(abstention: {
  reason: string;
  observed?: number;
  required?: number;
}): string {
  return abstention.observed === undefined || abstention.required === undefined
    ? abstention.reason
    : `${abstention.reason} (${formatNumber(abstention.observed)} of ${formatNumber(abstention.required)})`;
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

interface ReproofRequest {
  readonly familyId: string;
  readonly requested: boolean;
  readonly requestIds: readonly string[];
}

function parseReproofRequest(
  value: unknown,
  expectedFamilyId?: string,
): ReproofRequest | undefined {
  const verdict = parseVerdict(value);
  if (expectedFamilyId !== undefined && verdict.familyId !== expectedFamilyId) {
    throw new Error(
      `Stored verdict for ${expectedFamilyId} has the wrong familyId`,
    );
  }
  const record = value as Record<string, unknown>;
  const requested = record.reproof_requested;
  const requestIds = record.reproof_request_ids;
  if (requested === undefined && requestIds === undefined) return undefined;
  if (requested !== undefined && typeof requested !== "boolean") {
    throw new Error(
      `Stored verdict for ${verdict.familyId} has malformed reproof_requested`,
    );
  }
  if (
    requestIds !== undefined &&
    (!Array.isArray(requestIds) ||
      requestIds.some((requestId) => typeof requestId !== "string"))
  ) {
    throw new Error(
      `Stored verdict for ${verdict.familyId} has malformed reproof_request_ids`,
    );
  }
  return {
    familyId: verdict.familyId,
    requested: requested ?? false,
    requestIds: [...new Set((requestIds ?? []) as string[])].sort(compareText),
  };
}

async function readReproofRequests(
  store: Store,
  projectId: string,
): Promise<ReproofRequest[]> {
  const requests: ReproofRequest[] = [];
  for (const key of await store.list(verdictsPrefix(projectId))) {
    const request = parseReproofRequest(await readJson(store, key));
    if (request !== undefined) requests.push(request);
  }
  return requests.sort((left, right) =>
    compareText(left.familyId, right.familyId),
  );
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
    digest({
      stage: "report",
      upstream:
        state.stages.confirm?.inputDigest ?? aggregateCheckpoint.inputDigest,
    }),
  );
  const report = await buildReport(context);
  const decisionOutput = await loadDecisionOutput(context);
  return {
    report,
    reportPath: reportPath(context),
    recommends: decisionOutput.families.some(
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
    CascadeFinding: 0,
    LifecycleEvent: 0,
  };
  for (const fact of await readFacts(context.store, context.projectId)) {
    if (executionSchema.safeParse(fact).success) factCounts.Execution += 1;
    else if (requestAttemptSchema.safeParse(fact).success)
      factCounts.RequestAttempt += 1;
    else if (assessmentSchema.safeParse(fact).success)
      factCounts.Assessment += 1;
    else if (spendEventSchema.safeParse(fact).success)
      factCounts.SpendEvent += 1;
    else if (cascadeFindingSchema.safeParse(fact).success)
      factCounts.CascadeFinding += 1;
    else if (lifecycleEventSchema.safeParse(fact).success)
      factCounts.LifecycleEvent += 1;
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
