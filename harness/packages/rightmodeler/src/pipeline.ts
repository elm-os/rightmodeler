import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  assessmentSchema,
  blendedPrice,
  callSiteInventoryKey,
  catalogFamily,
  canonicalJson,
  compareText,
  completeRun,
  computeEvidenceQuestionId,
  computeRunSpecDigest,
  createRun,
  factKey,
  failRun,
  FsStore,
  jsonValueSchema,
  mintAssessmentId,
  readLedger,
  reportKey,
  runKey,
  runMetaSchema,
  runsPrefix,
  setupPrefix,
  stepKey,
  stepRecordSchema,
  stepsPrefix,
  verdictKey,
  verdictsPrefix,
  type Assessment,
  type Execution,
  type JsonValue,
  type Ledger,
  type LifecycleEvent,
  type RequestAttempt,
  type RunMeta,
  type SpendEvent,
  type StepRecord,
  type Store,
} from "@rightmodeler/core";
import {
  aggregate,
  diagnoseFailure,
  evaluateGates,
  MIN_DISTINCT_STEPS,
  minimumTrialsForFloor,
  NoNeutralJudgeError,
  pickJudges,
  ReleaseGatePolicy,
  selectWinner,
  type AggregationFact,
  type AbstainReasonDetails,
  type Diagnosis,
  type FamilyVerdict,
  type GateResult,
  type JudgeChat,
  type WinnerSelection,
} from "@rightmodeler/kernel";
import {
  BudgetRefusalError,
  CatalogReferenceError,
  confirmSwapSet,
  createBudget,
  createCloudExecutor,
  createDockerExecutor,
  detectCloudAvailability,
  isUsageLimit,
  ProviderConfigurationError,
  replayModeA,
  resolveCurrentModel,
  shortlist,
  toWireMessages,
  type ModelCatalogEntry,
  type ModelPricing,
  type ModeBCase,
  type ProviderClient,
  type RecordedCase,
  type ReplayStep,
  type StepShortlist,
  type SubstitutedResponse,
} from "@rightmodeler/replay";
import {
  createMatcherRegistry,
  detectTech,
  evaluateCoverage,
  IGNORED_DIRECTORIES,
  loadDeclarativeMatchers,
  reconcile,
  scan,
  type DeclarativeMatcher,
} from "@rightmodeler/scanner";
import { z } from "zod";

import {
  auditCorpusSample,
  auditTabulate,
  buildCorpus,
  detectFormat,
  excludedStepsWarning,
  FormatDetectionError,
  normalizedRunSchema,
  parseTraceRecords,
  referenceCeilings,
  scrubRuns,
  strictRuns,
  TraceAdaptError,
  traceAdapters,
  writeCorpus,
  type AuditResult,
  type AuditWorksheet,
  type Corpus,
  type ReferenceCeiling,
} from "./data/index.js";
import {
  applySwaps as applyPreparedSwaps,
  type ApplyCascadeStatus,
  type ApplyResult,
  type ApplyVerdict,
} from "./apply/orchestrator.js";
import {
  estimateReplayCost,
  type ReplayCostEstimate,
  type ReplayCostJudge,
} from "./estimate.js";
import { readActiveCorpus, readCorpusVersion } from "./drift.js";
import {
  blastRadius,
  captureConventions,
  resolveOwners,
  type CapturedConventions,
} from "./enrich/index.js";
import {
  pollEvaluator,
  preferEvaluatorWhenReachable,
} from "./evaluators/braintrust.js";
import {
  bindFamily,
  traceStepKey,
  type FamilyBinding,
} from "./family-binding.js";
import {
  importCorpus,
  writeImportedCorpus,
  type CorpusImportConfig,
} from "./evaluators/corpus-import.js";
import { readPromptfooConfigs } from "./evaluators/promptfoo.js";
import {
  createEvaluator,
  resolveEvaluatorConfig,
  type EvaluatorConfig,
  type ResolvedEvaluatorConfig,
} from "./evaluators/registry.js";
import {
  exportResults,
  resultExportReceiptSchema,
  type ResultExportReceipt,
  type ResultSinkConfig,
} from "./evaluators/result-sinks.js";
import type {
  EvaluatorCaseResult,
  EvaluatorProvider,
} from "./evaluators/types.js";
import {
  graphFileDigest,
  readCodeContext,
  renderCodeContext,
  type CallSiteInput,
  type CodeContext,
} from "./code-graph/index.js";
import type { GithubClient } from "./github/index.js";
import { ProtocolError, Reporter } from "./protocol.js";
import {
  formatDeltaPct,
  formatLatencyMs,
  formatUsdPerCase,
} from "./report/format.js";
import { apiRoute, type RouteHandle, type RouteKind } from "./routes.js";
import {
  putImmutableJson,
  putMutableJson,
  readJson,
  readSetupState,
  resolveStoreRoot,
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

const detachedRunProgressSchema = z.strictObject({
  runId: z.string().min(1),
  stage: z.enum(PIPELINE_STAGES),
});
const detachedReplayWorkerSchema = z.strictObject({
  runId: z.string().min(1),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  startedAt: z.string().datetime(),
});

const PROJECT_ID = "project";
const ACTIVE_CORPUS_KEY = `${PROJECT_ID}/corpus/active.json`;
const CORPUS_SEED = 42;
const AUDIT_SAMPLE_LIMIT = 20;
const DEFAULT_SHORTLIST_TOP = 3;
const DEFAULT_QUALITY_FLOOR = 0.85;
const AVAILABILITY_FLOOR = 0.7;
const GATE_POLICY_BASE_VERSION = "phase-a-v3";
const REPLAY_PROMPT_REVISION = "replay-prompt-v1";
const SCAN_REVISION = "scan-trace-key-v1";
const TRACE_BINDING_REVISION = "sendable-cases-v1";
const TRACE_READER_REVISION = "gateway-exclusions-v1";
const API_KEY_ENV_DEFAULT = "RIGHTMODELER_API_KEY";

function auditResultKey(projectId: string): string {
  return `${setupPrefix(projectId)}audit-result.json`;
}

function importedReferenceCorpusKey(projectId: string): string {
  return `${setupPrefix(projectId)}imported-reference-corpus.json`;
}

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
  traceStepBindings: z
    .array(
      z.strictObject({
        traceId: z.string().min(1),
        stepIndex: z.number().int().nonnegative(),
        stepIds: z.array(z.string().min(1)),
        via: z.enum(["trajectory_position", "trace_key", "model"]).optional(),
      }),
    )
    .default([]),
});
const ingestOutputSchema = z.strictObject({
  format: z.enum(traceAdapters.map(({ name }) => name)),
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
  recordedMaxOutputTokens: z.number().int().positive().optional(),
});
const familyPlanSchema = z.strictObject({
  familyId: z.string().min(1),
  evidenceQuestionId: z.string().min(1),
  cases: z.number().int().nonnegative(),
  holdoutCases: z.number().int().nonnegative(),
  minimumHoldoutCases: z.number().int().positive(),
  stepIds: z.array(z.string().min(1)),
  abstainReason: z
    .strictObject({
      reason: z.enum([
        "ambiguous_call_site_binding",
        "unmatched_call_site_binding",
        "bound_call_sites_not_replayable",
        "holdout_below_floor_minimum",
        "insufficient_distinct_steps",
      ]),
      observed: z.number().int().nonnegative(),
      required: z.number().int().nonnegative(),
    })
    .optional(),
  binding: z.enum(["trace_key", "trace_match"]).optional(),
  leftOutCases: z.number().int().positive().optional(),
});
const replayPlanSchema = z.strictObject({
  top: z.number().int().positive(),
  includeFreeModels: z.boolean(),
  allowModels: z.array(z.string().min(1)).default([]),
  denyModels: z.array(z.string().min(1)).default([]),
  sampleSizes: z.record(z.string(), z.number().int().positive()),
  familyPlans: z.array(familyPlanSchema).default([]),
  steps: z.array(replayPlanStepSchema),
  cases: z.array(replayPlanCaseSchema),
});
export type FamilyPlan = z.infer<typeof familyPlanSchema>;
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
  releasedAt: z.number().nonnegative().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  outputModalities: z.array(z.string()).optional(),
  requiresReasoning: z.boolean().optional(),
});
const detachedReplayCatalogSchema = z.strictObject({
  runId: z.string().min(1),
  models: z.array(modelCatalogSchema),
});
const replayOutputSchema = z.strictObject({
  completed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  candidates: z.array(
    z.strictObject({
      stepId: z.string().min(1),
      candidates: z.array(modelCatalogSchema),
      droppedByTop: z.number().int().nonnegative(),
      droppedFreeModels: z.number().int().nonnegative(),
      droppedByOutputCeiling: z.number().int().nonnegative().default(0),
      resolvedCurrentModelId: z.string().min(1).optional(),
      currentPricing: z
        .strictObject({
          input: z.number().nonnegative(),
          output: z.number().nonnegative(),
        })
        .nullable()
        .optional(),
      abstention: z
        .strictObject({
          kind: z.enum([
            "current-model-absent",
            "current-model-ambiguous",
            "no-priced-candidates",
          ]),
          message: z.string(),
        })
        .optional(),
    }),
  ),
  evaluation: z.strictObject({
    evaluatorKind: z.string().min(1),
    gateMetric: z.string().min(1),
    evaluatorIdentity: z.string().min(1).optional(),
    assessmentAbsences: z.array(
      z.strictObject({
        executionId: z.string().min(1),
        reason: z.string().min(1),
      }),
    ),
  }),
  familyBlocks: z
    .array(
      z.strictObject({
        familyId: z.string().min(1),
        abstainReason: z.strictObject({
          reason: z.literal("replay_operational_block"),
          observed: z.number().nonnegative(),
          required: z.number().nonnegative(),
        }),
      }),
    )
    .default([]),
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
const referenceCeilingSchema = z.strictObject({
  family: z.string().min(1),
  multiplier: z.number().min(0).max(1),
  baseMultiplier: z.number().min(0).max(1),
  baseSource: z.enum(["audit", "default"]),
  referenceCount: z.number().int().nonnegative(),
  verifiedCuratedReferences: z.number().int().nonnegative(),
});
const familyOutcomeSchema = z.strictObject({
  familyId: z.string().min(1),
  verdict: z.custom<FamilyVerdict>(isFamilyVerdict),
  referenceCeiling: referenceCeilingSchema,
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
      lostReasons: z
        .record(z.string(), z.number().int().nonnegative())
        .optional(),
      infrastructureBlocks: z
        .array(
          z.strictObject({
            reason: z.string().min(1),
            message: z.string(),
          }),
        )
        .optional(),
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
const setupArtifactSchemas = {
  scan: scanOutputSchema,
  reconcile: reconcileOutputSchema,
  shortlist: replayPlanSchema,
  aggregate: aggregateOutputSchema,
  confirm: confirmOutputSchema,
} as const;
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
const auditResultSchema = z.strictObject({
  perFamily: z.record(
    z.string(),
    z.strictObject({
      n: z.number().int().positive(),
      disagreement: z.number().min(0).max(1),
      wilsonLow: z.number().min(0).max(1),
      wilsonHigh: z.number().min(0).max(1),
      referenceAgreementPoint: z.number().min(0).max(1).nullable(),
      referenceAgreementPointReason: z
        .literal("below_minimum_audited_count")
        .optional(),
    }),
  ),
});
const importedReferenceCorpusSchema = z.strictObject({
  corpusVersionId: z.string().min(1),
  cases: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      family: z.string().min(1),
      referenceSource: z.literal("curated"),
      referenceVerified: z.boolean(),
    }),
  ),
});

interface PipelineCache {
  repositoryFiles?: Promise<Array<{ absolute: string; path: string }>>;
  repositoryDigest?: Promise<string>;
  setupArtifacts: Map<string, Promise<unknown[]>>;
  codeContext?: Promise<CodeContext | undefined>;
}

interface PipelineContext {
  repo: string;
  storeRoot: string;
  store: Store;
  projectId: string;
  traces?: string;
  baseUrl?: string;
  apiKeyEnv: string;
  maxCostUsd?: number;
  maxConcurrency?: number;
  includeFreeModels: boolean;
  evaluator?: ResolvedEvaluatorConfig;
  modeBConfig?: ModeBConfig;
  modeBConfigPath?: string;
  pricingOverrides?: z.infer<typeof pricingFileSchema>;
  pricingFilePath?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  catalogReference?: string;
  routes?: { readonly candidates: RouteKind; readonly judge: RouteKind };
  policyFilePath?: string;
  release: ReleasePolicyResolution;
  matchers?: readonly DeclarativeMatcher[];
  matchersPath?: string;
  existingRunId?: string;
  approvedRunSpecDigest?: string;
  codeGraphPath?: string;
  reporter: Reporter;
  cache: PipelineCache;
}

export interface PipelineOptions {
  repo: string;
  store?: string;
  traces?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxCostUsd?: number;
  maxConcurrency?: number;
  includeFreeModels?: boolean;
  evaluator?: EvaluatorConfig;
  modeBConfigPath?: string;
  pricingFilePath?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  catalogReference?: string;
  policyFilePath?: string;
  matchersPath?: string;
  approvedRunSpecDigest?: string;
  codeGraphPath?: string;
  through?: PipelineStage;
  plan?: boolean;
  existingRunId?: string;
  reporter: Reporter;
}

export interface StagePlanEntry {
  stage: PipelineStage;
  state: StageState;
}

export interface PipelineResult {
  stages: StagePlanEntry[];
  policy?: EffectiveReleasePolicy;
  familyPlans?: FamilyPlan[];
  executedStages: PipelineStage[];
  verdicts: FamilyVerdict[];
  familyOutcomes?: FamilyOutcome[];
  reportPath?: string;
  recommendationExists: boolean;
}

export interface DetachedReplayClaim {
  readonly runId: string;
  readonly status: RunMeta["status"];
  readonly terminal: boolean;
  readonly deduplicated: boolean;
}

export interface RunStatusResult {
  readonly runId: string;
  readonly type: string;
  readonly phase: string;
  readonly status: RunMeta["status"];
  readonly terminal: boolean;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly progress: {
    readonly completedStages: PipelineStage[];
    readonly targetStage: PipelineStage | null;
    readonly completed: number;
    readonly total: number | null;
  };
}

export interface ApplyPipelineOptions {
  readonly repo: string;
  readonly store?: string;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly githubRepo: string;
  readonly dryRun: boolean;
  readonly codeGraphPath?: string;
  readonly warning?: (code: string, message: string) => void;
}

export interface WatchPipelineOptions {
  readonly repo: string;
  readonly store?: string;
  readonly githubClient: GithubClient;
  readonly owner: string;
  readonly githubRepo: string;
  readonly prNumber: number;
  readonly warning?: (code: string, message: string) => void;
}

export interface WatchablePullRequest {
  readonly prNumber: number;
  readonly phase: "open" | "terminal";
}

export interface ApprovedSwapSet {
  readonly runSpecDigest: string;
  readonly prNumber: number;
  readonly familyIds: readonly string[];
  readonly swaps: readonly ApprovedSwap[];
}

export interface ApprovedSwap {
  readonly familyId: string;
  readonly stepId: string;
  readonly path: string;
  readonly fromModel: string;
  readonly toModel: string;
}

export type RunApplyResult = ApplyResult;

interface FamilyOutcome {
  familyId: string;
  verdict: FamilyVerdict;
  referenceCeiling: ReferenceCeiling;
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
    lostReasons?: Readonly<Record<string, number>>;
    infrastructureBlocks?: readonly {
      readonly reason: string;
      readonly message: string;
    }[];
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
  backend: z.enum(["docker", "cloud"]).optional(),
  confirmMaxRunSets: z.number().int().nonnegative().optional(),
});

const pricingFileSchema = z.record(
  z.string().min(1),
  z.strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    maxOutputTokens: z.number().int().positive().optional(),
  }),
);
const releasePolicyFileSchema = z.strictObject({
  qualityFloor: z.number().gt(0.8).lt(1).optional(),
  shortlistTop: z.number().int().positive().optional(),
  allowModels: z.array(z.string().min(1)).optional(),
  denyModels: z.array(z.string().min(1)).optional(),
});

export type ModeBConfig = z.infer<typeof modeBConfigSchema>;

export async function planPipeline(
  options: PipelineOptions,
): Promise<Pick<PipelineResult, "stages" | "familyPlans" | "policy">> {
  const context = createContext(options);
  return planStages(context, options);
}

async function planStages(
  context: PipelineContext,
  options: PipelineOptions,
): Promise<Pick<PipelineResult, "stages" | "familyPlans" | "policy">> {
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
  if (
    result.some(
      ({ stage, state }) => stage === "reconcile" && state === "complete",
    ) &&
    result.some(
      ({ stage, state }) => stage === "corpus" && state === "complete",
    ) &&
    stages.includes("shortlist")
  ) {
    const reconciled = await loadReconcile(context);
    const corpus = await resolveCheckpointedPipelineCorpus(context);
    const approved =
      context.approvedRunSpecDigest === undefined
        ? undefined
        : await approvedSwapSetByDigest(context, context.approvedRunSpecDigest);
    return {
      stages: result,
      policy: context.release.effective,
      familyPlans: (
        await planFamilies(context, corpus, reconciled, approved)
      ).map(({ plan }) => plan),
    };
  }
  return { stages: result, policy: context.release.effective };
}

