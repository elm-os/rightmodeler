import { randomUUID } from "node:crypto";

import {
  assessmentSchema,
  cascadeFindingSchema,
  confirmPlanKey,
  computeRunSpecDigest,
  executionSchema,
  factSchema,
  factsPrefix,
  spendEventSchema,
  type Assessment,
  type CascadeFinding,
  type Execution,
  type SpendEvent,
  type Store,
} from "@rightmodeler/core";
import {
  deltaDebug,
  evaluatorWorstCaseBound,
  judgeExecution,
  type DeltaDebugLogEntry,
  type DeltaDebugTestOutcome,
  type JudgeChat,
  type ReleaseGatePolicy,
} from "@rightmodeler/kernel";

export { createDockerExecutor } from "@rightmodeler/executor";

import type { Budget } from "./budget.js";
import {
  replayModeB,
  type ModeBCase,
  type ModeBSwapPolicy,
  type ReplayModeBInput,
  type ReplayModeBResult,
} from "./driver-modeb.js";
import { writeReplayFact } from "./driver.js";
import { ProviderConfigurationError } from "./provider.js";
import type { ReplayStep } from "./shortlist.js";

type PlanItemStatus = "pending" | "running" | "pass" | "fail";

export interface ConfirmPlanItem {
  readonly subsetKey: string;
  readonly members: readonly string[];
  readonly status: PlanItemStatus;
}

export interface ConfirmPlan {
  readonly version: 1;
  readonly familyId: string;
  readonly inputDigest: string;
  readonly queue: readonly ConfirmPlanItem[];
  readonly verdict?: ConfirmVerdict;
  readonly culprits?: readonly (readonly string[])[];
  readonly cascadeSeed?: string;
  readonly members?: readonly ConfirmMemberResult[];
}

export interface ConfirmFamily {
  readonly familyId: string;
  readonly evidenceQuestionId: string;
  readonly stepOrder?: readonly string[];
}

export interface ConfirmSwap {
  readonly stepId: string;
  readonly currentModel: string;
  readonly candidateModel: string;
}

export interface ConfirmModeB {
  readonly input: Omit<
    ReplayModeBInput,
    "stepRecords" | "cases" | "swapPolicy" | "store" | "budget"
  >;
  readonly stepRecords: readonly ReplayStep[];
  readonly judge: {
    readonly chat: JudgeChat;
    readonly judgeModel: string;
    readonly providerId?: string;
  };
  readonly runner?: (input: ReplayModeBInput) => Promise<ReplayModeBResult>;
}

export interface ConfirmBudget {
  readonly modeB: Budget;
  readonly maxRunSets: number;
}

export type ConfirmVerdict = "confirmed" | "isolated" | "inconclusive";
export type CascadeStatus = "confirmed" | "cascade-seed" | "uncertain" | "pass";

export interface ConfirmMemberResult {
  readonly stepId: string;
  readonly cascadeStatus: CascadeStatus;
}

export interface ConfirmSwapSetInput {
  readonly family: ConfirmFamily;
  readonly swapSet: readonly ConfirmSwap[];
  readonly cases: readonly ModeBCase[];
  readonly modeB: ConfirmModeB;
  readonly store: Store;
  readonly budget: ConfirmBudget;
  readonly policy: ReleaseGatePolicy;
}

export interface ConfirmSwapSetResult {
  readonly familyId: string;
  readonly verdict: ConfirmVerdict;
  readonly culprits: readonly (readonly string[])[];
  readonly cascadeSeed?: string;
  readonly members: readonly ConfirmMemberResult[];
  readonly runSetsUsed: number;
  readonly log: readonly DeltaDebugLogEntry<string>[];
  readonly requiredMaxRunSets?: number;
}

interface FactsIndex {
  readonly executions: readonly Execution[];
  readonly assessments: readonly Assessment[];
  readonly spendEvents: readonly SpendEvent[];
  readonly cascadeFindings: readonly CascadeFinding[];
}