export async function readIngestResumption(options: PipelineOptions): Promise<{
  readonly resumable: boolean;
  readonly tracePath?: string;
}> {
  const context = createContext(options);
  const checkpoint = (await readSetupState(context.store, context.projectId))
    .stages.ingest;
  if (
    checkpoint === undefined ||
    !(await checkpointOutputExists(context, "ingest", checkpoint))
  ) {
    return { resumable: false };
  }
  return {
    resumable: true,
    ...(checkpoint.traceSource === undefined
      ? {}
      : { tracePath: checkpoint.traceSource }),
  };
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
      ...(await planStages(context, options)),
      executedStages: [],
      verdicts,
      recommendationExists: false,
    };
  }

  await repositoryRevision(context.repo);
  const initialState = await readSetupState(context.store, context.projectId);
  const ingestCheckpoint = initialState.stages.ingest;
  if (
    stagesThrough(options.through).includes("ingest") &&
    context.traces === undefined &&
    (ingestCheckpoint === undefined ||
      !(await checkpointOutputExists(context, "ingest", ingestCheckpoint)))
  ) {
    throw missingTracesPath();
  }

  if (options.existingRunId !== undefined) {
    const existing = await requireRunningReplayRun(
      context,
      options.existingRunId,
    );
    if (options.through !== existing.phase) {
      throw new Error(
        `Detached run ${existing.runId} must execute through ${existing.phase}`,
      );
    }
  }

  const run =
    options.existingRunId === undefined
      ? await createRun(context.store, {
          projectId: context.projectId,
          type: "init",
          phase: options.through ?? "report",
        })
      : await requireRunningReplayRun(context, options.existingRunId);
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
        await markDetachedRunProgress(context, options.existingRunId, stage);
        continue;
      }

      context.reporter.event({ event: "stage_started", stage });
      const outputKey = await executeStage(stage, context, digest, run.runId);
      await writeCheckpoint(context.store, context.projectId, stage, {
        inputDigest: digest,
        outputKey,
        completedAt: new Date().toISOString(),
        ...(stage === "ingest" && context.traces !== undefined
          ? { traceSource: context.traces }
          : {}),
      });
      executedStages.push(stage);
      context.reporter.event({ event: "stage_completed", stage });
      await markDetachedRunProgress(context, options.existingRunId, stage);
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
    stages: (await planStages(context, options)).stages,
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

export async function estimateReplay(
  options: PipelineOptions,
): Promise<ReplayCostEstimate & { readonly policy: EffectiveReleasePolicy }> {
  const context = createContext(options);
  const routes = replayRoutes(context);
  const plan = await loadReplayPlan(context);
  const known =
    context.existingRunId === undefined
      ? await routeCatalog(() => routes.candidates.known())
      : await readDetachedReplayCatalog(context, context.existingRunId);
  const judgeCatalog =
    context.existingRunId === undefined
      ? await routeCatalog(() => routes.judge.callable())
      : known;
  const candidates =
    context.approvedRunSpecDigest === undefined
      ? replayCandidates(plan, known)
      : await approvedReplayCandidates(
          context,
          plan,
          known,
          context.approvedRunSpecDigest,
        );
  reportShortlistAbstentions(context, plan, candidates);
  assertPricedCandidates(routes.candidates.label, candidates);
  const referenceFamilyByStepId = referenceFamiliesByStep(
    plan,
    candidates,
    known,
  );
  if (context.evaluator === undefined) {
    assertNeutralJudges(
      plan,
      known,
      judgeCatalog,
      candidates,
      referenceFamilyByStepId,
    );
  }
  const judges = new Map<string, ReplayCostJudge>();
  const judge =
    context.evaluator !== undefined
      ? undefined
      : (stepId: string, candidate: ModelCatalogEntry): ReplayCostJudge => {
          const referenceFamily = referenceFamilyByStepId.get(stepId)!;
          const key = JSON.stringify([candidate.family, referenceFamily]);
          const cached = judges.get(key);
          if (cached !== undefined) return cached;
          const modelId = pickJudges(judgeCatalog, {
            candidateFamily: candidate.family,
            referenceFamily,
          })[0]!;
          const selected = { modelId, ...judgeLimits(judgeCatalog, modelId) };
          judges.set(key, selected);
          return selected;
        };
  return {
    ...estimateReplayCost({
      steps: plan.steps,
      cases: plan.cases,
      candidates,
      judge,
    }),
    policy: context.release.effective,
  };
}

export async function claimDetachedReplay(
  options: PipelineOptions,
): Promise<DetachedReplayClaim> {
  const context = createContext(options);
  if (context.baseUrl === undefined) {
    throw missingProviderConfiguration();
  }
  const state = await readSetupState(context.store, context.projectId);
  const traceIdentity = await inputDigest("ingest", context, state);
  if (traceIdentity === undefined) {
    throw new ProtocolError({
      exitCode: 2,
      code: "missing_traces_path",
      message: "A trace input path is required for a fresh detached replay.",
      remedy:
        "Pass --traces <path> or complete ingest before detaching replay.",
    });
  }
  const catalogIdentity = (
    await routeCatalog(() => routeHandle(context, "api").known())
  ).sort((left, right) => compareText(left.id, right.id));
  const targetPhase = options.through ?? "replay";
  if (!isPipelineStage(targetPhase)) {
    throw new Error(`Invalid detached replay target: ${targetPhase}`);
  }
  const runId = `replay-${computeRunSpecDigest({
    version: 1,
    type: "replay",
    targetPhase,
    repository: await contextRepositoryDigest(context),
    traces: traceIdentity,
    reproofRequests: jsonValue(
      await readReproofRequests(context.store, context.projectId),
    ),
    catalog: jsonValue(catalogIdentity),
    provider: {
      baseUrl: context.baseUrl,
      apiKeyEnv: context.apiKeyEnv,
      maxCostUsd: context.maxCostUsd ?? null,
      includeFreeModels: context.includeFreeModels,
      ...(context.requestHeaders === undefined
        ? {}
        : { headers: requestHeaderIdentity(context.requestHeaders) }),
      ...(context.catalogReference === undefined
        ? {}
        : { catalogReference: context.catalogReference }),
    },
    evaluator: await evaluatorRunIdentity(context),
    modeBConfig:
      context.modeBConfig === undefined ? null : jsonValue(context.modeBConfig),
    approvedRunSpecDigest: context.approvedRunSpecDigest ?? null,
  })}`;
  await putImmutableJson(
    context.store,
    detachedReplayCatalogKey(context.projectId, runId),
    { runId, models: catalogIdentity },
  );
  const existing = await readRun(context, runId);
  if (existing !== null) {
    return detachedClaim(existing, true);
  }
  try {
    const created = await createRun(context.store, {
      projectId: context.projectId,
      type: "replay",
      phase: targetPhase,
      runId,
    });
    return detachedClaim(created, false);
  } catch (error) {
    const raced = await readRun(context, runId);
    if (raced === null) throw error;
    return detachedClaim(raced, true);
  }
}

export async function beginDetachedReplayWorker(
  options: Pick<PipelineOptions, "repo" | "store" | "reporter">,
  runId: string,
): Promise<boolean> {
  const context = createContext(options);
  const run = await requireReplayRun(context, runId);
  if (run.status !== "running") return false;
  const key = detachedReplayWorkerKey(context.projectId);
  for (;;) {
    const entry = await context.store.get(key);
    if (entry !== null) {
      const worker = detachedReplayWorkerSchema.parse(
        JSON.parse(Buffer.from(entry.body).toString("utf8")),
      );
      const owner = await readRun(context, worker.runId);
      if (
        owner?.status === "running" &&
        (worker.hostname !== hostname() || processIsAlive(worker.pid))
      ) {
        return false;
      }
    }
    const worker = detachedReplayWorkerSchema.parse({
      runId,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    });
    if (
      await context.store.compareAndSwap(
        key,
        entry?.version ?? 0,
        Buffer.from(canonicalJson(worker), "utf8"),
        (entry?.fenceToken ?? 0) + 1,
      )
    ) {
      return true;
    }
  }
}

export async function readActiveDetachedReplay(options: {
  readonly repo: string;
  readonly store?: string;
}): Promise<RunStatusResult | null> {
  const context = createHeadlessContext(options);
  const entry = await context.store.get(
    detachedReplayWorkerKey(context.projectId),
  );
  if (entry === null) return null;
  const worker = detachedReplayWorkerSchema.parse(
    JSON.parse(Buffer.from(entry.body).toString("utf8")),
  );
  const run = await readRun(context, worker.runId);
  if (
    run === null ||
    run.status !== "running" ||
    (worker.hostname === hostname() && !processIsAlive(worker.pid))
  ) {
    return null;
  }
  return readRunStatus({ ...options, runId: worker.runId });
}

export function requestHeaderIdentity(
  headers: Readonly<Record<string, string>>,
): [string, string][] {
  return Object.entries(headers)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => [name, sha256(value)]);
}