type RunSetOutcome = DeltaDebugTestOutcome | "incomplete";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(nonemptyString) &&
    new Set(value).size === value.length
  );
}

function planItem(value: unknown): ConfirmPlanItem {
  if (!isRecord(value)) throw new Error("Confirm plan item must be an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "members,status,subsetKey") {
    throw new Error("Confirm plan item has unexpected fields");
  }
  if (
    !nonemptyString(value.subsetKey) ||
    !stringArray(value.members) ||
    (value.status !== "pending" &&
      value.status !== "running" &&
      value.status !== "pass" &&
      value.status !== "fail")
  ) {
    throw new Error("Confirm plan item is malformed");
  }
  return {
    subsetKey: value.subsetKey,
    members: value.members,
    status: value.status,
  };
}

function memberResult(value: unknown): ConfirmMemberResult {
  if (!isRecord(value)) {
    throw new Error("Confirm plan member result must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "cascadeStatus,stepId") {
    throw new Error("Confirm plan member result has unexpected fields");
  }
  if (
    !nonemptyString(value.stepId) ||
    (value.cascadeStatus !== "confirmed" &&
      value.cascadeStatus !== "cascade-seed" &&
      value.cascadeStatus !== "uncertain" &&
      value.cascadeStatus !== "pass")
  ) {
    throw new Error("Confirm plan member result is malformed");
  }
  return { stepId: value.stepId, cascadeStatus: value.cascadeStatus };
}

function parsePlan(value: unknown): ConfirmPlan {
  if (!isRecord(value)) throw new Error("Confirm plan must be an object");
  const allowed = new Set([
    "version",
    "familyId",
    "inputDigest",
    "queue",
    "verdict",
    "culprits",
    "cascadeSeed",
    "members",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Confirm plan has unexpected fields");
  }
  if (
    value.version !== 1 ||
    !nonemptyString(value.familyId) ||
    !nonemptyString(value.inputDigest) ||
    !Array.isArray(value.queue)
  ) {
    throw new Error("Confirm plan is malformed");
  }
  const queue = value.queue.map(planItem);
  if (new Set(queue.map(({ subsetKey }) => subsetKey)).size !== queue.length) {
    throw new Error("Confirm plan contains duplicate subset keys");
  }
  if (
    value.verdict !== undefined &&
    value.verdict !== "confirmed" &&
    value.verdict !== "isolated" &&
    value.verdict !== "inconclusive"
  ) {
    throw new Error("Confirm plan verdict is malformed");
  }
  if (
    value.culprits !== undefined &&
    (!Array.isArray(value.culprits) || !value.culprits.every(stringArray))
  ) {
    throw new Error("Confirm plan culprits are malformed");
  }
  if (value.cascadeSeed !== undefined && !nonemptyString(value.cascadeSeed)) {
    throw new Error("Confirm plan cascade seed is malformed");
  }
  if (value.members !== undefined && !Array.isArray(value.members)) {
    throw new Error("Confirm plan members are malformed");
  }
  return {
    version: 1,
    familyId: value.familyId,
    inputDigest: value.inputDigest,
    queue,
    ...(value.verdict === undefined ? {} : { verdict: value.verdict }),
    ...(value.culprits === undefined
      ? {}
      : { culprits: value.culprits as string[][] }),
    ...(value.cascadeSeed === undefined
      ? {}
      : { cascadeSeed: value.cascadeSeed }),
    ...(value.members === undefined
      ? {}
      : { members: value.members.map(memberResult) }),
  };
}

function encodePlan(plan: ConfirmPlan): Buffer {
  return Buffer.from(JSON.stringify(plan), "utf8");
}

async function ensurePlan(
  store: Store,
  key: string,
  familyId: string,
  inputDigest: string,
): Promise<ConfirmPlan> {
  for (;;) {
    const entry = await store.get(key);
    if (entry !== null) {
      const plan = parsePlan(
        JSON.parse(Buffer.from(entry.body).toString("utf8")) as unknown,
      );
      if (plan.familyId !== familyId || plan.inputDigest !== inputDigest) {
        throw new Error("Confirm plan belongs to a different input");
      }
      return plan;
    }
    const plan: ConfirmPlan = {
      version: 1,
      familyId,
      inputDigest,
      queue: [],
    };
    if (await store.compareAndSwap(key, 0, encodePlan(plan), 0)) return plan;
  }
}

async function updatePlan(
  store: Store,
  key: string,
  familyId: string,
  inputDigest: string,
  update: (current: ConfirmPlan) => ConfirmPlan,
): Promise<ConfirmPlan> {
  for (;;) {
    const entry = await store.get(key);
    if (entry === null) {
      await ensurePlan(store, key, familyId, inputDigest);
      continue;
    }
    const current = parsePlan(
      JSON.parse(Buffer.from(entry.body).toString("utf8")) as unknown,
    );
    if (current.familyId !== familyId || current.inputDigest !== inputDigest) {
      throw new Error("Confirm plan belongs to a different input");
    }
    const next = parsePlan(update(current));
    const won = await store.compareAndSwap(
      key,
      entry.version,
      encodePlan(next),
      entry.fenceToken,
    );
    if (won) return next;
  }
}

function replacePlanItem(
  plan: ConfirmPlan,
  subsetKey: string,
  members: readonly string[],
  status: PlanItemStatus,
): ConfirmPlan {
  const existing = plan.queue.find((item) => item.subsetKey === subsetKey);
  if (
    existing !== undefined &&
    JSON.stringify(existing.members) !== JSON.stringify(members)
  ) {
    throw new Error("Confirm subset key maps to different members");
  }
  if (
    existing !== undefined &&
    (existing.status === "pass" || existing.status === "fail") &&
    existing.status !== status
  ) {
    throw new Error("Confirm subset has conflicting terminal outcomes");
  }
  const item: ConfirmPlanItem = { subsetKey, members: [...members], status };
  return {
    ...plan,
    queue:
      existing === undefined
        ? [...plan.queue, item]
        : plan.queue.map((candidate) =>
            candidate.subsetKey === subsetKey ? item : candidate,
          ),
  };
}

function stepOrderOf(
  family: ConfirmFamily,
  swapSet: readonly ConfirmSwap[],
): readonly string[] {
  const order = family.stepOrder;
  if (order === undefined) return swapSet.map(({ stepId }) => stepId);
  if (
    new Set(order).size !== order.length ||
    order.length !== swapSet.length ||
    swapSet.some(({ stepId }) => !order.includes(stepId))
  ) {
    throw new Error("family.stepOrder must contain every swap exactly once");
  }
  return order;
}

function validateInput(input: ConfirmSwapSetInput): void {
  if (input.family.familyId.length === 0) {
    throw new Error("familyId must not be empty");
  }
  if (input.family.evidenceQuestionId.length === 0) {
    throw new Error("family.evidenceQuestionId must not be empty");
  }
  if (input.swapSet.length === 0) throw new Error("swapSet must not be empty");
  const swapIds = input.swapSet.map(({ stepId }) => stepId);
  if (
    swapIds.some((stepId) => stepId.length === 0) ||
    new Set(swapIds).size !== swapIds.length
  ) {
    throw new Error("swapSet step ids must be unique and non-empty");
  }
  for (const swap of input.swapSet) {
    if (swap.currentModel.length === 0 || swap.candidateModel.length === 0) {
      throw new Error("swapSet models must not be empty");
    }
  }
  const caseIds = input.cases.map(({ caseId }) => caseId);
  if (input.cases.length === 0 || new Set(caseIds).size !== caseIds.length) {
    throw new Error("cases must be non-empty with unique case ids");
  }
  const stepIds = new Set(input.modeB.stepRecords.map(({ stepId }) => stepId));
  if (input.swapSet.some(({ stepId }) => !stepIds.has(stepId))) {
    throw new Error("Every swap must have a Mode B step record");
  }
  if (input.store !== input.budget.modeB.store) {
    throw new Error("Confirm store must match the Mode B budget store");
  }
}

function confirmInputDigest(
  familyId: string,
  input: ConfirmSwapSetInput,
): string {
  return computeRunSpecDigest({
    kind: "confirm",
    familyId,
    evidenceQuestionId: input.family.evidenceQuestionId,
    releaseGatePolicy: {
      gatePolicyVersion: input.policy.gatePolicyVersion,
      qualityFloor: input.policy.qualityFloor,
      availabilityFloor: input.policy.availabilityFloor,
    },
    swaps: input.swapSet.map((swap) => ({ ...swap })),
    cases: input.cases.map((recordedCase) => ({
      caseId: recordedCase.caseId,
      stepId: recordedCase.stepId,
      trajectoryId: recordedCase.trajectoryId,
      corpusSplit: recordedCase.corpusSplit,
      task: recordedCase.task,
      system: recordedCase.system ?? null,
      messages: [...recordedCase.messages],
      temperature: recordedCase.temperature ?? null,
      contextTokens: recordedCase.contextTokens,
      maxOutputTokens: recordedCase.maxOutputTokens,
      tools: recordedCase.tools ?? null,
      toolChoice: recordedCase.toolChoice ?? null,
      responseFormat: recordedCase.responseFormat ?? null,
      headers:
        recordedCase.headers === undefined ? null : { ...recordedCase.headers },
      referenceOutput: recordedCase.referenceOutput,
      input: recordedCase.input,
    })),
    stepRecords: input.modeB.stepRecords.map((step) => ({
      stepId: step.stepId,
      evidenceQuestionId: step.evidenceQuestionId,
      currentModel: step.currentModel,
      needsTools: step.needsTools,
      needsStructuredOutput: step.needsStructuredOutput,
      observedContextTokens: step.observedContextTokens,
      corpusSplit: step.corpusSplit,
      selectionStage: step.selectionStage ?? null,
    })),
    judge: {
      model: input.modeB.judge.judgeModel,
      providerId: input.modeB.judge.providerId ?? null,
    },
    runtime: {
      providerId: input.modeB.input.egress.providerId,
      providerBaseUrl: input.modeB.input.egress.providerBaseUrl,
      catalog: input.modeB.input.egress.catalog.map((model) => ({
        id: model.id,
        family: model.family,
        contextLength: model.contextLength,
        pricing:
          model.pricing === null
            ? null
            : {
                input: model.pricing.input,
                output: model.pricing.output,
              },
        supportsTools: model.supportsTools,
        supportsStructuredOutput: model.supportsStructuredOutput,
      })),
      image: input.modeB.input.image,
      appSpec: {
        mountPath: input.modeB.input.appSpec.mountPath,
        command: [
          ...input.modeB.input.appSpec.command(
            "/rightmodeler/scratch/driver/case.json",
          ),
        ],
        installCommand:
          input.modeB.input.appSpec.installCommand === undefined
            ? null
            : [...input.modeB.input.appSpec.installCommand],
        timeoutMs: input.modeB.input.appSpec.timeoutMs ?? null,
      },
      concurrency: input.modeB.input.concurrency,
    },
  });
}

function subsetKey(inputDigest: string, members: readonly string[]): string {
  return computeRunSpecDigest({
    kind: "confirm-subset",
    inputDigest,
    members: [...members],
  });
}

function evidenceQuestionId(key: string): string {
  return computeRunSpecDigest({ kind: "confirm-evidence", subsetKey: key });
}

function totalPolicy(
  swapSet: readonly ConfirmSwap[],
  members: readonly string[],
): ModeBSwapPolicy {
  const included = new Set(members);
  return Object.fromEntries(
    swapSet.map((swap) => [
      swap.stepId,
      included.has(swap.stepId) ? swap.candidateModel : swap.currentModel,
    ]),
  );
}

function candidateId(policy: ModeBSwapPolicy): string {
  const entries = Object.entries(policy).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 1
    ? entries[0]![1]
    : JSON.stringify(Object.fromEntries(entries));
}

async function readFacts(store: Store, projectId: string): Promise<FactsIndex> {
  const executions: Execution[] = [];
  const assessments: Assessment[] = [];
  const spendEvents: SpendEvent[] = [];
  const cascadeFindings: CascadeFinding[] = [];
  for (const key of await store.list(factsPrefix(projectId))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Listed fact is missing: ${key}`);
    const fact = factSchema.parse(
      JSON.parse(Buffer.from(entry.body).toString("utf8")) as unknown,
    );
    const execution = executionSchema.safeParse(fact);
    if (execution.success) executions.push(execution.data);
    const assessment = assessmentSchema.safeParse(fact);
    if (assessment.success) assessments.push(assessment.data);
    const spendEvent = spendEventSchema.safeParse(fact);
    if (spendEvent.success) spendEvents.push(spendEvent.data);
    const cascadeFinding = cascadeFindingSchema.safeParse(fact);
    if (cascadeFinding.success) cascadeFindings.push(cascadeFinding.data);
  }
  return { executions, assessments, spendEvents, cascadeFindings };
}

function expectedExecutions(
  facts: FactsIndex,
  cases: readonly ModeBCase[],
  questionId: string,
  selectedCandidateId: string,
): Map<string, Execution> | "ambiguous" {
  const caseIds = new Set(cases.map(({ caseId }) => caseId));
  const matches = facts.executions.filter(
    (execution) =>
      execution.evidenceQuestionId === questionId &&
      execution.candidateId === selectedCandidateId &&
      caseIds.has(execution.caseId),
  );
  const byCase = new Map<string, Execution>();
  for (const execution of matches) {
    if (byCase.has(execution.caseId)) return "ambiguous";
    byCase.set(execution.caseId, execution);
  }
  return byCase;
}

function deterministicFactId(
  kind: string,
  ...parts: readonly string[]
): string {
  return `${kind}-${computeRunSpecDigest([kind, ...parts])}`;
}

function hasJudgeEvidenceFailure(
  spendEvents: readonly SpendEvent[],
  executionId: string,
  key: string,
): boolean {
  return spendEvents.some((event) => {
    if (event.actor !== "judge" || event.phase !== "confirm") return false;
    if (!isRecord(event.reconcilableTo)) return false;
    return (
      event.reconcilableTo.executionId === executionId &&
      event.reconcilableTo.subsetKey === key &&
      event.reconcilableTo.assessmentAbsentReason ===
        "judge_evidence_incomplete" &&
      (event.reconcilableTo.judgeFailureKind === "response_malformed" ||
        event.reconcilableTo.judgeFailureKind === "provider_error")
    );
  });
}

async function assessExecution(
  input: ConfirmSwapSetInput,
  recordedCase: ModeBCase,
  execution: Execution,
  key: string,
  existing: readonly Assessment[],
  spendEvents: readonly SpendEvent[],
): Promise<Assessment | "ambiguous" | "judge_evidence_incomplete"> {
  const matches = existing.filter(
    (assessment) =>
      assessment.executionId === execution.executionId &&
      assessment.metricName === "replacement-quality",
  );
  if (matches.length > 1) return "ambiguous";
  if (matches[0] !== undefined) return matches[0];
  if (hasJudgeEvidenceFailure(spendEvents, execution.executionId, key)) {
    return "judge_evidence_incomplete";
  }

  let invocation = 0;
  let judgeFailureKind: "response_malformed" | "provider_error" =
    "response_malformed";
  let judgePersistenceFailure: unknown;
  let judged;
  try {
    judged = await judgeExecution({
      chat: async (request) => {
        invocation += 1;
        try {
          return await input.modeB.judge.chat(request);
        } catch (error) {
          if (error instanceof ProviderConfigurationError) throw error;
          judgeFailureKind = "provider_error";
          throw error;
        } finally {
          const spendId = randomUUID();
          try {
            await writeReplayFact(
              input.store,
              input.budget.modeB.projectId,
              spendId,
              spendEventSchema.parse({
                actor: "judge",
                phase: "confirm",
                costUsd: 0,
                provider:
                  input.modeB.judge.providerId ??
                  input.modeB.input.egress.providerId,
                reconcilableTo: {
                  executionId: execution.executionId,
                  judgeModel: input.modeB.judge.judgeModel,
                  invocation,
                  costUnavailable: true,
                  subsetKey: key,
                },
              }),
            );
          } catch (persistenceError) {
            judgePersistenceFailure = persistenceError;
            throw persistenceError;
          }
        }
      },
      judgeModel: input.modeB.judge.judgeModel,
      task: recordedCase.task,
      reference:
        typeof recordedCase.referenceOutput === "string"
          ? recordedCase.referenceOutput
          : JSON.stringify(recordedCase.referenceOutput),
      candidate:
        typeof execution.finalOutput === "string"
          ? execution.finalOutput
          : JSON.stringify(execution.finalOutput),
    });
  } catch (error) {
    if (
      error instanceof ProviderConfigurationError ||
      judgePersistenceFailure !== undefined
    ) {
      throw error;
    }
    const failureId = randomUUID();
    await writeReplayFact(
      input.store,
      input.budget.modeB.projectId,
      failureId,
      spendEventSchema.parse({
        actor: "judge",
        phase: "confirm",
        costUsd: 0,
        provider:
          input.modeB.judge.providerId ?? input.modeB.input.egress.providerId,
        reconcilableTo: {
          executionId: execution.executionId,
          judgeModel: input.modeB.judge.judgeModel,
          assessmentAbsentReason: "judge_evidence_incomplete",
          judgeFailureKind,
          errorDetail: {
            message: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 300),
            judgeModel: input.modeB.judge.judgeModel,
          },
          subsetKey: key,
        },
      }),
    );
    return "judge_evidence_incomplete";
  }
  const assessmentId = deterministicFactId(
    "confirm-assessment",
    execution.executionId,
  );
  return assessmentSchema.parse(
    await writeReplayFact(
      input.store,
      input.budget.modeB.projectId,
      assessmentId,
      assessmentSchema.parse({
        assessmentId,
        executionId: execution.executionId,
        evaluatorId: judged.evaluatorId,
        metricName: judged.metricName,
        score: judged.score,
        passed: judged.passed,
        rubricVersion: judged.rubricVersion,
        artifactRef: {
          evidence: judged.artifactRef,
          verdict: judged.verdict,
          justification: judged.justification,
          judgeModel: judged.judgeModel,
          orderConsistent: judged.orderConsistent,
          subsetKey: key,
        },
      }),
    ),
  );
}

async function outcomeFromFacts(
  input: ConfirmSwapSetInput,
  key: string,
  questionId: string,
  selectedCandidateId: string,
): Promise<RunSetOutcome> {
  const facts = await readFacts(input.store, input.budget.modeB.projectId);
  const executions = expectedExecutions(
    facts,
    input.cases,
    questionId,
    selectedCandidateId,
  );
  if (executions === "ambiguous") return "ambiguous";
  if (executions.size < input.cases.length) return "incomplete";

  let ambiguous = false;
  const observations: Array<{
    trajectoryId: string;
    passed: boolean;
  }> = [];
  for (const recordedCase of input.cases) {
    const execution = executions.get(recordedCase.caseId)!;
    if (
      execution.attribution === "lost" ||
      execution.attribution === "ambiguous"
    ) {
      observations.push({
        trajectoryId: execution.trajectoryId,
        passed: false,
      });
      continue;
    }
    if (
      execution.terminalOutcome !== "success" ||
      execution.attribution === "silent-failure"
    ) {
      observations.push({
        trajectoryId: execution.trajectoryId,
        passed: false,
      });
      continue;
    }
    const assessment = await assessExecution(
      input,
      recordedCase,
      execution,
      key,
      facts.assessments,
      facts.spendEvents,
    );
    if (assessment === "ambiguous") ambiguous = true;
    else if (assessment === "judge_evidence_incomplete") {
      observations.push({
        trajectoryId: execution.trajectoryId,
        passed: false,
      });
    } else {
      observations.push({
        trajectoryId: execution.trajectoryId,
        passed: assessment.passed,
      });
    }
  }
  if (ambiguous) return "ambiguous";
  const bound = evaluatorWorstCaseBound(observations, `${questionId}\0judge`);
  return bound < input.policy.qualityFloor ? "fail" : "pass";
}

function finalizedMembers(
  swapSet: readonly ConfirmSwap[],
  verdict: ConfirmVerdict,
  culprits: readonly (readonly string[])[],
  cascadeSeed: string | undefined,
): ConfirmMemberResult[] {
  const culpritMembers = new Set(culprits.flat());
  return swapSet.map(({ stepId }) => ({
    stepId,
    cascadeStatus:
      verdict === "confirmed"
        ? "confirmed"
        : verdict === "inconclusive"
          ? "uncertain"
          : stepId === cascadeSeed
            ? "cascade-seed"
            : culpritMembers.has(stepId)
              ? "uncertain"
              : "pass",
  }));
}

function firstCascadeSeed(
  order: readonly string[],
  culprits: readonly (readonly string[])[],
): string | undefined {
  const members = new Set(culprits.flat());
  return order.find((stepId) => members.has(stepId));
}

function emptyFailure(log: readonly DeltaDebugLogEntry<string>[]): boolean {
  return log.some(
    (entry) => entry.subset.length === 0 && entry.outcome === "fail",
  );
}

export async function confirmSwapSet(
  input: ConfirmSwapSetInput,
): Promise<ConfirmSwapSetResult> {
  validateInput(input);
  const familyId = input.family.familyId;
  const stepOrder = stepOrderOf(input.family, input.swapSet);
  const inputDigest = confirmInputDigest(familyId, input);
  const planKey = confirmPlanKey(input.budget.modeB.projectId, familyId);
  await ensurePlan(input.store, planKey, familyId, inputDigest);

  const runSubset = async (
    members: readonly string[],
    execute: boolean,
  ): Promise<DeltaDebugTestOutcome> => {
    const key = subsetKey(inputDigest, members);
    const questionId = evidenceQuestionId(key);
    const policy = totalPolicy(input.swapSet, members);
    const selectedCandidateId = candidateId(policy);
    const plan = await ensurePlan(input.store, planKey, familyId, inputDigest);
    const existing = plan.queue.find((item) => item.subsetKey === key);
    if (existing?.status === "pass" || existing?.status === "fail") {
      const persisted = await outcomeFromFacts(
        input,
        key,
        questionId,
        selectedCandidateId,
      );
      if (persisted !== existing.status) {
        throw new Error("Confirm plan outcome conflicts with persisted facts");
      }
      return persisted;
    }
    if (existing === undefined) {
      await updatePlan(input.store, planKey, familyId, inputDigest, (current) =>
        replacePlanItem(current, key, members, "pending"),
      );
    }

    let outcome = await outcomeFromFacts(
      input,
      key,
      questionId,
      selectedCandidateId,
    );
    if (outcome === "pass" || outcome === "fail") {
      const terminalOutcome = outcome;
      await updatePlan(input.store, planKey, familyId, inputDigest, (current) =>
        replacePlanItem(current, key, members, terminalOutcome),
      );
      return terminalOutcome;
    }
    if (!execute) return "ambiguous";

    await updatePlan(input.store, planKey, familyId, inputDigest, (current) =>
      replacePlanItem(current, key, members, "running"),
    );
    const result = await (input.modeB.runner ?? replayModeB)({
      ...input.modeB.input,
      stepRecords: input.modeB.stepRecords.map((step) => ({
        ...step,
        evidenceQuestionId: questionId,
        selectionStage: "confirm",
      })),
      cases: input.cases,
      swapPolicy: policy,
      store: input.store,
      budget: input.budget.modeB,
    });
    outcome = await outcomeFromFacts(
      input,
      key,
      questionId,
      selectedCandidateId,
    );
    if (
      result.blocked.length > 0 ||
      result.rejectedRows > 0 ||
      outcome === "ambiguous" ||
      outcome === "incomplete"
    ) {
      await updatePlan(input.store, planKey, familyId, inputDigest, (current) =>
        replacePlanItem(current, key, members, "pending"),
      );
      return "ambiguous";
    }
    await updatePlan(input.store, planKey, familyId, inputDigest, (current) =>
      replacePlanItem(current, key, members, outcome),
    );
    return outcome;
  };

  const result = await deltaDebug({
    items: input.swapSet.map(({ stepId }) => stepId),
    test: (members) => runSubset(members, true),
    budget: { maxRunSets: input.budget.maxRunSets },
  });
  const fullPassed =
    result.log.length === 1 && result.log[0]?.outcome === "pass";
  const verdict: ConfirmVerdict = fullPassed
    ? "confirmed"
    : result.verdict === "isolated"
      ? "isolated"
      : "inconclusive";
  const cascadeSeed =
    verdict === "isolated"
      ? firstCascadeSeed(stepOrder, result.culprits)
      : undefined;
  const members = finalizedMembers(
    input.swapSet,
    verdict,
    result.culprits,
    cascadeSeed,
  );
  const capped =
    verdict === "inconclusive" &&
    !result.log.some(({ outcome }) => outcome === "ambiguous") &&
    !emptyFailure(result.log) &&
    result.runSetsUsed >= input.budget.maxRunSets;

  if (capped) {
    await deltaDebug({
      items: input.swapSet.map(({ stepId }) => stepId),
      test: (subset) => runSubset(subset, false),
      budget: { maxRunSets: input.budget.maxRunSets + 1 },
    });
  }
  await updatePlan(input.store, planKey, familyId, inputDigest, (current) => {
    return {
      version: current.version,
      familyId: current.familyId,
      inputDigest: current.inputDigest,
      queue: current.queue,
      verdict,
      culprits: result.culprits,
      ...(cascadeSeed === undefined ? {} : { cascadeSeed }),
      members,
    };
  });

  const uncertainStepIds = members.flatMap(({ stepId, cascadeStatus }) =>
    cascadeStatus === "uncertain" ? [stepId] : [],
  );
  const cascadeId = deterministicFactId(
    "cascade",
    inputDigest,
    verdict,
    JSON.stringify(result.culprits),
    cascadeSeed ?? "",
    JSON.stringify(uncertainStepIds),
    String(result.runSetsUsed),
  );
  const existingFinding = (
    await readFacts(input.store, input.budget.modeB.projectId)
  ).cascadeFindings.find((finding) => finding.cascadeId === cascadeId);
  if (existingFinding === undefined) {
    await writeReplayFact(
      input.store,
      input.budget.modeB.projectId,
      cascadeId,
      cascadeFindingSchema.parse({
        cascadeId,
        familyId,
        evidenceQuestionId: input.family.evidenceQuestionId,
        swapSetKey: inputDigest,
        verdict,
        culprits: result.culprits,
        cascadeSeedStepId: cascadeSeed ?? null,
        uncertainStepIds,
        runSetsUsed: result.runSetsUsed,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  return {
    familyId,
    verdict,
    culprits: result.culprits,
    ...(cascadeSeed === undefined ? {} : { cascadeSeed }),
    members,
    runSetsUsed: result.runSetsUsed,
    log: result.log,
    ...(capped ? { requiredMaxRunSets: input.budget.maxRunSets + 1 } : {}),
  };
}