async function evaluatorRunIdentity(
  context: PipelineContext,
): Promise<JsonValue> {
  if (context.evaluator === undefined) return null;
  if (context.evaluator.provider !== "promptfoo") {
    return jsonValue(context.evaluator);
  }
  const assertionsPath = resolve(context.evaluator.assertionsPath);
  const promptfooConfigs = (await readPromptfooConfigs(assertionsPath)).map(
    ({ file, bytes }) => ({ file, sha256: sha256(bytes) }),
  );
  return jsonValue({
    ...context.evaluator,
    assertionsSha256: sha256(await readFile(assertionsPath)),
    ...(promptfooConfigs.length === 0 ? {} : { promptfooConfigs }),
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export async function readRunStatus(options: {
  readonly repo: string;
  readonly store?: string;
  readonly runId: string;
}): Promise<RunStatusResult> {
  const context = createContext({
    repo: options.repo,
    store: options.store,
    reporter: new Reporter("human", {
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  });
  const run = await requireReplayRun(context, options.runId);
  const targetStage = isPipelineStage(run.phase) ? run.phase : null;
  const targetStages = targetStage === null ? [] : stagesThrough(targetStage);
  const completedStages = await readDetachedRunProgress(
    context,
    run.runId,
    targetStages,
  );
  return {
    runId: run.runId,
    type: run.type,
    phase: run.phase,
    status: run.status,
    terminal: run.status !== "running",
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    progress: {
      completedStages,
      targetStage,
      completed: completedStages.length,
      total: targetStage === null ? null : targetStages.length,
    },
  };
}

function detachedClaim(
  run: RunMeta,
  deduplicated: boolean,
): DetachedReplayClaim {
  assertReplayRun(run);
  return {
    runId: run.runId,
    status: run.status,
    terminal: run.status !== "running",
    deduplicated,
  };
}

function detachedRunProgressPrefix(projectId: string, runId: string): string {
  return `${runsPrefix(projectId)}${runId}/progress/`;
}

function detachedReplayCatalogKey(projectId: string, runId: string): string {
  return `${runsPrefix(projectId)}${runId}/catalog.json`;
}

function detachedReplayWorkerKey(projectId: string): string {
  return `${setupPrefix(projectId)}detached-worker.json`;
}

async function readDetachedReplayCatalog(
  context: PipelineContext,
  runId: string,
): Promise<ModelCatalogEntry[]> {
  const value = detachedReplayCatalogSchema.parse(
    await readJson(
      context.store,
      detachedReplayCatalogKey(context.projectId, runId),
    ),
  );
  if (value.runId !== runId) {
    throw new Error(`Detached replay catalog has the wrong runId: ${runId}`);
  }
  return value.models;
}

async function markDetachedRunProgress(
  context: PipelineContext,
  runId: string | undefined,
  stage: PipelineStage,
): Promise<void> {
  if (runId === undefined) return;
  await putImmutableJson(
    context.store,
    `${detachedRunProgressPrefix(context.projectId, runId)}${stage}.json`,
    { runId, stage },
  );
}

async function readDetachedRunProgress(
  context: PipelineContext,
  runId: string,
  targetStages: readonly PipelineStage[],
): Promise<PipelineStage[]> {
  const completed = new Set<PipelineStage>();
  for (const key of await context.store.list(
    detachedRunProgressPrefix(context.projectId, runId),
  )) {
    const entry = await context.store.get(key);
    if (entry === null) {
      throw new Error(
        `Detached run progress disappeared while reading: ${key}`,
      );
    }
    const progress = detachedRunProgressSchema.parse(
      JSON.parse(Buffer.from(entry.body).toString("utf8")),
    );
    if (progress.runId !== runId) {
      throw new Error(`Detached run progress has the wrong runId: ${key}`);
    }
    completed.add(progress.stage);
  }
  return targetStages.filter((stage) => completed.has(stage));
}

async function readRun(
  context: PipelineContext,
  runId: string,
): Promise<RunMeta | null> {
  const entry = await context.store.get(runKey(context.projectId, runId));
  return entry === null
    ? null
    : runMetaSchema.parse(JSON.parse(Buffer.from(entry.body).toString("utf8")));
}

async function requireReplayRun(
  context: PipelineContext,
  runId: string,
): Promise<RunMeta> {
  const run = await readRun(context, runId);
  if (run === null) throw new Error(`Run does not exist: ${runId}`);
  assertReplayRun(run);
  return run;
}

async function requireRunningReplayRun(
  context: PipelineContext,
  runId: string,
): Promise<RunMeta> {
  const run = await requireReplayRun(context, runId);
  if (run.status !== "running") {
    throw new Error(`Run ${runId} is already ${run.status}`);
  }
  return run;
}

function assertReplayRun(run: RunMeta): void {
  if (run.type !== "replay" || !isPipelineStage(run.phase)) {
    throw new Error(`Run ${run.runId} is not a detached replay run`);
  }
}

function isPipelineStage(value: string): value is PipelineStage {
  return PIPELINE_STAGES.some((stage) => stage === value);
}

export async function runApply(
  options: ApplyPipelineOptions,
): Promise<RunApplyResult> {
  const context = createHeadlessContext(options);
  const prepared = await prepareApply(context);
  const codeContext = await codeContextFor(
    context,
    prepared.verdicts.flatMap(({ verdict, swaps }) =>
      swaps.map(({ stepRecord }) => ({
        stepId: stepRecord.stepId,
        family: verdict.familyId,
        path: stepRecord.callSite.path,
        line: stepRecord.callSite.line,
      })),
    ),
    options.warning ?? (() => undefined),
  );
  return applyPreparedSwaps({
    store: context.store,
    repoDir: context.repo,
    githubClient: options.githubClient,
    owner: options.owner,
    repo: options.githubRepo,
    conventions: prepared.conventions,
    verdicts: prepared.verdicts,
    dryRun: options.dryRun,
    ...(codeContext === undefined ? {} : { codeContext }),
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
    warning: options.warning,
  });
}

export async function listWatchablePullRequests(options: {
  readonly repo: string;
  readonly store?: string;
}): Promise<WatchablePullRequest[]> {
  const context = createHeadlessContext(options);
  return watchablePullRequests(
    (await readPipelineLedger(context)).lifecycleEvents,
  );
}

function watchablePullRequests(
  lifecycleEvents: Ledger["lifecycleEvents"],
): WatchablePullRequest[] {
  const events = lifecycleEvents.filter(({ prNumber }) => prNumber !== null);
  const numbers = [
    ...new Set(
      events.flatMap(({ prNumber }) => (prNumber === null ? [] : [prNumber])),
    ),
  ].sort((left, right) => left - right);
  return numbers.flatMap((prNumber) => {
    const matching = events.filter((event) => event.prNumber === prNumber);
    if (matching.some(({ kind }) => kind === "watch_ended")) return [];
    const terminal = matching.some(
      ({ kind }) => kind === "pr_merged" || kind === "pr_closed_rejected",
    );
    return [{ prNumber, phase: terminal ? "terminal" : "open" }];
  });
}

export async function listApprovedSwapSets(options: {
  readonly repo: string;
  readonly store?: string;
}): Promise<ApprovedSwapSet[]> {
  const context = createHeadlessContext(options);
  const ledger = await readPipelineLedger(context);
  const merged = ledger.lifecycleEvents.filter(
    ({ kind, prNumber }) => kind === "pr_merged" && prNumber !== null,
  );
  const result: ApprovedSwapSet[] = [];
  for (const event of merged) {
    if (event.prNumber === null) continue;
    result.push(
      await recoverApprovedSwapSet(context, {
        ...event,
        prNumber: event.prNumber,
      }),
    );
  }
  return result.sort(
    (left, right) =>
      left.prNumber - right.prNumber ||
      compareText(left.runSpecDigest, right.runSpecDigest),
  );
}

async function approvedSwapSetByDigest(
  context: PipelineContext,
  runSpecDigest: string,
): Promise<ApprovedSwapSet> {
  const matches = (
    await listApprovedSwapSets({
      repo: context.repo,
      store: context.storeRoot,
    })
  ).filter((approved) => approved.runSpecDigest === runSpecDigest);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one merged approved swap for run ${runSpecDigest}; found ${matches.length}`,
    );
  }
  return matches[0]!;
}

async function recoverApprovedSwapSet(
  context: PipelineContext,
  event: LifecycleEvent & { readonly prNumber: number },
): Promise<ApprovedSwapSet> {
  const scans = (await readSetupArtifacts(context, "scan")).filter(
    ({ revision }) => revision === event.evidence.revision,
  );
  const [reconciliations, plans, aggregates, confirmations] = await Promise.all(
    [
      readSetupArtifacts(context, "reconcile"),
      readSetupArtifacts(context, "shortlist"),
      readSetupArtifacts(context, "aggregate"),
      readSetupArtifacts(context, "confirm"),
    ],
  );
  const mappings = new Map<string, ApprovedSwap[]>();
  for (const scanOutput of scans) {
    const scanStepIds = new Set(scanOutput.records.map(({ stepId }) => stepId));
    for (const reconciliation of reconciliations.filter(({ records }) =>
      records.every(({ stepId }) => scanStepIds.has(stepId)),
    )) {
      const records = new Map(
        reconciliation.records.map((record) => [record.stepId, record]),
      );
      for (const plan of plans) {
        for (const decision of [...aggregates, ...confirmations]) {
          const selected = decision.families
            .filter(
              (family) =>
                family.verdict.decision === "recommend" &&
                family.gates.every(({ pass }) => pass) &&
                (family.confirmation === undefined ||
                  family.confirmation.status === "not_required" ||
                  family.confirmation.status === "confirmed") &&
                family.selection.status === "selected",
            )
            .sort((left, right) => compareText(left.familyId, right.familyId));
          if (
            canonicalJson(selected.map(({ familyId }) => familyId)) !==
            canonicalJson([...event.familyIds].sort(compareText))
          ) {
            continue;
          }
          const swaps = selected.flatMap((family): ApprovedSwap[] => {
            if (family.selection.status !== "selected") return [];
            const toModel = family.selection.selectedCandidateId;
            if (toModel === undefined) return [];
            return plan.steps
              .filter(({ family: familyId }) => familyId === family.familyId)
              .flatMap((step) => {
                const record = records.get(step.stepId);
                return record === undefined ||
                  step.currentModel === null ||
                  step.currentModel !== record.currentModel
                  ? []
                  : [
                      {
                        familyId: family.familyId,
                        stepId: step.stepId,
                        path: record.callSite.path,
                        fromModel: step.currentModel,
                        toModel,
                      },
                    ];
              });
          });
          if (swaps.length === 0) continue;
          const canonical = canonicalApprovedSwaps(swaps);
          const digestValue = computeRunSpecDigest(
            jsonValue({
              repo: event.repo,
              evidenceRevision: event.evidence.revision,
              swapSet: canonical,
              corpusVersionId: event.evidence.corpusVersionId,
            }),
          );
          if (digestValue === event.runSpecDigest) {
            mappings.set(canonicalJson(jsonValue(canonical)), canonical);
          }
        }
      }
    }
  }
  if (mappings.size !== 1) {
    throw new Error(
      `Approved swap ${event.runSpecDigest} resolved to ${mappings.size} immutable mappings`,
    );
  }
  return {
    runSpecDigest: event.runSpecDigest,
    prNumber: event.prNumber,
    familyIds: [...event.familyIds],
    swaps: [...mappings.values()][0]!,
  };
}

function canonicalApprovedSwaps(
  swaps: readonly ApprovedSwap[],
): ApprovedSwap[] {
  return [...swaps].sort(
    (left, right) =>
      compareText(left.familyId, right.familyId) ||
      compareText(left.path, right.path) ||
      compareText(left.stepId, right.stepId) ||
      compareText(left.fromModel, right.fromModel) ||
      compareText(left.toModel, right.toModel),
  );
}

type SetupArtifactStage = keyof typeof setupArtifactSchemas;
type SetupArtifact<Stage extends SetupArtifactStage> = z.infer<
  (typeof setupArtifactSchemas)[Stage]
>;

async function readSetupArtifacts<Stage extends SetupArtifactStage>(
  context: PipelineContext,
  stage: Stage,
): Promise<SetupArtifact<Stage>[]> {
  const cached = context.cache.setupArtifacts.get(stage) as
    Promise<SetupArtifact<Stage>[]> | undefined;
  if (cached !== undefined) return cached;
  const schema = setupArtifactSchemas[stage] as unknown as z.ZodType<
    SetupArtifact<Stage>
  >;
  const promise = (async () => {
    const prefix = `${setupPrefix(context.projectId)}${stage}-`;
    const values: SetupArtifact<Stage>[] = [];
    for (const key of await context.store.list(prefix)) {
      if (!key.endsWith(".json")) continue;
      values.push(schema.parse(await readJson(context.store, key)));
    }
    return values;
  })();
  context.cache.setupArtifacts.set(stage, promise);
  return promise;
}

export async function runCorpusImport(options: {
  readonly repo: string;
  readonly store?: string;
  readonly config: CorpusImportConfig;
}): Promise<Awaited<ReturnType<typeof importCorpus>>> {
  const context = createHeadlessContext(options);
  const corpus = await importCorpus(options.config, { seed: CORPUS_SEED });
  await writeImportedCorpus(context.store, context.projectId, corpus);
  await putMutableJson(
    context.store,
    importedReferenceCorpusKey(context.projectId),
    jsonValue({
      corpusVersionId: corpus.corpusVersionId,
      cases: corpus.cases.map(({ caseId, content }) => ({
        caseId,
        family: content.family,
        referenceSource: content.referenceSource,
        referenceVerified: content.referenceVerified,
      })),
    }),
  );
  return corpus;
}

export async function runResultExport(options: {
  readonly repo: string;
  readonly store?: string;
  readonly config: ResultSinkConfig;
}): Promise<ResultExportReceipt> {
  const context = createHeadlessContext(options);
  const ledger = await readPipelineLedger(context);
  const executions = ledger.executions;
  if (executions.length === 0) {
    throw stageNotCompleted(
      "replay",
      "No execution trials are available to export",
    );
  }
  const state = await readSetupState(context.store, context.projectId);
  const currentIdentity =
    state.stages.replay === undefined
      ? undefined
      : (await loadReplayOutput(context)).evaluation.evaluatorIdentity;
  const gradeKey = (assessment: Assessment) =>
    `${assessment.executionId}\0${assessment.evaluatorId}\0${assessment.metricName}`;
  const current = new Set(
    ledger.assessments.flatMap((assessment) =>
      currentIdentity !== undefined &&
      assessment.evaluatorIdentity === currentIdentity
        ? [gradeKey(assessment)]
        : [],
    ),
  );
  const assessments = ledger.assessments.filter(
    (assessment) =>
      assessment.evaluatorIdentity === currentIdentity ||
      !current.has(gradeKey(assessment)),
  );
  const verdicts = await readCurrentVerdicts(context.store, context.projectId);
  const exportDigest = digest({
    provider: options.config.provider,
    target:
      options.config.provider === "braintrust"
        ? options.config.projectId
        : options.config.datasetId,
    executionIds: executions
      .map(({ executionId }) => executionId)
      .sort(compareText),
    assessmentIds: assessments
      .map(({ assessmentId }) => assessmentId)
      .sort(compareText),
    verdicts: jsonValue(verdicts),
  });
  const receiptKey = `${context.projectId}/exports/${options.config.provider}-${exportDigest}.json`;
  const existing = await context.store.get(receiptKey);
  if (existing !== null) {
    return resultExportReceiptSchema.parse(
      JSON.parse(Buffer.from(existing.body).toString("utf8")),
    );
  }
  const receipt = await exportResults(options.config, {
    name: `rightmodeler-${exportDigest.slice(0, 24)}`,
    trials: executions.map((execution) => ({
      execution,
      assessments: assessments.filter(
        ({ executionId }) => executionId === execution.executionId,
      ),
    })),
    verdicts: verdicts.map((verdict) => jsonValue(verdict)),
  });
  await putImmutableJson(context.store, receiptKey, receipt);
  return receipt;
}

function createHeadlessContext(options: {
  readonly repo: string;
  readonly store?: string;
  readonly codeGraphPath?: string;
}): PipelineContext {
  return createContext({
    repo: options.repo,
    store: options.store,
    codeGraphPath: options.codeGraphPath,
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
  const [
    scanOutput,
    decisionOutput,
    plan,
    reconciled,
    corpus,
    ledger,
    replay,
    replayedCorpus,
  ] = await Promise.all([
    loadScan(context),
    loadDecisionOutput(context),
    loadReplayPlan(context),
    loadReconcile(context),
    loadCorpusSummary(context),
    readPipelineLedger(context),
    loadReplayOutput(context),
    resolveCheckpointedPipelineCorpus(context),
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
  const receipts = familyReceipts(
    ledger,
    plan,
    replay,
    replayedCorpus,
    families.map(({ verdict }) => verdict),
  );
  const receiptByFamily = new Map(
    receipts.map((receipt) => [receipt.familyId, receipt]),
  );
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
      receipts: receiptByFamily.get(family.familyId) ?? {
        winnerCostPerCaseUsd: null,
        incumbentCostPerCaseUsd: null,
        costDeltaPct: null,
        winnerLatencyP50Ms: null,
      },
    };
  });
  return {
    verdicts,
    conventions: await captureConventions({ repoDir: context.repo }),
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
  const storeRoot = resolveStoreRoot(repo, options.store);
  const modeBConfigPath =
    options.modeBConfigPath === undefined
      ? undefined
      : resolve(options.modeBConfigPath);
  const pricingFilePath =
    options.pricingFilePath === undefined
      ? undefined
      : resolve(options.pricingFilePath);
  const policyFilePath =
    options.policyFilePath === undefined
      ? undefined
      : resolve(options.policyFilePath);
  return {
    repo,
    storeRoot,
    store: new FsStore(storeRoot),
    projectId: PROJECT_ID,
    traces: options.traces === undefined ? undefined : resolve(options.traces),
    baseUrl: options.baseUrl,
    apiKeyEnv: options.apiKeyEnv ?? API_KEY_ENV_DEFAULT,
    maxCostUsd: options.maxCostUsd,
    maxConcurrency: options.maxConcurrency,
    includeFreeModels: options.includeFreeModels ?? false,
    release: releasePolicy(
      policyFilePath === undefined ? undefined : readPolicyFile(policyFilePath),
    ),
    ...(options.evaluator === undefined
      ? {}
      : { evaluator: resolveEvaluatorConfig(options.evaluator) }),
    ...(modeBConfigPath === undefined
      ? {}
      : {
          modeBConfigPath,
          modeBConfig: readModeBConfig(modeBConfigPath),
        }),
    ...(pricingFilePath === undefined
      ? {}
      : {
          pricingFilePath,
          pricingOverrides: readPricingFile(pricingFilePath),
        }),
    ...(options.requestHeaders === undefined
      ? {}
      : { requestHeaders: options.requestHeaders }),
    ...(options.catalogReference === undefined
      ? {}
      : {
          catalogReference: /^https?:\/\//iu.test(options.catalogReference)
            ? options.catalogReference
            : resolve(options.catalogReference),
        }),
    ...(options.baseUrl === undefined
      ? {}
      : { routes: { candidates: "api", judge: "api" } }),
    ...(policyFilePath === undefined ? {} : { policyFilePath }),
    ...(options.matchersPath === undefined
      ? {}
      : {
          matchersPath: resolve(options.matchersPath),
          matchers: loadMatchers(resolve(options.matchersPath)),
        }),
    ...(options.existingRunId === undefined
      ? {}
      : { existingRunId: options.existingRunId }),
    ...(options.approvedRunSpecDigest === undefined
      ? {}
      : { approvedRunSpecDigest: options.approvedRunSpecDigest }),
    ...(options.codeGraphPath === undefined
      ? {}
      : { codeGraphPath: resolve(options.codeGraphPath) }),
    reporter: options.reporter,
    cache: { setupArtifacts: new Map() },
  };
}

function readModeBConfig(path: string): ModeBConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw invalidModeBConfig(
      `Invalid --modeb-config file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = modeBConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field =
      issue.path.length === 0 ? "modebConfig" : issue.path.join(".");
    throw invalidModeBConfig(
      `Invalid --modeb-config field ${field}: ${issue.message}`,
    );
  }
  if (
    !parsed.data.appSpec.command.some((part) => part.includes("{caseFile}"))
  ) {
    throw invalidModeBConfig(
      "Invalid --modeb-config field appSpec.command: one argument must contain {caseFile}",
    );
  }
  if (Object.keys(parsed.data.stepMap).length === 0) {
    throw invalidModeBConfig(
      "Invalid --modeb-config field stepMap: at least one canonical step is required",
    );
  }
  if (
    new Set(Object.values(parsed.data.stepMap)).size !==
    Object.keys(parsed.data.stepMap).length
  ) {
    throw invalidModeBConfig(
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

function readPricingFile(path: string): z.infer<typeof pricingFileSchema> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw invalidPricingFile(
      `Invalid --pricing-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = pricingFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path.length === 0 ? "pricing" : issue.path.join(".");
    throw invalidPricingFile(
      `Invalid --pricing-file field ${field}: ${issue.message}`,
    );
  }
  return parsed.data;
}

function readPolicyFile(path: string): z.infer<typeof releasePolicyFileSchema> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw invalidPolicyFile(
      `Invalid --policy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = releasePolicyFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path.length === 0 ? "policy" : issue.path.join(".");
    throw invalidPolicyFile(
      `Invalid --policy field ${field}: ${issue.message}`,
    );
  }
  return parsed.data;
}

export interface EffectiveReleasePolicy {
  readonly qualityFloor: number;
  readonly shortlistTop: number;
  readonly allowModels: readonly string[];
  readonly denyModels: readonly string[];
}

export interface ReleasePolicyResolution {
  readonly effective: EffectiveReleasePolicy;
  readonly gate: ReleaseGatePolicy;
  readonly minimumHoldoutCases: number;
}

export function releasePolicy(
  file: z.infer<typeof releasePolicyFileSchema> | undefined,
): ReleasePolicyResolution {
  const effective: EffectiveReleasePolicy = {
    qualityFloor: file?.qualityFloor ?? DEFAULT_QUALITY_FLOOR,
    shortlistTop: file?.shortlistTop ?? DEFAULT_SHORTLIST_TOP,
    allowModels: [...new Set(file?.allowModels ?? [])].sort(compareText),
    denyModels: [...new Set(file?.denyModels ?? [])].sort(compareText),
  };
  const digest = computeRunSpecDigest(
    jsonValue({ base: GATE_POLICY_BASE_VERSION, policy: effective }),
  );
  return {
    effective,
    gate: new ReleaseGatePolicy({
      gatePolicyVersion: `${GATE_POLICY_BASE_VERSION}-${digest.slice(0, 12)}`,
      qualityFloor: effective.qualityFloor,
      availabilityFloor: AVAILABILITY_FLOOR,
    }),
    minimumHoldoutCases: minimumTrialsForFloor(effective.qualityFloor, 1),
  };
}

export function evidenceQuestionIdentity(input: {
  readonly corpusVersionId: string;
  readonly gatePolicyVersion: string;
  readonly evaluatorPlan: JsonValue;
  readonly family: string;
  readonly stepIds: readonly string[];
  readonly reproofRequestIds: readonly string[];
}): string {
  return computeEvidenceQuestionId({
    corpusVersionId: input.corpusVersionId,
    promptRevision: REPLAY_PROMPT_REVISION,
    gatePolicyVersion: input.gatePolicyVersion,
    stepFingerprint: computeRunSpecDigest(
      jsonValue({
        family: input.family,
        stepIds: [...input.stepIds],
        ...(input.reproofRequestIds.length === 0
          ? {}
          : { reproofRequestIds: [...input.reproofRequestIds] }),
      }),
    ),
    evaluatorPlan: input.evaluatorPlan,
    replayMode: "single_shot",
  });
}

function loadMatchers(path: string): readonly DeclarativeMatcher[] {
  let compilation;
  try {
    compilation = loadDeclarativeMatchers(path);
  } catch (error) {
    throw invalidMatchersFile(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (compilation.rejections.length > 0) {
    throw invalidMatchersFile(
      compilation.rejections
        .map(({ slug, code, message }) => `${slug}: ${code}: ${message}`)
        .join("; "),
    );
  }
  return compilation.matchers;
}

function evaluatorPlan(context: PipelineContext): JsonValue {
  return context.evaluator === undefined
    ? { evaluatorKind: "judge", gateMetric: "replacement-quality" }
    : {
        evaluatorKind: context.evaluator.provider,
        scorers: [...context.evaluator.scorers],
        gateMetric: context.evaluator.gateMetric,
        gateThreshold: context.evaluator.gateThreshold ?? null,
      };
}

function stagesThrough(through?: PipelineStage): PipelineStage[] {
  if (through === undefined) return [...PIPELINE_STAGES];
  return PIPELINE_STAGES.slice(0, PIPELINE_STAGES.indexOf(through) + 1);
}

async function scanArtifactDigest(
  context: PipelineContext,
  state: SetupState,
): Promise<string> {
  const checkpoint = state.stages.scan;
  if (checkpoint === undefined) return "missing";
  const entry = await context.store.get(checkpoint.outputKey);
  return entry === null ? "missing" : sha256(entry.body);
}

async function inputDigest(
  stage: PipelineStage,
  context: PipelineContext,
  state: SetupState,
): Promise<string | undefined> {
  if (stage === "scan") {
    return digest({
      stage,
      repository: await contextRepositoryDigest(context),
      scanner: SCAN_REVISION,
      ...(context.matchersPath === undefined
        ? {}
        : { matchers: sha256(await readFile(context.matchersPath)) }),
    });
  }
  if (stage === "ingest") {
    if (context.traces === undefined) return state.stages.ingest?.inputDigest;
    return digest({
      stage,
      traceSha256: sha256(
        Buffer.concat([...(await readTraceInput(context.traces))]),
      ),
      reader: TRACE_READER_REVISION,
    });
  }

  const previous = PIPELINE_STAGES[PIPELINE_STAGES.indexOf(stage) - 1]!;
  const upstream = state.stages[previous];
  if (upstream === undefined) return undefined;
  const extra: Record<string, JsonValue> = {};
  if (stage === "reconcile") {
    extra.scan = await scanArtifactDigest(context, state);
    extra.binding = TRACE_BINDING_REVISION;
    if (context.modeBConfig !== undefined) {
      extra.stepMap = context.modeBConfig.stepMap;
    }
  }
  if (stage === "corpus") {
    extra.seed = CORPUS_SEED;
    const active = await context.store.get(ACTIVE_CORPUS_KEY);
    extra.activeCorpus =
      active === null
        ? null
        : createHash("sha256").update(active.body).digest("hex");
  }
  if (stage === "audit-sample") extra.limit = AUDIT_SAMPLE_LIMIT;
  if (stage === "shortlist") {
    extra.policy = jsonValue({ ...context.release.effective });
    extra.includeFreeModels = context.includeFreeModels;
    extra.stepsPerFamily = MIN_DISTINCT_STEPS;
    extra.minimumHoldoutCases = context.release.minimumHoldoutCases;
  }
  if (stage === "shortlist") {
    extra.approvedRunSpecDigest = context.approvedRunSpecDigest ?? null;
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
      ...(context.requestHeaders === undefined
        ? {}
        : { headers: requestHeaderIdentity(context.requestHeaders) }),
      ...(context.catalogReference === undefined
        ? {}
        : { catalogReference: context.catalogReference }),
    });
    if (context.evaluator !== undefined) {
      extra.evaluatorIdentity = digest(await evaluatorRunIdentity(context));
    }
    extra.approvedRunSpecDigest = context.approvedRunSpecDigest ?? null;
    if (context.existingRunId !== undefined) {
      extra.catalog = digest(
        jsonValue(
          await readDetachedReplayCatalog(context, context.existingRunId),
        ),
      );
    }
  }
  if (stage === "aggregate") {
    extra.gatePolicyVersion = context.release.gate.gatePolicyVersion;
    extra.qualityFloor = context.release.gate.qualityFloor;
    extra.availabilityFloor = context.release.gate.availabilityFloor;
    extra.referenceCeilings = jsonValue(
      await loadReferenceCeilings(context, await loadReplayPlan(context)),
    );
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
  if (stage === "report" && context.codeGraphPath !== undefined) {
    extra.codeGraph = await graphFileDigest(context.codeGraphPath);
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
    throw missingTracesPath();
  }
  if (stage === "replay") {
    throw missingProviderConfiguration();
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

function missingProviderConfiguration(): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "missing_provider_configuration",
    message: "Provider configuration is required when replay is reached.",
    remedy:
      "Pass --base-url <url> and, if needed, --api-key-env <environment-variable-name>.",
  });
}

function missingTracesPath(): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "missing_traces_path",
    message: "A trace input path is required when ingest is reached.",
    remedy: `Pass --traces <path> with a trace file in one of the supported formats: ${traceAdapters.map(({ name }) => name).join(", ")}.`,
  });
}

function missingTraceInput(path: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "missing_traces_path",
    message: `Trace input does not exist: ${path}`,
    remedy:
      "Pass --traces <path> pointing to an existing trace file or directory.",
  });
}

function emptyTracesDirectory(path: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "empty_traces_directory",
    message: `Trace input directory has no .json or .jsonl files: ${path}`,
    remedy:
      "Point --traces at a directory containing trace files, or at a single trace file.",
  });
}

function mixedTraceFormats(names: string[]): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "mixed_trace_formats",
    message: `Trace input directory mixes formats: ${names.sort().join(", ")}`,
    remedy:
      "Split the directory so every file is the same trace format, or pass one file with --traces.",
  });
}

function noReplayableCallSites(): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "no_replayable_call_sites",
    message: "No replayable text call sites were found",
    remedy:
      "Every matched call site needs tools or structured output. Point --repo at a service with plain text completions, or add a matcher for a text call site, then rerun.",
  });
}

function invalidModeBConfig(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "invalid_modeb_config",
    message,
    remedy: "Fix the named field in the --modeb-config file and rerun.",
  });
}

function modeBCloudUnavailable(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "modeb_cloud_unavailable",
    message,
    remedy:
      'Install the optional @vercel/sandbox package and set the sandbox credentials, or set "backend": "docker" in the --modeb-config file, then rerun.',
  });
}

function invalidPricingFile(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "invalid_pricing_file",
    message,
    remedy:
      'Use a JSON object mapping each model id to { "input": <non-negative USD per token>, "output": <non-negative USD per token>, "maxOutputTokens": <optional positive integer> }.',
  });
}

function invalidCatalogReference(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "invalid_catalog_reference",
    message,
    remedy:
      "Pass --catalog-reference an http(s) URL or a readable file that returns an OpenAI-compatible /models document, or remove it, then rerun.",
  });
}

async function routeCatalog(
  load: () => Promise<ModelCatalogEntry[]>,
): Promise<ModelCatalogEntry[]> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof CatalogReferenceError) {
      throw invalidCatalogReference(error.message);
    }
    throw error;
  }
}

function routeHandle(context: PipelineContext, kind: RouteKind): RouteHandle {
  switch (kind) {
    case "api":
      if (context.baseUrl === undefined) throw missingProviderConfiguration();
      return apiRoute({
        baseUrl: context.baseUrl,
        apiKeyEnv: context.apiKeyEnv,
        maxConcurrency: context.maxConcurrency,
        warning: (code, message) => context.reporter.warning(code, message),
        pricingOverrides: context.pricingOverrides,
        headers: context.requestHeaders,
        catalogReference: context.catalogReference,
      });
  }
}

function replayRoutes(context: PipelineContext): {
  readonly candidates: RouteHandle;
  readonly judge: RouteHandle;
} {
  if (context.routes === undefined) throw missingProviderConfiguration();
  const candidates = routeHandle(context, context.routes.candidates);
  return {
    candidates,
    judge:
      context.routes.judge === context.routes.candidates
        ? candidates
        : routeHandle(context, context.routes.judge),
  };
}

function invalidPolicyFile(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "invalid_policy_file",
    message,
    remedy:
      "Use a JSON object with optional qualityFloor (greater than 0.8, less than 1), shortlistTop (positive integer), allowModels and denyModels (arrays of model ids).",
  });
}

function invalidMatchersFile(message: string): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "invalid_matchers_file",
    message: `Invalid --matchers file: ${message}`,
    remedy:
      "Fix the listed matcher definitions and rerun; each needs slug, description, noiseTier, filePatterns, patterns, examples, and closesSurfaceIds.",
  });
}

function stageNotCompleted(
  stage: PipelineStage,
  message = `${stage} has not completed`,
): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "stage_not_completed",
    message,
    remedy: `Run rightmodeler init --through ${stage} first, then rerun this command.`,
  });
}

async function readTraceInput(path: string): Promise<readonly Buffer[]> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw missingTraceInput(path);
  }
  if (!metadata.isDirectory()) return [await readFile(path)];
  const names = (await readdir(path, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")),
    )
    .map(({ name }) => name)
    .sort();
  if (names.length === 0) throw emptyTracesDirectory(path);
  return Promise.all(names.map((name) => readFile(join(path, name))));
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
      return executeAggregate(context, inputDigestValue, runId);
    case "confirm":
      return executeConfirm(context, inputDigestValue, runId);
    case "report": {
      const ledger = await readPipelineLedger(context);
      return executeReport(context, inputDigestValue, ledger);
    }
  }
}

async function executeScan(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const revision = await repositoryRevision(context.repo);
  const records = scan(
    context.repo,
    createMatcherRegistry(context.matchers ?? []),
    context.projectId,
  );
  const coverage = evaluateCoverage({
    stepRecords: records,
    fileUniverse: (await contextRepositoryFiles(context)).map(
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
      remedy:
        "Add matcher coverage for the listed AI dependency surfaces, or pass --matchers <file> with declarative matchers that close them.",
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
    throw missingTracesPath();
  }
  const texts = (await readTraceInput(tracePath)).map((body) =>
    body.toString("utf8"),
  );
  const detected = texts.map((text) => detectFormat(text, traceAdapters));
  const names = [...new Set(detected.map(({ name }) => name))];
  if (names.length > 1) throw mixedTraceFormats(names);
  const adapter = detected[0]!;
  const result = adapter.adaptWithReport(
    texts.flatMap((text) => parseTraceRecords(text)),
  );
  const runs = strictRuns(adapter.name, result);
  const excluded = excludedStepsWarning(result);
  if (excluded !== undefined) {
    context.reporter.warning("trace_steps_excluded", excluded);
  }
  if (runs.length === 0) {
    throw new TraceAdaptError(
      adapter.name,
      `The ${adapter.name} trace input contains no model calls that can be read`,
    );
  }
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
          throw invalidModeBConfig(
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
        .flatMap(({ traceId, steps }) =>
          steps.map((step) => ({ ...step, traceId })),
        )
    : ingestOutput.runs.flatMap(({ traceId, steps }) =>
        steps.map((step) => ({ ...step, traceId })),
      );
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
    traceStepBindings: result.traceSteps.map(
      ({ normalizedStep, status, stepId, candidateStepIds, via }) => ({
        traceId: normalizedStep.traceId,
        stepIndex: normalizedStep.stepIndex,
        stepIds:
          status === "matched"
            ? [stepId!]
            : status === "ambiguous"
              ? [...candidateStepIds!]
              : [],
        ...(via === undefined ? {} : { via }),
      }),
    ),
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

export interface PipelineCorpusContext {
  readonly repo: string;
  readonly store: Store;
  readonly storeRoot: string;
  readonly projectId: string;
}

export async function resolvePipelineCorpus(
  context: PipelineCorpusContext,
  runs: readonly z.infer<typeof normalizedRunSchema>[],
): Promise<Corpus> {
  if ((await context.store.get(ACTIVE_CORPUS_KEY)) === null) {
    return buildCorpus(runs, { seed: CORPUS_SEED });
  }
  return (
    await readActiveCorpus({ repo: context.repo, store: context.storeRoot })
  ).corpus;
}

export async function resolveCheckpointedPipelineCorpus(
  context: PipelineCorpusContext,
): Promise<Corpus> {
  const { corpusVersionId } = await loadCurrent(
    context,
    "corpus",
    corpusOutputSchema,
  );
  return readCorpusVersion(
    { repo: context.repo, store: context.storeRoot },
    corpusVersionId,
  );
}

async function executeCorpus(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const corpus = await resolvePipelineCorpus(
    context,
    (await loadScrub(context)).runs,
  );
  await writeCorpus(context.store, context.projectId, corpus);
  const key = artifactKey(context, "corpus", inputDigestValue);
  await putImmutableJson(context.store, key, corpusOutput(corpus));
  return key;
}

async function executeAuditSample(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const corpus = await resolveCheckpointedPipelineCorpus(context);
  const size = Math.min(AUDIT_SAMPLE_LIMIT, corpus.cases.length);
  const worksheet = auditCorpusSample(corpus, {
    size,
    seed: CORPUS_SEED,
  });
  const key = artifactKey(context, "audit-sample", inputDigestValue);
  await putImmutableJson(context.store, key, worksheet);
  return key;
}

async function planFamilies(
  context: PipelineContext,
  corpus: Corpus,
  reconciled: z.infer<typeof reconcileOutputSchema>,
  approved: ApprovedSwapSet | undefined,
): Promise<
  Array<{
    plan: FamilyPlan;
    caseSteps: ReadonlyMap<string, string>;
    leftOut: FamilyBinding["leftOut"];
    unsendable: readonly string[];
  }>
> {
  const { records } = reconciled;
  const replayable = (record: StepRecord): boolean =>
    !record.capabilityRequirements.includes("tools") &&
    !record.capabilityRequirements.includes("structured_output");
  const replayableSteps = records.filter(replayable);
  if (replayableSteps.length === 0) {
    throw noReplayableCallSites();
  }
  const sites = records.map((record) => ({
    stepId: record.stepId,
    ...(record.traceKey === undefined ? {} : { traceKey: record.traceKey }),
    replayable: replayable(record),
  }));
  const bindings = new Map(
    reconciled.traceStepBindings.map(
      ({ traceId, stepIndex, stepIds }) =>
        [traceStepKey(traceId, stepIndex), stepIds] as const,
    ),
  );

  const families = [
    ...new Set(corpus.cases.map(({ content }) => content.family)),
  ]
    .filter(
      (family) => approved === undefined || approved.familyIds.includes(family),
    )
    .sort(
      (left, right) =>
        corpus.cases.filter(({ content }) => content.family === right).length -
          corpus.cases.filter(({ content }) => content.family === left)
            .length || compareText(left, right),
    );
  if (approved !== undefined && families.length !== approved.familyIds.length) {
    throw new Error(
      `Approved swap ${approved.runSpecDigest} has no fresh corpus cases for every family`,
    );
  }
  const reproofRequests = new Map(
    (await readReproofRequests(context.store, context.projectId)).map(
      ({ familyId, requestIds }) => [familyId, requestIds] as const,
    ),
  );
  const keyedStepIds = new Set(
    records.flatMap(({ stepId, traceKey }) =>
      traceKey === undefined ? [] : [stepId],
    ),
  );
  const keyedFamilies = new Set(
    records.flatMap(({ traceKey }) =>
      traceKey === undefined ? [] : [traceKey],
    ),
  );
  const familiesByStep = new Map<string, Set<string>>();
  for (const { content, observation } of corpus.cases) {
    const bound =
      observation?.traceId === undefined
        ? undefined
        : bindings.get(traceStepKey(observation.traceId, content.stepIndex));
    if (
      keyedFamilies.has(content.family) ||
      bound?.length !== 1 ||
      keyedStepIds.has(bound[0]!)
    ) {
      continue;
    }
    familiesByStep.set(
      bound[0]!,
      (familiesByStep.get(bound[0]!) ?? new Set<string>()).add(content.family),
    );
  }
  const sharedStepIds = new Set(
    [...familiesByStep]
      .filter(([, reached]) => reached.size > 1)
      .map(([stepId]) => stepId),
  );
  return families.map((family) => {
    const familyCases = corpus.cases.filter(
      ({ content }) => content.family === family,
    );
    const reasons = familyCases.map(unsendableReason);
    const sendableCases = familyCases.filter(
      (_, index) => reasons[index] === undefined,
    );
    const unsendable = reasons.filter((reason) => reason !== undefined);
    const binding =
      approved === undefined
        ? bindFamily({
            family,
            cases: sendableCases.map((corpusCase) => ({
              caseId: corpusCase.caseId,
              split: corpusCase.split,
              traceId: corpusCase.observation?.traceId,
              stepIndex: corpusCase.content.stepIndex,
            })),
            sites,
            sharedStepIds,
            bindings,
          })
        : undefined;
    const placement =
      binding ??
      approvedPlacement(approved!, family, sendableCases, replayableSteps);
    const { leftOut } = placement;
    const bindingLeftOut =
      leftOut.ambiguous + leftOut.unmatched + leftOut.unreplayable;
    const abstainReason: FamilyPlan["abstainReason"] =
      binding === undefined
        ? undefined
        : binding.caseSteps.size === 0 && bindingLeftOut > 0
          ? {
              reason:
                leftOut.ambiguous > 0
                  ? "ambiguous_call_site_binding"
                  : leftOut.unreplayable > 0
                    ? "bound_call_sites_not_replayable"
                    : "unmatched_call_site_binding",
              observed: 0,
              required: familyCases.length,
            }
          : binding.holdoutCases < context.release.minimumHoldoutCases
            ? {
                reason: "holdout_below_floor_minimum",
                observed: binding.holdoutCases,
                required: context.release.minimumHoldoutCases,
              }
            : binding.stepIds.length < binding.requiredDistinctSteps
              ? {
                  reason: "insufficient_distinct_steps",
                  observed: binding.stepIds.length,
                  required: binding.requiredDistinctSteps,
                }
              : undefined;
    const stepIds = abstainReason === undefined ? [...placement.stepIds] : [];
    const leftOutCases = bindingLeftOut + unsendable.length;
    const reproofRequestIds = reproofRequests.get(family) ?? [];
    const evidenceQuestionId = evidenceQuestionIdentity({
      corpusVersionId: corpus.corpusVersionId,
      gatePolicyVersion: context.release.gate.gatePolicyVersion,
      evaluatorPlan: evaluatorPlan(context),
      family,
      stepIds,
      reproofRequestIds,
    });
    return {
      plan: {
        familyId: family,
        evidenceQuestionId,
        cases: familyCases.length,
        holdoutCases: placement.holdoutCases,
        minimumHoldoutCases: context.release.minimumHoldoutCases,
        stepIds,
        ...(abstainReason === undefined ? {} : { abstainReason }),
        ...(binding !== undefined
          ? { binding: binding.kind }
          : keyedFamilies.has(family)
            ? { binding: "trace_key" as const }
            : {}),
        ...(leftOutCases > 0 ? { leftOutCases } : {}),
      },
      caseSteps: placement.caseSteps,
      leftOut,
      unsendable,
    };
  });
}

function unsendableReason(
  corpusCase: Corpus["cases"][number],
): string | undefined {
  try {
    toWireMessages(
      corpusCase.content.messages,
      corpusCase.content.systemPrompt,
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function executeShortlist(
  context: PipelineContext,
  inputDigestValue: string,
): Promise<string> {
  const reconciled = await loadReconcile(context);
  const { records } = reconciled;
  const runs = (await loadScrub(context)).runs;
  const corpus = await resolveCheckpointedPipelineCorpus(context);
  const approved =
    context.approvedRunSpecDigest === undefined
      ? undefined
      : await approvedSwapSetByDigest(context, context.approvedRunSpecDigest);
  const planned = await planFamilies(context, corpus, reconciled, approved);
  const familyPlans = planned.map(({ plan }) => plan);
  const recordById = new Map(records.map((record) => [record.stepId, record]));
  const usageByCase = replayUsageByCase(runs);
  const steps: Array<Omit<ReplayStep, "corpusSplit"> & { family: string }> = [];
  const cases: Array<RecordedCase & { family: string }> = [];
  const sampleSizes: Record<string, number> = {};
  for (const { plan: familyPlan, caseSteps, leftOut, unsendable } of planned) {
    const { familyId: family, evidenceQuestionId, stepIds } = familyPlan;
    sampleSizes[family] = familyPlan.cases;
    const bindingLeftOut =
      leftOut.ambiguous + leftOut.unmatched + leftOut.unreplayable;
    if (bindingLeftOut > 0 && caseSteps.size > 0) {
      const causes = [
        [
          leftOut.ambiguous,
          "could not be tied to a call site of this family alone",
        ],
        [leftOut.unmatched, "matched no scanned call site"],
        [
          leftOut.unreplayable,
          "came from a call site that needs tools or structured output",
        ],
      ] as const;
      context.reporter.warning(
        "family_cases_left_out",
        `Family ${family}: ${bindingLeftOut} of ${familyPlan.cases} traced cases were left out of the replay sample: ${causes
          .filter(([count]) => count > 0)
          .map(([count, cause]) => `${count} ${cause}`)
          .join(", ")}.`,
      );
    }
    if (unsendable.length > 0) {
      context.reporter.warning(
        "recorded_messages_not_replayable",
        `Family ${family}: ${unsendable.length} of ${familyPlan.cases} recorded cases carry messages the replay cannot send yet and were left out of the replay sample (first: ${unsendable[0]}). Tool calls, non-text parts and tool definitions in a recorded conversation are not replayed.`,
      );
    }
    if (stepIds.length === 0) continue;
    const assignedRecords = stepIds.map((stepId) => recordById.get(stepId)!);
    const familyCases = corpus.cases.filter(
      ({ content }) => content.family === family,
    );
    const observedContextTokens = new Map<string, number>(
      stepIds.map((stepId) => [stepId, 0] as const),
    );
    const recordedMaxOutputTokens = new Map<string, number>();
    for (const split of ["shortlist", "holdout"] as const) {
      familyCases
        .filter((corpusCase) => corpusCase.split === split)
        .forEach((corpusCase) => {
          const stepId = caseSteps.get(corpusCase.caseId);
          if (stepId === undefined) return;
          const step = recordById.get(stepId)!;
          const contextTokens = requireReplayUsage(
            usageByCase,
            corpusCase,
          ).inputTokens;
          observedContextTokens.set(
            step.stepId,
            Math.max(
              observedContextTokens.get(step.stepId) ?? 0,
              contextTokens,
            ),
          );
          const replayCase: RecordedCase & { family: string } = {
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
            contextTokens,
            maxOutputTokens: 256,
            referenceOutput: corpusCase.content.output,
          };
          recordedMaxOutputTokens.set(
            step.stepId,
            Math.max(
              recordedMaxOutputTokens.get(step.stepId) ?? 0,
              replayCase.maxOutputTokens,
              corpusCase.observation?.usage?.outputTokens ?? 0,
            ),
          );
          cases.push(replayCase);
        });
    }
    for (const stepId of stepIds) {
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
        observedContextTokens: observedContextTokens.get(stepId) ?? 0,
        ...(recordedMaxOutputTokens.get(stepId)
          ? {
              recordedMaxOutputTokens: recordedMaxOutputTokens.get(stepId)!,
            }
          : {}),
      });
    }
  }

  const key = artifactKey(context, "shortlist", inputDigestValue);
  await putImmutableJson(context.store, key, {
    top: context.release.effective.shortlistTop,
    includeFreeModels: context.includeFreeModels,
    allowModels: [...context.release.effective.allowModels],
    denyModels: [...context.release.effective.denyModels],
    sampleSizes,
    familyPlans,
    steps,
    cases,
  });
  return key;
}

function replayUsageByCase(
  runs: readonly z.infer<typeof normalizedRunSchema>[],
): ReadonlyMap<string, { readonly inputTokens: number }> {
  const usage = new Map<string, { inputTokens: number }>();
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.usage === undefined) continue;
      const key = `${step.trajectoryId}\0${step.stepIndex}`;
      const existing = usage.get(key);
      if (
        existing === undefined ||
        step.usage.inputTokens > existing.inputTokens
      ) {
        usage.set(key, { inputTokens: step.usage.inputTokens });
      }
    }
  }
  return usage;
}

function requireReplayUsage(
  usage: ReadonlyMap<string, { readonly inputTokens: number }>,
  corpusCase: Corpus["cases"][number],
): { readonly inputTokens: number } {
  if (corpusCase.observation?.usage !== undefined) {
    return { inputTokens: corpusCase.observation.usage.inputTokens };
  }
  const value = usage.get(
    `${corpusCase.content.trajectoryId}\0${corpusCase.content.stepIndex}`,
  );
  if (value === undefined) {
    throw new ProtocolError({
      exitCode: 2,
      code: "active_corpus_usage_unavailable",
      message: `Active corpus case has no recorded token usage: ${corpusCase.caseId}`,
      remedy:
        "Publish a corpus version built from traces that include token usage.",
    });
  }
  return value;
}

function approvedPlacement(
  approved: ApprovedSwapSet,
  family: string,
  familyCases: Corpus["cases"],
  records: readonly StepRecord[],
): Omit<FamilyBinding, "kind" | "requiredDistinctSteps"> {
  const stepIds = approvedRecords(approved, family, records).map(
    ({ stepId }) => stepId,
  );
  if (stepIds.length === 0) {
    throw new Error(
      `No distinct replayable call site remains for family ${family}`,
    );
  }
  const caseSteps = new Map<string, string>();
  for (const split of ["shortlist", "holdout"] as const) {
    familyCases
      .filter((corpusCase) => corpusCase.split === split)
      .forEach(({ caseId }, index) => {
        caseSteps.set(caseId, stepIds[index % stepIds.length]!);
      });
  }
  return {
    stepIds,
    caseSteps,
    holdoutCases: familyCases.filter(({ split }) => split === "holdout").length,
    leftOut: { ambiguous: 0, unmatched: 0, unreplayable: 0 },
  };
}

function approvedRecords(
  approved: ApprovedSwapSet,
  family: string,
  records: readonly StepRecord[],
): StepRecord[] {
  const selected: StepRecord[] = [];
  for (const swap of approved.swaps.filter(
    ({ familyId }) => familyId === family,
  )) {
    const matchingStepId = records.filter(
      (record) =>
        record.stepId === swap.stepId && record.currentModel === swap.toModel,
    );
    const matching =
      matchingStepId.length > 0
        ? matchingStepId
        : records.filter(
            (record) =>
              record.callSite.path === swap.path &&
              record.currentModel === swap.toModel,
          );
    if (matching.length !== 1) {
      throw new Error(
        `Approved swap ${approved.runSpecDigest} does not resolve to one installed call site: ${swap.path}; expected ${swap.toModel}, observed ${JSON.stringify(
          records
            .filter(({ callSite }) => callSite.path === swap.path)
            .map(({ stepId, currentModel }) => ({ stepId, currentModel })),
        )}`,
      );
    }
    if (!selected.some(({ stepId }) => stepId === matching[0]!.stepId)) {
      selected.push(matching[0]!);
    }
  }
  return selected.sort((left, right) => compareText(left.stepId, right.stepId));
}

function replayCandidates(
  plan: z.infer<typeof replayPlanSchema>,
  catalog: readonly ModelCatalogEntry[],
): StepShortlist[] {
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const shortlisted = shortlist(
    plan.steps.map((step) => ({
      ...step,
      corpusSplit: "shortlist" as const,
      selectionStage: "shortlist",
    })),
    catalog.map((model) =>
      model.contextLength === 0
        ? { ...model, contextLength: Number.MAX_SAFE_INTEGER }
        : model,
    ),
    {
      top: plan.top,
      includeFreeModels: plan.includeFreeModels,
      ...(plan.allowModels.length === 0 ? {} : { allow: plan.allowModels }),
      deny: plan.denyModels,
    },
  ).map((assignment) => ({
    ...assignment,
    candidates: assignment.candidates.map(({ id }) => catalogById.get(id)!),
  }));
  return shortlisted.map((assignment) => {
    const family = plan.steps.find(
      ({ stepId }) => stepId === assignment.stepId,
    )?.family;
    if (family === undefined) return assignment;
    const familyStepIds = new Set(
      plan.steps
        .filter((step) => step.family === family)
        .map(({ stepId }) => stepId),
    );
    const familyAssignments = shortlisted.filter(
      ({ stepId, abstention }) =>
        familyStepIds.has(stepId) && abstention === undefined,
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
}

function reportShortlistAbstentions(
  context: PipelineContext,
  plan: z.infer<typeof replayPlanSchema>,
  candidates: readonly StepShortlist[],
): void {
  const warned = new Set<string>();
  for (const assignment of candidates) {
    const step = plan.steps.find(({ stepId }) => stepId === assignment.stepId)!;
    const warning =
      assignment.abstention === undefined
        ? assignment.resolvedCurrentModelId === undefined
          ? undefined
          : {
              code: "shortlist_current_model_resolved",
              message: `Family ${step.family}: recorded model ${step.currentModel} resolved to catalog model ${assignment.resolvedCurrentModelId}`,
            }
        : {
            code:
              assignment.abstention.kind === "current-model-absent"
                ? "shortlist_current_model_absent"
                : assignment.abstention.kind === "current-model-ambiguous"
                  ? "shortlist_current_model_ambiguous"
                  : "no_priced_candidates",
            message: `Family ${step.family}: ${assignment.abstention.message}`,
          };
    if (warning === undefined) continue;
    const warningKey = JSON.stringify([step.family, step.currentModel]);
    if (warned.has(warningKey)) continue;
    warned.add(warningKey);
    context.reporter.warning(warning.code, warning.message);
  }
}

function assertPricedCandidates(
  baseUrl: string,
  candidates: readonly StepShortlist[],
): void {
  if (
    candidates.length > 0 &&
    candidates.every(
      ({ abstention }) => abstention?.kind === "no-priced-candidates",
    )
  ) {
    throw new ProtocolError({
      exitCode: 2,
      code: "no_priced_candidates",
      message: `The model catalog at ${baseUrl} publishes no per-token pricing, so no candidate can be priced.`,
      remedy:
        "Point --base-url at a catalog that publishes pricing, pass --catalog-reference <url> naming the upstream's public model list, or pass --pricing-file <path> mapping each model id to its input and output USD per token.",
    });
  }
}

const noNeutralJudgeRemedy =
  "List or price a model from a third vendor (a multi-vendor gateway, --catalog-reference or --pricing-file), or grade with your own evaluator (--evaluator).";

function assertNeutralJudges(
  plan: z.infer<typeof replayPlanSchema>,
  known: readonly ModelCatalogEntry[],
  judgeCatalog: readonly ModelCatalogEntry[],
  candidates: readonly StepShortlist[],
  referenceFamilyByStepId: ReadonlyMap<string, string>,
): void {
  const vendorless = new Set<string>();
  const pairs = new Map<
    string,
    { readonly candidateFamily: string; readonly referenceFamily: string }
  >();
  for (const { stepId, candidates: stepCandidates } of candidates) {
    if (stepCandidates.length === 0) continue;
    const step = plan.steps.find((candidate) => candidate.stepId === stepId)!;
    const resolution = resolveCurrentModel(known, step.currentModel);
    const referenceFamily = referenceFamilyByStepId.get(stepId)!;
    for (const { id, family } of [
      ...(resolution.kind === "exact" || resolution.kind === "resolved"
        ? [resolution.model]
        : []),
      ...stepCandidates,
    ]) {
      if (!id.includes("/") && family === id) vendorless.add(id);
    }
    for (const { family: candidateFamily } of stepCandidates) {
      pairs.set(JSON.stringify([candidateFamily, referenceFamily]), {
        candidateFamily,
        referenceFamily,
      });
    }
  }
  if (vendorless.size > 0) {
    const ids = [...vendorless].sort(compareText).slice(0, 3).join(", ");
    throw new ProtocolError({
      exitCode: 2,
      code: "judge_family_unknown",
      message: `The judge's vendor cannot be checked: model ids ${ids} name no vendor, so the built-in judge could come from the same vendor as a candidate or the recorded model.`,
      remedy:
        "Use a gateway whose model ids carry their vendor (vendor/model), or grade with your own evaluator (--evaluator).",
    });
  }
  for (const { candidateFamily, referenceFamily } of pairs.values()) {
    try {
      pickJudges(judgeCatalog, { candidateFamily, referenceFamily });
    } catch (error) {
      if (!(error instanceof NoNeutralJudgeError)) throw error;
      throw new ProtocolError({
        exitCode: 2,
        code: "no_neutral_judge",
        message: `No judge is available: the candidates come from ${candidateFamily} and the recorded model from ${referenceFamily}, and the built-in judge must come from another vendor, but the catalog has no priced model from one.`,
        remedy: noNeutralJudgeRemedy,
      });
    }
  }
}

async function approvedReplayCandidates(
  context: PipelineContext,
  plan: z.infer<typeof replayPlanSchema>,
  catalog: readonly ModelCatalogEntry[],
  runSpecDigest: string,
): Promise<StepShortlist[]> {
  const approved = await approvedSwapSetByDigest(context, runSpecDigest);
  const modelByFamily = new Map<string, string>();
  for (const swap of approved.swaps) {
    const existing = modelByFamily.get(swap.familyId);
    if (existing !== undefined && existing !== swap.toModel) {
      throw new Error(
        `Approved swap ${runSpecDigest} has multiple target models for ${swap.familyId}`,
      );
    }
    modelByFamily.set(swap.familyId, swap.toModel);
  }
  return plan.steps.map((step) => {
    const modelId = modelByFamily.get(step.family);
    if (modelId === undefined) {
      throw new Error(
        `Approved swap ${runSpecDigest} has no target model for ${step.family}`,
      );
    }
    const model = catalog.find(({ id }) => id === modelId);
    if (model === undefined) {
      throw new Error(
        `Approved target model is absent from the provider catalog: ${modelId}`,
      );
    }
    if (
      model.pricing === null ||
      (step.needsTools && !model.supportsTools) ||
      (step.needsStructuredOutput && !model.supportsStructuredOutput) ||
      (model.contextLength !== 0 &&
        model.contextLength < step.observedContextTokens)
    ) {
      throw new Error(
        `Approved target model no longer satisfies replay requirements: ${modelId}`,
      );
    }
    if (
      !plan.includeFreeModels &&
      model.pricing.input === 0 &&
      model.pricing.output === 0
    ) {
      throw new Error(
        `Approved target model is zero-priced; rerun with --include-free: ${modelId}`,
      );
    }
    return {
      stepId: step.stepId,
      candidates: [model],
      droppedByTop: 0,
      droppedFreeModels: 0,
      droppedByOutputCeiling: 0,
    };
  });
}

async function executeReplay(
  context: PipelineContext,
  inputDigestValue: string,
  runId: string,
): Promise<string> {
  const routes = replayRoutes(context);
  const plan = await loadReplayPlan(context);
  const ceilings = await loadReferenceCeilings(context, plan);
  const known =
    context.existingRunId === undefined
      ? await routeCatalog(() => routes.candidates.known())
      : await readDetachedReplayCatalog(context, context.existingRunId);
  const judgeCatalog =
    context.existingRunId === undefined
      ? await routeCatalog(() => routes.judge.callable())
      : known;
  const replaySteps = (split: "shortlist" | "holdout"): ReplayStep[] =>
    plan.steps.map((step) => ({
      ...step,
      corpusSplit: split,
      selectionStage: split,
    }));
  const candidates =
    context.approvedRunSpecDigest === undefined
      ? replayCandidates(plan, known)
      : await approvedReplayCandidates(
          context,
          plan,
          known,
          context.approvedRunSpecDigest,
        );
  reportShortlistAbstentions(context, plan, candidates);
  assertPricedCandidates(routes.candidates.label, candidates);
  const referenceFamilyByStepId = referenceFamiliesByStep(
    plan,
    candidates,
    known,
  );
  const currentPricingByStepId = new Map(
    plan.steps.map((step) => {
      const resolution = resolveCurrentModel(known, step.currentModel);
      return [
        step.stepId,
        resolution.kind === "exact" || resolution.kind === "resolved"
          ? resolution.model.pricing
          : undefined,
      ] as const;
    }),
  );
  let externalEvaluator: EvaluatorProvider | undefined;
  let evaluatorIdentity: string | undefined;
  if (context.evaluator !== undefined) {
    evaluatorIdentity = digest(await evaluatorRunIdentity(context));
    const configured = createEvaluator(context.evaluator);
    externalEvaluator = await preferEvaluatorWhenReachable(
      configured,
      (code, message) => context.reporter.warning(code, message),
    );
  }
  if (externalEvaluator === undefined) {
    assertNeutralJudges(
      plan,
      known,
      judgeCatalog,
      candidates,
      referenceFamilyByStepId,
    );
  }
  const assessmentAbsences = new Map<string, string>();
  const evaluation = () => ({
    evaluatorKind: externalEvaluator?.id ?? "judge",
    gateMetric:
      externalEvaluator === undefined
        ? "replacement-quality"
        : context.evaluator!.gateMetric,
    ...(externalEvaluator === undefined ? {} : { evaluatorIdentity }),
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
  const substituted: SubstitutedResponse[] = [];
  const blockedCellsByFamily = new Map<string, Set<string>>();
  const runCells = async (
    split: "shortlist" | "holdout",
    assignments: typeof candidates,
  ): Promise<void> => {
    const groups = new Map<
      string,
      { readonly candidateFamily: string; readonly referenceFamily?: string }
    >();
    for (const { stepId, candidates } of assignments) {
      for (const { family: candidateFamily } of candidates) {
        const group =
          externalEvaluator === undefined
            ? {
                candidateFamily,
                referenceFamily: referenceFamilyByStepId.get(stepId)!,
              }
            : { candidateFamily };
        groups.set(JSON.stringify(group), group);
      }
    }
    for (const { candidateFamily, referenceFamily } of groups.values()) {
      const familyAssignments = assignments.map((assignment) => ({
        ...assignment,
        candidates:
          referenceFamily === undefined ||
          referenceFamilyByStepId.get(assignment.stepId) === referenceFamily
            ? assignment.candidates.filter(
                ({ family }) => family === candidateFamily,
              )
            : [],
      }));
      const stepIds = new Set(
        familyAssignments
          .filter(({ candidates }) => candidates.length > 0)
          .map(({ stepId }) => stepId),
      );
      const judge =
        referenceFamily === undefined
          ? undefined
          : {
              rankedModels: pickJudges(judgeCatalog, {
                candidateFamily,
                referenceFamily,
              }).map((judgeModel) => ({
                judgeModel,
                supportsStructuredOutput: judgeCatalog.find(
                  ({ id }) => id === judgeModel,
                )!.supportsStructuredOutput,
                ...judgeLimits(judgeCatalog, judgeModel),
              })),
              warning: (code: string, message: string) =>
                context.reporter.warning(code, message),
              providerId: routes.judge.provider.providerId,
              chat: judgeChat(routes.judge.provider, judgeCatalog),
            };
      const result = await replayModeA({
        steps: replaySteps(split),
        cases: plan.cases,
        candidates: familyAssignments,
        provider: routes.candidates.provider,
        ...(judge === undefined ? {} : { judge }),
        store: context.store,
        budget,
        concurrency: context.maxConcurrency ?? 4,
      });
      substituted.push(...result.substituted);
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
        for (const blocked of result.blocked) {
          const familyId = plan.steps.find(
            ({ stepId }) => stepId === blocked.stepId,
          )?.family;
          if (familyId === undefined) continue;
          const blockedCells = blockedCellsByFamily.get(familyId) ?? new Set();
          blockedCells.add(
            JSON.stringify([
              split,
              blocked.stepId,
              blocked.caseId,
              blocked.candidateId,
            ]),
          );
          blockedCellsByFamily.set(familyId, blockedCells);
        }
      }
      completed += result.completed;
      skipped += result.skipped;
      if (externalEvaluator !== undefined) {
        const absences = await assessExternalExecutions({
          context,
          plan,
          evaluator: externalEvaluator,
          evaluatorIdentity: evaluatorIdentity!,
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

  try {
    await runCells("shortlist", candidates);
    const ledger = await readPipelineLedger(context);
    const shortlistVerdicts = aggregate(
      await materializeAggregationFacts(
        context,
        ledger,
        plan,
        candidates,
        evaluation(),
        ceilings,
      ),
      aggregateOptions(context.release.gate),
    ).filter(({ corpusSplit }) => corpusSplit === "shortlist");
    const shortlistSelections = new Map(
      Object.keys(plan.sampleSizes).map((family) => {
        const familyVerdicts = shortlistVerdicts.filter(
          (verdict) => verdict.familyId === family,
        );
        const selectionGap = selectionEvidenceGap(
          familyVerdicts,
          familyCandidates(plan, candidates, family),
        );
        return [
          family,
          blockedCellsByFamily.has(family) || selectionGap !== undefined
            ? noShortlistSelection()
            : selectWinner(
                verdictsByCandidate(familyVerdicts),
                context.release.gate,
              ),
        ];
      }),
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
  } finally {
    warnSubstitutedResponses(context, substituted);
  }
  const key = artifactKey(context, "replay", `${inputDigestValue}-${runId}`);
  await putImmutableJson(context.store, key, {
    completed,
    skipped,
    candidates: candidates.map((assignment) => {
      const pricing = currentPricingByStepId.get(assignment.stepId);
      return {
        ...assignment,
        ...(pricing === undefined ? {} : { currentPricing: pricing }),
      };
    }),
    evaluation: evaluation(),
    familyBlocks: [...blockedCellsByFamily.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([familyId, blockedCells]) => ({
        familyId,
        abstainReason: {
          reason: "replay_operational_block" as const,
          observed: blockedCells.size,
          required: 0,
        },
      })),
  });
  return key;
}

async function executeAggregate(
  context: PipelineContext,
  inputDigestValue: string,
  runId: string,
): Promise<string> {
  const plan = await loadReplayPlan(context);
  const replay = await loadReplayOutput(context);
  const ceilings = await loadReferenceCeilings(context, plan);
  const ledger = await readPipelineLedger(context);
  const allVerdicts = aggregate(
    await materializeAggregationFacts(
      context,
      ledger,
      plan,
      replay.candidates,
      replay.evaluation,
      ceilings,
    ),
    aggregateOptions(context.release.gate),
    ledger.cascadeFindings,
  );
  const families = buildFamilyOutcomes(
    plan,
    allVerdicts,
    replay.candidates,
    replay.familyBlocks,
    ceilings,
    context.release.gate,
  );
  await writeFamilyVerdicts(context, families);
  const key = artifactKey(context, "aggregate", `${inputDigestValue}-${runId}`);
  await putImmutableJson(context.store, key, { allVerdicts, families });
  return key;
}

function buildFamilyOutcomes(
  plan: z.infer<typeof replayPlanSchema>,
  allVerdicts: readonly FamilyVerdict[],
  candidates: z.infer<typeof replayOutputSchema>["candidates"],
  familyBlocks: z.infer<typeof replayOutputSchema>["familyBlocks"],
  ceilings: readonly ReferenceCeiling[],
  policy: ReleaseGatePolicy,
): FamilyOutcome[] {
  const families: FamilyOutcome[] = [];
  for (const familyId of Object.keys(plan.sampleSizes).sort(compareText)) {
    const referenceCeiling = referenceCeilingFor(ceilings, familyId);
    const familyStepIds = new Set(
      plan.steps
        .filter((step) => step.family === familyId)
        .map(({ stepId }) => stepId),
    );
    const familyAssignments = candidates.filter(({ stepId }) =>
      familyStepIds.has(stepId),
    );
    const familyVerdicts = allVerdicts.filter(
      (verdict) => verdict.familyId === familyId,
    );
    const expectedCandidates = familyCandidates(plan, candidates, familyId);
    const replayBlock = familyBlocks.find(
      (block) => block.familyId === familyId,
    );
    const planned = plan.familyPlans.find(
      (entry) => entry.familyId === familyId,
    )?.abstainReason;
    const selectionGap = selectionEvidenceGap(
      familyVerdicts,
      expectedCandidates,
    );
    const catalogDrift =
      familyAssignments.length > 0 &&
      familyAssignments.every(
        ({ abstention }) => abstention?.kind === "current-model-absent",
      )
        ? ({
            reason: "provider_catalog_drift",
            observed: 0,
            required: 1,
          } as const)
        : undefined;
    const abstainReason =
      planned ??
      replayBlock?.abstainReason ??
      catalogDrift ??
      selectionGap?.reason;
    if (abstainReason !== undefined) {
      families.push(
        blockedFamilyOutcome(
          plan,
          familyId,
          expectedCandidates.find(
            ({ id }) => id === selectionGap?.candidateId,
          ) ?? expectedCandidates[0],
          abstainReason,
          referenceCeiling,
          policy,
        ),
      );
      continue;
    }
    const selection = selectWinner(verdictsByCandidate(familyVerdicts), policy);
    const verdict = effectiveVerdict(familyVerdicts, selection);
    if (verdict === undefined) {
      families.push(
        blockedFamilyOutcome(
          plan,
          familyId,
          expectedCandidates[0],
          {
            reason: "selection_missing_shortlist_verdicts",
            observed: 0,
            required: Math.max(expectedCandidates.length, 1),
          },
          referenceCeiling,
          policy,
        ),
      );
      continue;
    }
    const gates = evaluateGates([verdict], policy);
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
      referenceCeiling,
      selection,
      gates,
      decisionDisplay,
      effectiveRecommendation,
    };
    families.push(outcome);
  }
  return families;
}

function familyCandidates(
  plan: z.infer<typeof replayPlanSchema>,
  candidates: readonly StepShortlist[],
  familyId: string,
): ModelCatalogEntry[] {
  const familyStepIds = new Set(
    plan.steps
      .filter((step) => step.family === familyId)
      .map(({ stepId }) => stepId),
  );
  const byId = new Map<string, ModelCatalogEntry>();
  for (const assignment of candidates) {
    if (!familyStepIds.has(assignment.stepId)) continue;
    for (const candidate of assignment.candidates) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
}

function selectionEvidenceGap(
  verdicts: readonly FamilyVerdict[],
  expectedCandidates: readonly ModelCatalogEntry[],
):
  | {
      readonly candidateId?: string;
      readonly reason: AbstainReasonDetails;
    }
  | undefined {
  const shortlistCandidateIds = new Set(
    verdicts
      .filter(({ corpusSplit }) => corpusSplit === "shortlist")
      .map(({ candidateId }) => candidateId),
  );
  const candidateIds = [
    ...new Set([
      ...expectedCandidates.map(({ id }) => id),
      ...verdicts.map(({ candidateId }) => candidateId),
    ]),
  ].sort(compareText);
  if (shortlistCandidateIds.size === 0) {
    return undefined;
  }
  const missingCandidateId = candidateIds.find(
    (candidateId) => !shortlistCandidateIds.has(candidateId),
  );
  return missingCandidateId === undefined
    ? undefined
    : {
        candidateId: missingCandidateId,
        reason: {
          reason: "selection_candidate_verdict_missing",
          observed: shortlistCandidateIds.size,
          required: candidateIds.length,
        },
      };
}

function blockedFamilyOutcome(
  plan: z.infer<typeof replayPlanSchema>,
  familyId: string,
  candidate: ModelCatalogEntry | undefined,
  abstainReason: AbstainReasonDetails,
  referenceCeiling: ReferenceCeiling,
  policy: ReleaseGatePolicy,
): FamilyOutcome {
  const evidenceQuestionId =
    plan.steps.find((step) => step.family === familyId)?.evidenceQuestionId ??
    plan.familyPlans.find((entry) => entry.familyId === familyId)
      ?.evidenceQuestionId;
  if (evidenceQuestionId === undefined) {
    throw new Error(`Replay plan has no step for family ${familyId}`);
  }
  const verdict: FamilyVerdict = {
    evidenceQuestionId,
    corpusSplit: "shortlist",
    familyId,
    candidateId: candidate?.id ?? "unavailable",
    candidateFamily: candidate?.family ?? "unknown",
    caseIds: [],
    candidateCostUsd:
      candidate === undefined ? 0 : (blendedPrice(candidate) ?? 0),
    gatePolicyVersion: policy.gatePolicyVersion,
    referenceCeilingMultiplier: referenceCeiling.multiplier,
    evaluatorKinds: [],
    weakestEvaluatorKind: "none",
    nExecutions: 0,
    nReviewTrials: 0,
    nTrajectories: 0,
    nDistinctSteps: 0,
    excludedExecutions: 0,
    excludedFraction: 0,
    assessmentAbsent: 0,
    assessmentAbsentReasons: [],
    worstCaseBound: 0,
    availability: {
      availableExecutions: 0,
      executions: 0,
      rate: 0,
      lowerBound: 0,
    },
    unsafeSubstitutions: 0,
    coveredEvidenceCases: 0,
    requiredAbstentions: 0,
    satisfiedRequiredAbstentions: 0,
    decision: "abstain",
    abstainReason,
  };
  return {
    familyId,
    verdict,
    referenceCeiling,
    selection: noShortlistSelection(),
    gates: evaluateGates([verdict], policy),
    decisionDisplay: "abstain",
    effectiveRecommendation: false,
  };
}

function withFamilyAbstention(
  family: FamilyOutcome,
  abstainReason: AbstainReasonDetails,
  policy: ReleaseGatePolicy,
): FamilyOutcome {
  const verdict: FamilyVerdict = {
    ...family.verdict,
    decision: "abstain",
    abstainReason,
  };
  return {
    ...family,
    verdict,
    gates: evaluateGates([verdict], policy),
    decisionDisplay: "abstain",
    effectiveRecommendation: false,
  };
}

function noShortlistSelection(): WinnerSelection {
  return {
    status: "no_shortlist_passer",
    shortlistedCandidateIds: [],
    holdoutRequired: false,
  };
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
  const confirmationAbstentions = new Map<string, AbstainReasonDetails>();
  const blockConfirmation = (
    familyId: string,
    abstainReason: AbstainReasonDetails,
    blocker: string,
  ): void => {
    confirmationAbstentions.set(familyId, abstainReason);
    confirmations.set(familyId, {
      status: "blocked",
      runSetsUsed: 0,
      culprits: [],
      cascadeSeedStepId: null,
      blocker,
    });
  };
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
    const backend = config.backend ?? "docker";
    if (backend === "cloud") {
      const cloud = await detectCloudAvailability();
      if (!cloud.available) throw modeBCloudUnavailable(cloud.message);
      if ((process.env[context.apiKeyEnv] ?? "").length === 0) {
        throw modeBCloudUnavailable(
          `The model credential environment variable ${context.apiKeyEnv} is empty, so the egress firewall has no key to broker.`,
        );
      }
    }
    const route = routeHandle(context, "api");
    const provider = route.provider;
    const catalog = await routeCatalog(() => route.known());
    const configuredRecords = configuredStepRecords(config, reconciled.records);
    const orderedRecords = topologicalRecords(configuredRecords);
    const runtimeByCanonical = config.stepMap;
    const runtimeRecords = orderedRecords.map((record) => {
      const resolution = resolveCurrentModel(catalog, record.currentModel);
      return {
        stepId: runtimeByCanonical[record.stepId]!,
        currentModel:
          resolution.kind === "exact" || resolution.kind === "resolved"
            ? resolution.model.id
            : record.currentModel,
        needsTools: record.capabilityRequirements.includes("tools"),
        needsStructuredOutput:
          record.capabilityRequirements.includes("structured_output"),
        observedContextTokens: 0,
        corpusSplit: "holdout" as const,
        selectionStage: "confirm",
      };
    });
    const targetStepId = runtimeRecords.at(-1)!.stepId;
    const scrubbedRuns = (await loadScrub(context)).runs;
    const budget = createBudget({
      store: context.store,
      projectId: context.projectId,
      runId,
      authorizedTotalUsd: context.maxCostUsd,
    });

    const substituted: SubstitutedResponse[] = [];
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
        blockConfirmation(
          familyId,
          {
            reason: "provider_catalog_drift",
            observed: 0,
            required: 1,
          },
          `Selected candidate is absent from the catalog: ${selectedCandidateId}`,
        );
        continue;
      }
      const canonicalSwapStepIds = plan.steps
        .filter((step) => step.family === familyId)
        .map(({ stepId }) => stepId);
      const missingModelStepId = canonicalSwapStepIds.find((stepId) => {
        const record = configuredRecords.find(
          (candidate) => candidate.stepId === stepId,
        );
        return record === undefined || record.currentModel === null;
      });
      if (missingModelStepId !== undefined) {
        blockConfirmation(
          familyId,
          {
            reason: "confirmation_model_metadata_missing",
            observed: canonicalSwapStepIds.filter((stepId) => {
              const record = configuredRecords.find(
                (candidate) => candidate.stepId === stepId,
              );
              return record !== undefined && record.currentModel !== null;
            }).length,
            required: canonicalSwapStepIds.length,
          },
          `Configured confirmation step has no current model: ${missingModelStepId}`,
        );
        continue;
      }
      const referenceFamily = modelFamily(runtimeRecords.at(-1)!.currentModel);
      const judgeModel = pickJudges(catalog, {
        candidateFamily: selectedCatalogEntry.family,
        referenceFamily,
      })[0]!;
      const judgeSupportsStructuredOutput = catalog.find(
        ({ id }) => id === judgeModel,
      )!.supportsStructuredOutput;
      const cases = confirmationCases(scrubbedRuns, targetStepId, familyId);
      if (cases === undefined) {
        blockConfirmation(
          familyId,
          {
            reason: "confirmation_recorded_content_missing",
            observed: 0,
            required: 1,
          },
          "Recorded confirmation data contains no text content.",
        );
        continue;
      }
      const swapSet = canonicalSwapStepIds.map((stepId) => {
        const record = configuredRecords.find(
          (candidate) => candidate.stepId === stepId,
        )!;
        return {
          stepId: runtimeByCanonical[stepId]!,
          currentModel: record.currentModel!,
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
            executor:
              backend === "cloud"
                ? createCloudExecutor({
                    maxBytesPerNamespace: 16 * 1024 * 1024,
                    modelCredential: {
                      host: new URL(context.baseUrl).hostname,
                      headerName: "authorization",
                      value: `Bearer ${process.env[context.apiKeyEnv]!}`,
                    },
                  })
                : createDockerExecutor({
                    maxBytesPerNamespace: 16 * 1024 * 1024,
                  }),
            backend,
            egress: {
              providerId: provider.providerId,
              providerBaseUrl: modeBProviderBaseUrl(context.baseUrl),
              apiKeyEnv: context.apiKeyEnv,
              catalog,
              ...(context.requestHeaders === undefined
                ? {}
                : { requestHeaders: context.requestHeaders }),
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
            warning: (code, message) => context.reporter.warning(code, message),
          },
          stepRecords: runtimeRecords.map((record) => ({
            ...record,
            evidenceQuestionId: family.verdict.evidenceQuestionId,
          })),
          judge: {
            judgeModel,
            supportsStructuredOutput: judgeSupportsStructuredOutput,
            ...judgeLimits(catalog, judgeModel),
            providerId: provider.providerId,
            chat: judgeChat(provider, catalog),
          },
        },
        store: context.store,
        budget: { modeB: budget, maxRunSets },
        policy: context.release.gate,
      });
      substituted.push(...result.substituted);
      confirmedFamilies += 1;
      const lostReasonEntries = Object.entries(result.lostReasons).sort(
        ([left], [right]) => compareText(left, right),
      );
      const lostRows = lostReasonEntries.reduce(
        (total, [, count]) => total + count,
        0,
      );
      if (lostRows > 0) {
        context.reporter.warning(
          "modeb_rows_lost",
          `Family ${familyId}: ${lostRows} Mode B rows lost (${lostReasonEntries.map(([reason, count]) => `${reason}=${count}`).join(", ")})`,
        );
      }
      for (const block of result.infrastructureBlocks) {
        context.reporter.warning(
          "modeb_infrastructure_block",
          `Family ${familyId}: ${block.reason}: ${block.message}`,
        );
      }
      confirmations.set(familyId, {
        status: result.verdict,
        runSetsUsed: result.runSetsUsed,
        culprits: result.culprits.map((culprit) => [...culprit]),
        cascadeSeedStepId: result.cascadeSeed ?? null,
        maxRunSets,
        lostReasons: result.lostReasons,
        infrastructureBlocks: result.infrastructureBlocks,
        ...(result.requiredMaxRunSets === undefined
          ? {}
          : { requiredMaxRunSets: result.requiredMaxRunSets }),
      });
    }
    warnSubstitutedResponses(context, substituted);
  }

  const ledger = await readPipelineLedger(context);
  const ceilings = await loadReferenceCeilings(context, plan);
  const allVerdicts = aggregate(
    await materializeAggregationFacts(
      context,
      ledger,
      plan,
      replay.candidates,
      replay.evaluation,
      ceilings,
    ),
    aggregateOptions(context.release.gate),
    ledger.cascadeFindings,
  );
  const families = buildFamilyOutcomes(
    plan,
    allVerdicts,
    replay.candidates,
    replay.familyBlocks,
    ceilings,
    context.release.gate,
  ).map((family) => {
    const confirmation = confirmations.get(family.familyId);
    if (confirmation !== undefined) {
      const abstainReason = confirmationAbstentions.get(family.familyId);
      if (abstainReason !== undefined) {
        return {
          ...withFamilyAbstention(family, abstainReason, context.release.gate),
          confirmation,
        };
      }
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
  const key = artifactKey(context, "confirm", `${inputDigestValue}-${runId}`);
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
): ModeBCase[] | undefined {
  const cases: ModeBCase[] = [];
  for (const run of runs.filter((run) =>
    run.steps.some(({ family }) => family === familyId),
  )) {
    const first = run.steps[0];
    const last = run.steps.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error(`Trajectory ${run.traceId} has no confirmation steps`);
    }
    const input = firstJsonText(first.messages);
    const referenceOutput = firstJsonText(last.output);
    if (input === undefined || referenceOutput === undefined) {
      return undefined;
    }
    const contextTokens = run.steps.flatMap(({ usage }) =>
      usage === undefined ? [] : [usage.inputTokens],
    );
    if (contextTokens.length === 0) {
      throw new ProtocolError({
        exitCode: 2,
        code: "active_corpus_usage_unavailable",
        message: `Trajectory ${run.traceId} has no recorded token usage`,
        remedy:
          "Publish a corpus version built from traces that include token usage.",
      });
    }
    cases.push({
      caseId: `confirm-${run.traceId}`,
      stepId: targetStepId,
      trajectoryId: run.traceId,
      corpusSplit: "holdout",
      task: "Reproduce the accepted final response for this recorded trajectory.",
      ...(first.systemPrompt === undefined
        ? {}
        : { system: first.systemPrompt }),
      messages: chatMessages(first.messages),
      contextTokens: Math.max(...contextTokens),
      maxOutputTokens: 256,
      referenceOutput,
      input,
    });
  }
  return cases;
}

function firstJsonText(value: JsonValue): string | undefined {
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
  return undefined;
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

async function assessExternalExecutions(input: {
  context: PipelineContext;
  plan: z.infer<typeof replayPlanSchema>;
  evaluator: EvaluatorProvider;
  evaluatorIdentity: string;
  split: "shortlist" | "holdout";
  stepIds: ReadonlySet<string>;
  candidateIds: ReadonlySet<string>;
}): Promise<readonly { executionId: string; reason: string }[]> {
  const config = input.context.evaluator;
  if (config === undefined) {
    throw new Error("External evaluator configuration is unavailable");
  }
  const ledger = await readPipelineLedger(input.context);
  const gateGrades = ledger.assessments.filter(
    (assessment) =>
      assessment.evaluatorId === input.evaluator.id &&
      assessment.metricName === config.gateMetric,
  );
  const assessedGateExecutions = new Set(
    gateGrades.flatMap((assessment) =>
      assessment.evaluatorIdentity === input.evaluatorIdentity
        ? [assessment.executionId]
        : [],
    ),
  );
  const evidenceQuestionIds = new Set(
    input.plan.steps.map(({ evidenceQuestionId }) => evidenceQuestionId),
  );
  const executions = ledger.executions.filter(
    (execution) =>
      evidenceQuestionIds.has(execution.evidenceQuestionId) &&
      execution.corpusSplit === input.split &&
      execution.terminalOutcome === "success" &&
      execution.attribution === "ok" &&
      input.stepIds.has(execution.stepId) &&
      input.candidateIds.has(execution.candidateId) &&
      !assessedGateExecutions.has(execution.executionId),
  );
  if (executions.length === 0) return [];

  const recordedCases = new Map(
    input.plan.cases.map((recordedCase) => [
      `${recordedCase.stepId}\0${recordedCase.caseId}`,
      recordedCase,
    ]),
  );
  const graded = new Set(gateGrades.map(({ executionId }) => executionId));
  const recorded = new Set(
    gateGrades.flatMap(({ executionId, evaluatorIdentity }) =>
      evaluatorIdentity === undefined ? [] : [executionId],
    ),
  );
  const causes = [
    [
      executions.filter(({ executionId }) => recorded.has(executionId)).length,
      "were graded under a different evaluator configuration (an edited rubric file or a changed evaluator option)",
    ],
    [
      executions.filter(
        ({ executionId }) =>
          graded.has(executionId) && !recorded.has(executionId),
      ).length,
      "were graded before rightmodeler recorded evaluator configurations",
    ],
  ] as const;
  const regraded = causes[0][0] + causes[1][0];
  if (regraded > 0) {
    input.context.reporter.warning(
      "evaluator_regrade",
      `Re-grading ${regraded} ${input.split} candidate outputs with ${input.evaluator.id}: ${causes
        .filter(([count]) => count > 0)
        .map(([count, cause]) => `${count} ${cause}`)
        .join(
          ", ",
        )}. The stored outputs are reused; no model call is repeated.`,
    );
  }
  const launched = await input.evaluator.launch({
    experimentName: `rightmodeler-${digest({
      evidenceQuestionIds: [
        ...new Set(
          executions.map(({ evidenceQuestionId }) => evidenceQuestionId),
        ),
      ].sort(compareText),
      candidateIds: [...input.candidateIds].sort(compareText),
      split: input.split,
      evaluatorIdentity: input.evaluatorIdentity,
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
    ledger.assessments.flatMap((assessment) =>
      assessment.evaluatorId === input.evaluator.id &&
      assessment.evaluatorIdentity === input.evaluatorIdentity
        ? [`${assessment.executionId}\0${assessment.metricName}`]
        : [],
    ),
  );
  for (const result of results) {
    await persistEvaluatorMetrics(
      input.context,
      input.evaluator,
      config,
      input.evaluatorIdentity,
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
          result?.absentReason ??
          (status === "failed"
            ? "external_experiment_failed"
            : result === undefined
              ? "external_event_missing"
              : "external_gate_metric_missing"),
      },
    ];
  });
}

async function persistEvaluatorMetrics(
  context: PipelineContext,
  evaluator: EvaluatorProvider,
  config: ResolvedEvaluatorConfig,
  evaluatorIdentity: string,
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
      evaluatorIdentity,
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
  ledger: Ledger,
  plan: z.infer<typeof replayPlanSchema>,
  candidates: readonly StepShortlist[],
  evaluation: z.infer<typeof replayOutputSchema>["evaluation"],
  ceilings: readonly ReferenceCeiling[],
): Promise<AggregationFact[]> {
  const evidenceQuestionIds = new Set(
    plan.steps.map(({ evidenceQuestionId }) => evidenceQuestionId),
  );
  const executions = ledger.executions.filter((execution) =>
    evidenceQuestionIds.has(execution.evidenceQuestionId),
  );
  const assessments = new Map<string, Assessment[]>();
  for (const assessment of ledger.assessments) {
    const current = assessments.get(assessment.executionId) ?? [];
    current.push(assessment);
    assessments.set(assessment.executionId, current);
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
  const traceBound = new Map(
    plan.familyPlans
      .filter(({ binding }) => binding === "trace_key")
      .map(({ familyId, stepIds }) => [familyId, stepIds.length]),
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
        assessment.evaluatorIdentity === evaluation.evaluatorIdentity &&
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
        gatePolicyVersion: context.release.gate.gatePolicyVersion,
        familyId: family,
        candidateFamily: selected.family,
        evaluatorKind: evaluation.evaluatorKind,
        candidateCostUsd: blendedPrice(selected) ?? 0,
        referenceCeilingMultiplier: referenceCeilingFor(ceilings, family)
          .multiplier,
        ...(traceBound.get(family) === undefined
          ? {}
          : { traceBoundCallSites: traceBound.get(family)! }),
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

function aggregateOptions(policy: ReleaseGatePolicy) {
  return {
    gatePolicyVersion: policy.gatePolicyVersion,
    qualityFloor: policy.qualityFloor,
    availabilityFloor: policy.availabilityFloor,
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
    [...pending.entries()].flatMap(([candidateId, candidate]) =>
      candidate.shortlist === undefined
        ? []
        : [[candidateId, { ...candidate, shortlist: candidate.shortlist }]],
    ),
  );
}

function effectiveVerdict(
  verdicts: readonly FamilyVerdict[],
  selection: WinnerSelection,
): FamilyVerdict | undefined {
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
    return undefined;
  }
  return shortlist;
}

const JUDGE_OUTPUT_TOKEN_CAP = 512;

function judgeLimits(
  catalog: readonly ModelCatalogEntry[],
  judgeModel: string,
): { readonly pricing: ModelPricing; readonly maxOutputTokens: number } {
  const entry = catalog.find(({ id }) => id === judgeModel)!;
  if (entry.pricing === null) {
    throw new Error(`Selected judge has no pricing: ${judgeModel}`);
  }
  return {
    pricing: entry.pricing,
    maxOutputTokens: Math.min(
      entry.maxOutputTokens ?? JUDGE_OUTPUT_TOKEN_CAP,
      JUDGE_OUTPUT_TOKEN_CAP,
    ),
  };
}

function judgeChat(
  provider: ProviderClient,
  catalog: readonly ModelCatalogEntry[],
): JudgeChat {
  return (request) => {
    const ceiling =
      catalog.find(({ id }) => id === request.model)?.maxOutputTokens ?? null;
    return provider.chat({
      model: request.model,
      messages: request.messages.map((message) => ({ ...message })),
      temperature: request.temperature,
      maxOutputTokens:
        ceiling === null
          ? JUDGE_OUTPUT_TOKEN_CAP
          : Math.min(ceiling, JUDGE_OUTPUT_TOKEN_CAP),
      ...(request.responseFormat === undefined
        ? {}
        : { responseFormat: jsonValue(request.responseFormat) }),
    });
  };
}

function referenceFamiliesByStep(
  plan: z.infer<typeof replayPlanSchema>,
  candidates: readonly StepShortlist[],
  catalog: readonly ModelCatalogEntry[],
): ReadonlyMap<string, string> {
  const resolvedByStepId = new Map(
    candidates.map(({ stepId, resolvedCurrentModelId }) => [
      stepId,
      resolvedCurrentModelId,
    ]),
  );
  return new Map(
    plan.steps.map(({ stepId, currentModel }) => {
      const modelId = resolvedByStepId.get(stepId) ?? currentModel;
      return [
        stepId,
        catalog.find(({ id }) => id === modelId)?.family ??
          modelFamily(modelId),
      ];
    }),
  );
}

function modelFamily(modelId: string | null): string {
  return modelId === null ? "unknown" : catalogFamily(modelId);
}

function modeBProviderBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.pathname.replace(/\/$/, "").endsWith("/v1")) {
    url.pathname = url.pathname.replace(/\/?v1\/?$/, "/");
  }
  return url.href.replace(/\/$/, "");
}

function reportPath(context: PipelineContext): string {
  return join(context.storeRoot, reportKey(context.projectId, "report.md"));
}

async function codeContextFor(
  context: PipelineContext,
  callSites: readonly CallSiteInput[],
  warn: (code: string, message: string) => void,
): Promise<CodeContext | undefined> {
  if (context.codeGraphPath === undefined) {
    const found = join(context.repo, "graphify-out", "graph.json");
    if (
      await stat(found).then(
        (entry) => entry.isFile(),
        () => false,
      )
    ) {
      const fromCwd = relative(process.cwd(), found);
      const shown = fromCwd.startsWith("..") ? found : fromCwd;
      warn(
        "code_graph_available",
        `Found ${shown}. Pass --code-graph ${shown} to add static code context; it never changes the evidence.`,
      );
    }
    return undefined;
  }
  const scanOutput = await loadScan(context);
  const result = await readCodeContext({
    graphPath: context.codeGraphPath,
    repoDir: context.repo,
    revision: scanOutput.revision,
    callSites,
    scannedPaths: new Set(
      scanOutput.records.map(({ callSite }) => callSite.path),
    ),
    sdkModules: detectTech(context.repo).aiDependencies,
  });
  for (const issue of result.issues) warn(issue.code, issue.message);
  return result.context;
}

function reportCodeContext(
  context: PipelineContext,
): Promise<CodeContext | undefined> {
  context.cache.codeContext ??= (async () => {
    const [scanOutput, plan] = await Promise.all([
      loadScan(context),
      loadReplayPlan(context),
    ]);
    const familyByStep = new Map(
      plan.steps.map(({ stepId, family }) => [stepId, family] as const),
    );
    return codeContextFor(
      context,
      scanOutput.records.map((record) => ({
        stepId: record.stepId,
        family: familyByStep.get(record.stepId) ?? record.family,
        path: record.callSite.path,
        line: record.callSite.line,
      })),
      (code, message) => context.reporter.warning(code, message),
    );
  })();
  return context.cache.codeContext;
}

async function executeReport(
  context: PipelineContext,
  inputDigestValue: string,
  ledger: Ledger,
): Promise<string> {
  const report = await buildReport(context, ledger);
  const jsonKey = reportKey(context.projectId, "report.json");
  const markdownKey = reportKey(context.projectId, "report.md");
  const markdown = renderReport(report);
  await putMutableJson(context.store, jsonKey, jsonValue(report));
  await putMutableText(context.store, markdownKey, markdown);
  await mkdir(dirname(reportPath(context)), { recursive: true });
  await writeFile(reportPath(context), markdown, "utf8");
  return jsonKey;
}

async function checkpointOutputExists(
  context: PipelineContext,
  stage: PipelineStage,
  checkpoint: Checkpoint,
): Promise<boolean> {
  if ((await context.store.get(checkpoint.outputKey)) === null) return false;
  if (stage !== "report") return true;
  if (
    (await context.store.get(reportKey(context.projectId, "report.md"))) ===
    null
  ) {
    return false;
  }
  try {
    await readFile(reportPath(context));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
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

async function loadReferenceCeilings(
  context: PipelineContext,
  plan: z.infer<typeof replayPlanSchema>,
): Promise<ReferenceCeiling[]> {
  const [auditEntry, importedEntry] = await Promise.all([
    context.store.get(auditResultKey(context.projectId)),
    context.store.get(importedReferenceCorpusKey(context.projectId)),
  ]);
  const audit: AuditResult | undefined =
    auditEntry === null
      ? undefined
      : auditResultSchema.parse(
          JSON.parse(Buffer.from(auditEntry.body).toString("utf8")),
        );
  const imported =
    importedEntry === null
      ? undefined
      : importedReferenceCorpusSchema.parse(
          JSON.parse(Buffer.from(importedEntry.body).toString("utf8")),
        );
  const ceilings = referenceCeilings(
    [
      ...plan.cases.map(({ caseId, family }) => ({ caseId, family })),
      ...(imported?.cases ?? []),
    ],
    audit,
  );
  for (const { familyId } of plan.familyPlans) {
    if (ceilings.some(({ family }) => family === familyId)) continue;
    ceilings.push({
      family: familyId,
      multiplier: 1,
      baseMultiplier: 1,
      baseSource: "default",
      referenceCount: 0,
      verifiedCuratedReferences: 0,
    });
  }
  return ceilings;
}

function referenceCeilingFor(
  ceilings: readonly ReferenceCeiling[],
  family: string,
): ReferenceCeiling {
  const ceiling = ceilings.find((item) => item.family === family);
  if (ceiling === undefined) {
    throw new Error(`Reference ceiling is missing for family ${family}`);
  }
  return ceiling;
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
  context: Pick<PipelineContext, "store" | "projectId">,
  stage: PipelineStage,
  schema: z.ZodType<T>,
): Promise<T> {
  const state = await readSetupState(context.store, context.projectId);
  const checkpoint = state.stages[stage];
  if (checkpoint === undefined) throw stageNotCompleted(stage);
  return schema.parse(await readJson(context.store, checkpoint.outputKey));
}

function artifactKey(
  context: PipelineContext,
  stage: PipelineStage,
  inputDigestValue: string,
): string {
  return `${setupPrefix(context.projectId)}${stage}-${inputDigestValue}.json`;
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

function contextRepositoryFiles(
  context: PipelineContext,
): Promise<Array<{ absolute: string; path: string }>> {
  context.cache.repositoryFiles ??= repositoryFiles(
    context.repo,
    context.storeRoot,
  );
  return context.cache.repositoryFiles;
}

function contextRepositoryDigest(context: PipelineContext): Promise<string> {
  context.cache.repositoryDigest ??= repositoryDigest(
    context.repo,
    context.storeRoot,
  );
  return context.cache.repositoryDigest;
}

async function repositoryFiles(
  repo: string,
  storeRoot: string,
): Promise<Array<{ absolute: string; path: string }>> {
  const paths = (await gitFiles(repo)) ?? (await walkFiles(repo));
  const files: Array<{ absolute: string; path: string }> = [];
  for (const path of paths) {
    const absolute = join(repo, ...path.split("/"));
    if (absolute === storeRoot || absolute.startsWith(`${storeRoot}${sep}`)) {
      continue;
    }
    if (path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment))) {
      continue;
    }
    const stats = await stat(absolute).catch(() => undefined);
    if (stats?.isFile()) files.push({ absolute, path });
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

async function gitFiles(repo: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repo,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((path) => path.length > 0);
  } catch {
    return undefined;
  }
}

async function walkFiles(repo: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(repo, absolute).split(sep).join("/"));
      }
    }
  }
  await visit(repo);
  return files;
}

async function repositoryDigest(
  repo: string,
  storeRoot: string,
): Promise<string> {
  const revision = await repositoryRevision(repo);
  const fileDigests: Array<{ path: string; sha256: string }> = [];
  const files = await repositoryFiles(repo, storeRoot);
  for (let index = 0; index < files.length; index += 16) {
    fileDigests.push(
      ...(await Promise.all(
        files.slice(index, index + 16).map(async (file) => ({
          path: file.path,
          sha256: sha256(await readFile(file.absolute)),
        })),
      )),
    );
  }
  return digest({
    revision,
    files: fileDigests,
  });
}

async function repositoryRevision(repo: string): Promise<string> {
  let insideWorkTree: string;
  try {
    ({ stdout: insideWorkTree } = await execFileAsync(
      "git",
      ["-C", repo, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8" },
    ));
  } catch {
    throw notGitRepository();
  }
  if (insideWorkTree.trim() !== "true") throw notGitRepository();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8" },
    );
    return stdout.trim();
  } catch {
    throw new ProtocolError({
      exitCode: 2,
      code: "git_repository_has_no_commits",
      message:
        "This git repository has no commits. Rightmodeler ties findings to your code, so make an initial commit and rerun.",
      remedy: "Create the first commit, then rerun the command.",
    });
  }
}

function notGitRepository(): ProtocolError {
  return new ProtocolError({
    exitCode: 2,
    code: "not_git_repository",
    message:
      "This folder is not a git repository. Rightmodeler ties findings to your code, so run it inside the project you want audited (or run git init and commit first).",
    remedy:
      "Run the command again from a Git repository with at least one commit.",
  });
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

function warnSubstitutedResponses(
  context: PipelineContext,
  responses: readonly SubstitutedResponse[],
): void {
  if (responses.length === 0) return;
  const count = (kind: SubstitutedResponse["substitution"]["kind"]) =>
    responses.filter(({ substitution }) => substitution.kind === kind).length;
  const examples = [
    ...new Set(responses.map(({ substitution }) => substitution.evidence)),
  ].slice(0, 3);
  context.reporter.warning(
    "replay_responses_substituted",
    `${responses.length} replayed response(s) did not come fresh from the requested model (model ${count("model")}, cache ${count("cache")}, request ${count("request")}), for example: ${examples.join("; ")}. They were left out of the evidence as attribution_substituted. Name replay models by their upstream ids (rename custom aliases) and turn off fallbacks, response caching and request plugins for the replay route, then rerun with a fresh store (--store <directory>), because completed replay cells are reused. See "Which model answered" in rightmodeler docs getting-started.`,
  );
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
  if (isUsageLimit(error)) {
    return new ProtocolError({
      exitCode: 2,
      code: "plan_usage_limit",
      message: error.message,
      remedy:
        "Rerun the same command after the limit resets; completed replay and judge calls are kept and not repeated.",
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
  if (error instanceof NoNeutralJudgeError) {
    return new ProtocolError({
      exitCode: 2,
      code: "no_neutral_judge",
      message: error.message,
      remedy: noNeutralJudgeRemedy,
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
  referenceCeilings: ReferenceCeiling[];
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
  candidateErrors: Array<{
    candidateId: string;
    calls: number;
    sampleExcerpt: string;
  }>;
  receipts: FamilyReceipt[];
  blockedFamilies: Array<{
    familyId: string;
    diagnosis: Diagnosis;
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
  codeContext?: CodeContext;
}

function blockedFamilyDiagnosis(
  family: FamilyOutcome,
  aggregationFacts: readonly AggregationFact[],
): ReportData["blockedFamilies"][number] | undefined {
  if (family.effectiveRecommendation || family.verdict.decision === "reject") {
    return undefined;
  }
  const reason = family.verdict.abstainReason?.reason;
  const missingEvidence =
    family.verdict.nExecutions === 0 ||
    family.verdict.coveredEvidenceCases < family.verdict.nExecutions;
  const familyFailureCode =
    reason === "replay_operational_block" || reason === "provider_catalog_drift"
      ? `replay_${reason}`
      : reason === "selection_candidate_verdict_missing" ||
          reason === "selection_missing_shortlist_verdicts"
        ? "missing_candidate_result"
        : missingEvidence ||
            reason?.includes("evidence") ||
            reason === "incomplete_evaluator_coverage"
          ? "missing_evidence"
          : null;
  const selectionGate =
    family.verdict.decision === "abstain"
      ? undefined
      : family.selection.status === "no_shortlist_passer"
        ? "recommendation-precision"
        : family.selection.status === "holdout_failed"
          ? "safe-opportunity-recall"
          : undefined;
  const gates: Array<{ id: string; status: "pass" | "fail" }> =
    family.gates.map(({ id, pass }) => ({
      id,
      status: pass ? ("pass" as const) : ("fail" as const),
    }));
  if (
    selectionGate !== undefined &&
    !gates.some(({ id }) => id === selectionGate)
  ) {
    gates.push({ id: selectionGate, status: "fail" });
  }
  const cases = aggregationFacts
    .filter(
      ({ execution, familyId }) =>
        familyId === family.familyId &&
        execution.candidateId === family.verdict.candidateId &&
        execution.corpusSplit === family.verdict.corpusSplit,
    )
    .map(({ execution, assessment, assessmentAbsentReason }) => ({
      caseId: execution.caseId,
      pipelineFamily: "structured-check",
      terminalVerdict:
        execution.terminalOutcome === "failure" || assessment?.passed === false
          ? ("fail" as const)
          : execution.terminalOutcome === "abstain" || assessment === undefined
            ? ("abstain" as const)
            : ("pass" as const),
      failureCode:
        assessmentAbsentReason ??
        (assessment === undefined ? "missing_evidence" : null),
      evidenceRefs: assessment === undefined ? [] : [assessment.assessmentId],
    }));
  const syntheticCaseId = `family:${family.familyId}`;
  if (familyFailureCode !== null) {
    cases.push({
      caseId: syntheticCaseId,
      pipelineFamily: "structured-check",
      terminalVerdict: familyFailureCode.startsWith("replay_")
        ? "fail"
        : "abstain",
      failureCode: familyFailureCode,
      evidenceRefs: [],
    });
  }
  const diagnosis = diagnoseFailure({
    gates,
    cases,
    replayObserved:
      reason === "replay_operational_block" ||
      reason === "provider_catalog_drift",
  });
  return {
    familyId: family.familyId,
    diagnosis: {
      ...diagnosis,
      triggerCaseIds: diagnosis.triggerCaseIds.filter(
        (caseId) => caseId !== syntheticCaseId,
      ),
    },
  };
}

function spendSummary(spendEvents: readonly SpendEvent[]): ReportData["spend"] {
  const byActor: Record<string, { events: number; costUsd: number }> = {};
  for (const spend of spendEvents) {
    const actor = byActor[spend.actor] ?? { events: 0, costUsd: 0 };
    actor.events += 1;
    actor.costUsd += spend.costUsd;
    byActor[spend.actor] = actor;
  }
  return {
    events: spendEvents.length,
    totalCostUsd: spendEvents.reduce(
      (total, spend) => total + spend.costUsd,
      0,
    ),
    byActor,
  };
}

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
      const ordered = group;
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

interface FamilyReceipt {
  familyId: string;
  winnerCostPerCaseUsd: number | null;
  incumbentCostPerCaseUsd: number | null;
  costDeltaPct: number | null;
  winnerLatencyP50Ms: number | null;
}

export function familyReceipts(
  ledger: Ledger,
  plan: z.input<typeof replayPlanSchema>,
  replay: z.infer<typeof replayOutputSchema>,
  corpus: Corpus,
  verdicts: readonly FamilyVerdict[],
): FamilyReceipt[] {
  const pricingByStepId = new Map(
    replay.candidates.map(({ stepId, currentPricing }) => [
      stepId,
      currentPricing,
    ]),
  );
  const usageByCaseId = new Map(
    corpus.cases.map((corpusCase) => [
      corpusCase.caseId,
      corpusCase.observation?.usage,
    ]),
  );
  const attemptsByExecutionId = new Map<string, RequestAttempt[]>();
  for (const attempt of ledger.requestAttempts) {
    attemptsByExecutionId.set(attempt.executionId, [
      ...(attemptsByExecutionId.get(attempt.executionId) ?? []),
      attempt,
    ]);
  }

  return verdicts.map((verdict) => {
    const familyStepIds = new Set(
      plan.steps
        .filter(({ family }) => family === verdict.familyId)
        .map(({ stepId }) => stepId),
    );
    const winnerExecutions = ledger.executions
      .filter(
        (execution) =>
          familyStepIds.has(execution.stepId) &&
          execution.candidateId === verdict.candidateId &&
          execution.terminalOutcome === "success" &&
          execution.attribution === "ok" &&
          (execution.selectionStage === "shortlist" ||
            execution.selectionStage === "holdout"),
      )
      .sort((left, right) => compareText(left.executionId, right.executionId));
    const winnerCostPerCaseUsd =
      winnerExecutions.length === 0
        ? null
        : winnerExecutions.reduce(
            (total, execution) =>
              total +
              (attemptsByExecutionId.get(execution.executionId) ?? []).reduce(
                (executionTotal, attempt) => executionTotal + attempt.costUsd,
                0,
              ),
            0,
          ) / winnerExecutions.length;
    let incumbentTotal = 0;
    let hasIncumbentCost = winnerExecutions.length > 0;
    for (const execution of winnerExecutions) {
      const usage = usageByCaseId.get(execution.caseId);
      const pricing = pricingByStepId.get(execution.stepId);
      if (usage === undefined || pricing === undefined || pricing === null) {
        hasIncumbentCost = false;
        break;
      }
      incumbentTotal +=
        usage.inputTokens * pricing.input + usage.outputTokens * pricing.output;
    }
    const incumbentCostPerCaseUsd = hasIncumbentCost
      ? incumbentTotal / winnerExecutions.length
      : null;
    const costDeltaPct =
      winnerCostPerCaseUsd === null ||
      incumbentCostPerCaseUsd === null ||
      incumbentCostPerCaseUsd === 0
        ? null
        : ((winnerCostPerCaseUsd - incumbentCostPerCaseUsd) /
            incumbentCostPerCaseUsd) *
          100;
    const latencies = winnerExecutions
      .flatMap((execution) =>
        (attemptsByExecutionId.get(execution.executionId) ?? []).flatMap(
          ({ latencyMs }) => (latencyMs === undefined ? [] : [latencyMs]),
        ),
      )
      .sort((left, right) => left - right);
    const middle = Math.floor(latencies.length / 2);
    const winnerLatencyP50Ms =
      latencies.length === 0
        ? null
        : latencies.length % 2 === 1
          ? latencies[middle]!
          : (latencies[middle - 1]! + latencies[middle]!) / 2;

    return {
      familyId: verdict.familyId,
      winnerCostPerCaseUsd,
      incumbentCostPerCaseUsd,
      costDeltaPct,
      winnerLatencyP50Ms,
    };
  });
}

function candidateErrorReport(
  ledger: Ledger,
  plan: z.infer<typeof replayPlanSchema>,
  replay: z.infer<typeof replayOutputSchema>,
): ReportData["candidateErrors"] {
  const evidenceQuestionIds = new Set(
    plan.steps.map(({ evidenceQuestionId }) => evidenceQuestionId),
  );
  const candidateIds = new Set(
    replay.candidates.flatMap(({ candidates }) =>
      candidates.map(({ id }) => id),
    ),
  );
  const executions = new Map(
    ledger.executions.flatMap((execution): Array<[string, Execution]> =>
      evidenceQuestionIds.has(execution.evidenceQuestionId) &&
      candidateIds.has(execution.candidateId)
        ? [[execution.executionId, execution]]
        : [],
    ),
  );
  const callsByCandidate = new Map<string, Map<string, RequestAttempt[]>>();
  for (const attempt of ledger.requestAttempts) {
    const execution = executions.get(attempt.executionId);
    if (execution === undefined) continue;
    const calls = callsByCandidate.get(execution.candidateId) ?? new Map();
    calls.set(attempt.logicalCallId, [
      ...(calls.get(attempt.logicalCallId) ?? []),
      attempt,
    ]);
    callsByCandidate.set(execution.candidateId, calls);
  }
  return [...callsByCandidate.entries()]
    .flatMap(([candidateId, calls]) => {
      const logicalCalls = [...calls.values()];
      if (
        logicalCalls.length === 0 ||
        logicalCalls.some((attempts) =>
          attempts.some(
            ({ streamOutcome }) => streamOutcome !== "provider_error",
          ),
        )
      ) {
        return [];
      }
      const sampleExcerpt = logicalCalls
        .flat()
        .find(({ errorDetail }) => errorDetail !== undefined)
        ?.errorDetail?.bodyExcerpt;
      return [
        {
          candidateId,
          calls: logicalCalls.length,
          sampleExcerpt:
            sampleExcerpt ?? "No provider response body was returned.",
        },
      ];
    })
    .sort((left, right) => compareText(left.candidateId, right.candidateId));
}

async function buildReport(
  context: PipelineContext,
  ledger: Ledger,
): Promise<ReportData> {
  const decisionOutput = await loadDecisionOutput(context);
  const verdicts = decisionOutput.families.map(({ verdict }) => verdict);
  const consistency = ledger.assessments.flatMap((assessment) => {
    const metadata = judgeMetadata(assessment);
    return metadata === undefined ? [] : [metadata.orderConsistent];
  });
  const corpus = await loadCorpusSummary(context);
  const plan = await loadReplayPlan(context);
  const replay = await loadReplayOutput(context);
  const replayedCorpus = await resolveCheckpointedPipelineCorpus(context);
  const aggregationFacts = await materializeAggregationFacts(
    context,
    ledger,
    plan,
    replay.candidates,
    replay.evaluation,
    decisionOutput.families.map(({ referenceCeiling }) => referenceCeiling),
  );
  const worksheet = await loadCurrent(
    context,
    "audit-sample",
    auditWorksheetSchema,
  );
  const codeContext = await reportCodeContext(context);
  return {
    verdicts,
    families: decisionOutput.families,
    referenceCeilings: decisionOutput.families.map(
      ({ referenceCeiling }) => referenceCeiling,
    ),
    judgeDisagreement: {
      disagreements: consistency.filter((value) => !value).length,
      assessments: consistency.length,
      rate:
        consistency.length === 0
          ? 0
          : consistency.filter((value) => !value).length / consistency.length,
    },
    spend: spendSummary(ledger.spendEvents),
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
      ...replay.candidates.map(({ stepId, droppedFreeModels }) => ({
        name: "droppedFreeModels",
        stepId,
        value: droppedFreeModels,
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
    candidateErrors: candidateErrorReport(ledger, plan, replay),
    receipts: familyReceipts(ledger, plan, replay, replayedCorpus, verdicts),
    blockedFamilies: decisionOutput.families.flatMap((family) => {
      const blocked = blockedFamilyDiagnosis(family, aggregationFacts);
      return blocked === undefined ? [] : [blocked];
    }),
    apply: lifecycleReport(ledger.lifecycleEvents),
    ...(codeContext === undefined ? {} : { codeContext }),
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
    "## Blocked families",
    "",
    ...(report.blockedFamilies.length === 0
      ? ["None."]
      : [
          "| Family | Issue class | Next action | Trigger cases |",
          "| --- | --- | --- | --- |",
          ...report.blockedFamilies.map(
            ({ familyId, diagnosis }) =>
              `| ${familyId} | ${diagnosis.issueClass} | ${diagnosis.nextAction} | ${diagnosis.triggerCaseIds.join(", ")} |`,
          ),
        ]),
    "",
    "## Reference ceilings",
    "",
    "| Family | Ceiling | Source |",
    "| --- | --- | --- |",
    ...report.referenceCeilings.map(
      (ceiling) =>
        `| ${ceiling.family} | ${formatRate(ceiling.multiplier)} | ${ceiling.baseSource} base ${formatRate(ceiling.baseMultiplier)}; curated verified ${ceiling.verifiedCuratedReferences}/${ceiling.referenceCount} |`,
    ),
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
    "## Candidate provider errors",
    "",
    ...(report.candidateErrors.length === 0
      ? ["None."]
      : report.candidateErrors.map(
          ({ candidateId, calls, sampleExcerpt }) =>
            `- [warn] ${reportText(candidateId)} errored on ALL ${calls} calls. Sample: ${reportText(sampleExcerpt)}`,
        )),
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
    "## Cost and latency receipts",
    "",
    "| Family | Incumbent $/case | Winner $/case | Delta | p50 latency |",
    "| --- | --- | --- | --- | --- |",
    ...report.receipts.map(
      (receipt) =>
        `| ${receipt.familyId} | ${formatUsdPerCase(receipt.incumbentCostPerCaseUsd)} | ${formatUsdPerCase(receipt.winnerCostPerCaseUsd)} | ${formatDeltaPct(receipt.costDeltaPct)} | ${formatLatencyMs(receipt.winnerLatencyP50Ms)} |`,
    ),
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
  if (report.codeContext !== undefined)
    lines.push(...renderCodeContext(report.codeContext), "");
  return lines.join("\n");
}

function reportText(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
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

async function readPipelineLedger(context: PipelineContext): Promise<Ledger> {
  const ledger = await readLedger(context.store, context.projectId);
  if (ledger.droppedRows > 0) {
    context.reporter.warning(
      "facts_dropped",
      `Skipped ${ledger.droppedRows} unreadable fact records while reading the ledger.`,
    );
  }
  return ledger;
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
    auditResultKey(context.projectId),
    jsonValue(result),
  );
  return result;
}

export async function readReport(options: {
  repo: string;
  store?: string;
  codeGraphPath?: string;
  reporter?: Reporter;
}): Promise<{
  report: ReportData;
  reportPath: string;
  recommends: boolean;
}> {
  const context = createContext({
    ...options,
    reporter:
      options.reporter ??
      new Reporter("human", {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
  });
  const state = await readSetupState(context.store, context.projectId);
  const aggregateCheckpoint = state.stages.aggregate;
  if (aggregateCheckpoint === undefined) {
    throw stageNotCompleted("aggregate");
  }
  const ledger = await readPipelineLedger(context);
  await executeReport(
    context,
    digest({
      stage: "report",
      upstream:
        state.stages.confirm?.inputDigest ?? aggregateCheckpoint.inputDigest,
    }),
    ledger,
  );
  const report = await buildReport(context, ledger);
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
  const ledger = await readPipelineLedger(context);
  const factCounts: Record<string, number> = {
    Execution: ledger.executions.length,
    RequestAttempt: ledger.requestAttempts.length,
    Assessment: ledger.assessments.length,
    SpendEvent: ledger.spendEvents.length,
    CascadeFinding: ledger.cascadeFindings.length,
    LifecycleEvent: ledger.lifecycleEvents.length,
  };
  const corpus = await maybeLoadCorpus(context);
  const runs: RunMeta[] = [];
  const prefix = runsPrefix(context.projectId);
  const runKeys = (await context.store.list(prefix)).filter(
    (key) => !key.slice(prefix.length).includes("/"),
  );
  for (const key of runKeys) {
    runs.push(runMetaSchema.parse(await readJson(context.store, key)));
  }
  runs.sort((left, right) => compareText(right.startedAt, left.startedAt));
  return {
    stepsByStatus: stepCounts,
    factCounts,
    droppedFacts: ledger.droppedRows,
    spend: spendSummary(ledger.spendEvents),
    corpusVersion: corpus?.corpusVersionId ?? null,
    lastRun: runs[0] ?? null,
    pullRequests: watchablePullRequests(ledger.lifecycleEvents),
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
