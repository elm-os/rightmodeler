import { randomUUID } from "node:crypto";

import {
  assessmentSchema,
  executionSchema,
  factKey,
  factSchema,
  mintAssessmentId,
  mintAttemptId,
  mintExecutionId,
  readLedger,
  requestAttemptSchema,
  spendEventSchema,
  type Fact,
  type Execution,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import {
  judgeExecution,
  type CorpusSplit,
  type JudgeChat,
  type JudgeChatResult,
} from "@rightmodeler/kernel";

import {
  BudgetRefusalError,
  reserveWhenFree,
  type Budget,
  type BudgetReservation,
} from "./budget.js";
import {
  BlockedError,
  estimateInputTokens,
  isUsageLimit,
  type ChatMessage,
  type ModelCatalogEntry,
  type ModelPricing,
  ProviderConfigurationError,
  ProviderRequestError,
  ProviderResponseError,
  type ProviderAttempt,
  type ProviderClient,
} from "./provider.js";
import type { SubstitutedResponse } from "./provenance.js";
import type { ReplayStep, StepShortlist } from "./shortlist.js";

const BUDGET_HEARTBEAT_INTERVAL_MS = 30_000;
const JUDGE_CONCURRENCY = 8;

export interface RecordedCase {
  caseId: string;
  stepId: string;
  trajectoryId: string;
  corpusSplit: CorpusSplit;
  task: string;
  system?: string;
  messages: readonly JsonValue[];
  temperature?: number;
  contextTokens: number;
  maxOutputTokens: number;
  tools?: JsonValue;
  toolChoice?: JsonValue;
  responseFormat?: JsonValue;
  headers?: Readonly<Record<string, string>>;
  referenceOutput: JsonValue;
}

export interface ReplayModeAInput {
  steps: readonly ReplayStep[];
  cases: readonly RecordedCase[];
  candidates: readonly StepShortlist[];
  provider: ProviderClient;
  judge?: {
    chat: JudgeChat;
    rankedModels: readonly {
      judgeModel: string;
      supportsStructuredOutput: boolean;
      pricing: ModelPricing;
      maxOutputTokens: number;
    }[];
    warning?: (code: string, message: string) => void;
    providerId?: string;
  };
  store: Store;
  budget: Budget;
  concurrency: number;
}

interface BlockedCellBase {
  stepId: string;
  caseId: string;
  candidateId: string;
  message: string;
}

export type BlockedCell =
  | (BlockedCellBase & { kind: "budget" })
  | (BlockedCellBase & { kind: "rate-limit"; observedCeiling: number });

export interface ReplayModeAResult {
  completed: number;
  skipped: number;
  blocked: BlockedCell[];
  substituted: SubstitutedResponse[];
}

interface ReplayCell {
  step: ReplayStep;
  recordedCase: RecordedCase;
  candidate: ModelCatalogEntry;
}

interface JudgeCell {
  readonly cell: ReplayCell;
  readonly executionId: string;
  readonly candidateOutput: string;
  readonly recordAttempt: (
    attempt: ProviderAttempt,
    logicalCallId?: ReturnType<typeof randomUUID>,
    providerId?: string,
  ) => Promise<void>;
}

export function replayCorrelationKey(
  evidenceQuestionId: string,
  caseId: string,
  candidateId: string,
): string {
  return JSON.stringify([evidenceQuestionId, caseId, candidateId]);
}

export async function writeReplayFact(
  store: Store,
  projectId: string,
  factId: string,
  value: unknown,
): Promise<Fact> {
  const fact = factSchema.parse(value);
  await store.putImmutable(
    factKey(projectId, factId),
    Buffer.from(JSON.stringify(fact), "utf8"),
  );
  return fact;
}

async function replayFactState(
  store: Store,
  projectId: string,
  runId?: string,
): Promise<{
  readonly completed: Set<string>;
  readonly unusableJudges: Set<string>;
  readonly unassessed: Map<
    string,
    { executionId: string; candidateOutput: string }
  >;
}> {
  const ledger = await readLedger(store, projectId);
  const completed = new Set<string>();
  const unusableJudges = new Set<string>();
  const executions: readonly Execution[] = ledger.executions;
  const assessed = new Set(
    ledger.assessments.map(({ executionId }) => executionId),
  );
  for (const execution of executions) {
    completed.add(
      replayCorrelationKey(
        execution.evidenceQuestionId,
        execution.caseId,
        execution.candidateId,
      ),
    );
  }
  for (const spend of ledger.spendEvents) {
    if (
      spend.actor === "judge" &&
      typeof spend.reconcilableTo === "object" &&
      spend.reconcilableTo !== null &&
      !Array.isArray(spend.reconcilableTo) &&
      spend.reconcilableTo.judgeStatus === "unusable" &&
      typeof spend.reconcilableTo.judgeModel === "string" &&
      (spend.reconcilableTo.note !== "rate_limited" ||
        spend.reconcilableTo.runId === runId)
    ) {
      unusableJudges.add(
        JSON.stringify([spend.provider, spend.reconcilableTo.judgeModel]),
      );
    }
  }
  const unassessed = new Map<
    string,
    { executionId: string; candidateOutput: string }
  >();
  for (const execution of executions) {
    if (
      execution.attribution === "ok" &&
      execution.terminalOutcome === "success" &&
      typeof execution.finalOutput === "string" &&
      !assessed.has(execution.executionId)
    ) {
      unassessed.set(
        replayCorrelationKey(
          execution.evidenceQuestionId,
          execution.caseId,
          execution.candidateId,
        ),
        {
          executionId: execution.executionId,
          candidateOutput: execution.finalOutput,
        },
      );
    }
  }
  return { completed, unusableJudges, unassessed };
}

export async function terminalReplayCells(
  store: Store,
  projectId: string,
): Promise<Set<string>> {
  return (await replayFactState(store, projectId)).completed;
}

function cellsFor(input: ReplayModeAInput): ReplayCell[] {
  const casesByStep = new Map<string, RecordedCase[]>();
  for (const recordedCase of input.cases) {
    const cases = casesByStep.get(recordedCase.stepId) ?? [];
    cases.push(recordedCase);
    casesByStep.set(recordedCase.stepId, cases);
  }
  const candidatesByStep = new Map(
    input.candidates.map((assignment) => [
      assignment.stepId,
      assignment.candidates,
    ]),
  );
  const cells: ReplayCell[] = [];
  for (const step of input.steps) {
    for (const candidate of candidatesByStep.get(step.stepId) ?? []) {
      for (const recordedCase of casesByStep.get(step.stepId) ?? []) {
        if (recordedCase.corpusSplit !== step.corpusSplit) continue;
        cells.push({ step, recordedCase, candidate });
      }
    }
  }
  return cells;
}

export function toWireMessages(
  messages: readonly JsonValue[],
  system?: string,
): ChatMessage[] {
  const wire = messages.map((message, index): ChatMessage => {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    ) {
      throw new Error(`Recorded message ${index + 1} must be an object`);
    }
    const role = message.role;
    if (
      role !== "system" &&
      role !== "developer" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      throw new Error(`Recorded message ${index + 1}.role is unsupported`);
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      throw new Error(
        `Recorded message ${index + 1} carries tool calls, which replay does not send yet`,
      );
    }
    const content = (() => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.parts)) {
        throw new Error(
          `Recorded message ${index + 1} must have string content or text parts`,
        );
      }
      return message.parts
        .map((part, partIndex) => {
          if (
            typeof part !== "object" ||
            part === null ||
            Array.isArray(part) ||
            part.type !== "text" ||
            typeof part.content !== "string"
          ) {
            throw new Error(
              `Recorded message ${index + 1}.parts[${partIndex}] must be a text part`,
            );
          }
          return part.content;
        })
        .join("\n");
    })();
    if (role !== "tool") return { role, content };
    if (typeof message.tool_call_id !== "string") {
      throw new Error(
        `Recorded message ${index + 1}.tool_call_id must be a string`,
      );
    }
    return { role, content, tool_call_id: message.tool_call_id };
  });
  return system === undefined
    ? wire
    : [{ role: "system", content: system }, ...wire];
}

export async function replayModeA(
  input: ReplayModeAInput,
): Promise<ReplayModeAResult> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  if (input.store !== input.budget.store) {
    throw new Error("Replay store must match the budget store");
  }
  const replayState = await replayFactState(
    input.store,
    input.budget.projectId,
    input.budget.runId,
  );
  const existing = replayState.completed;
  const cells = cellsFor(input);
  const result: ReplayModeAResult = {
    completed: 0,
    skipped: 0,
    blocked: [],
    substituted: [],
  };
  const activeRefunds = new Set<Promise<void>>();
  let nextCell = 0;
  let failure: unknown;
  const judges = input.judge?.rankedModels.slice(0, 4) ?? [];
  if (input.judge !== undefined && judges.length === 0) {
    throw new Error("At least one ranked judge model is required");
  }
  const judgeProviderId = input.judge?.providerId ?? input.provider.providerId;
  const unusableJudges = replayState.unusableJudges;
  const firstUsableJudge = judges.findIndex(
    ({ judgeModel }) =>
      !unusableJudges.has(JSON.stringify([judgeProviderId, judgeModel])),
  );
  let activeJudgeIndex =
    firstUsableJudge === -1 ? judges.length : firstUsableJudge;
  let consecutiveJudgeFailures = 0;
  let judgeStreakRateLimited = false;
  let judgeFailurePending: JudgeCell[] = [];
  const judgeQueue: JudgeCell[] = [];
  const judgeJobs = new Set<Promise<void>>();
  let judgeSwitchTrigger: {
    readonly job: JudgeCell;
    readonly substitution?: string;
    readonly rateLimited?: boolean;
  } | null = null;
  let judgeRetirement = new AbortController();

  async function completeWithAssessment(
    job: JudgeCell,
    judged: Awaited<ReturnType<typeof judgeExecution>>,
  ): Promise<void> {
    const assessmentId = mintAssessmentId();
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      assessmentId,
      assessmentSchema.parse({
        assessmentId,
        executionId: job.executionId,
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
          judgeProvider: judgeProviderId,
          orderConsistent: judged.orderConsistent,
        },
      }),
    );
  }

  async function recordJudgeFailure(
    job: JudgeCell,
    judgeModel: string,
    judgeFailureKind: "response_malformed" | "provider_error",
    error: unknown,
  ): Promise<void> {
    const failureId = randomUUID();
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      failureId,
      spendEventSchema.parse({
        actor: "judge",
        phase: job.cell.step.selectionStage ?? job.cell.step.corpusSplit,
        costUsd: 0,
        provider: judgeProviderId,
        reconcilableTo: {
          executionId: job.executionId,
          judgeModel,
          judgeFailureKind,
          errorDetail: {
            message: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 300),
            judgeModel,
          },
        },
      }),
    );
  }

  async function attemptJudge(
    job: JudgeCell,
    judge: (typeof judges)[number],
  ): Promise<
    | {
        readonly status: "success";
        readonly assessment: Awaited<ReturnType<typeof judgeExecution>>;
      }
    | { readonly status: "failure"; readonly rateLimited: boolean }
    | { readonly status: "blocked"; readonly message: string }
  > {
    const retirement = judgeRetirement.signal;
    let judgeInvocation = 0;
    let judgeFailureKind: "response_malformed" | "provider_error" =
      "response_malformed";
    let judgePersistenceFailure: unknown;
    try {
      const assessment = await judgeExecution({
        chat: async (request) => {
          let judgeResponse: JudgeChatResult | undefined;
          judgeInvocation += 1;
          const judgeLogicalCallId = randomUUID();
          const reservation = await reserveWhenFree(
            input.budget,
            {
              contextTokens: estimateInputTokens(request.messages),
              maxOutputTokens: judge.maxOutputTokens,
              pricing: judge.pricing,
            },
            activeRefunds,
            retirement,
          );
          if (retirement.aborted) {
            await reservation.refund(0);
            throw retirement.reason;
          }
          let resolveRefund = (): void => undefined;
          const refundComplete = new Promise<void>((resolve) => {
            resolveRefund = resolve;
          });
          activeRefunds.add(refundComplete);
          try {
            judgeResponse = await input.judge!.chat(request);
            if (judgeResponse.substitution !== undefined) {
              const { kind, evidence } = judgeResponse.substitution;
              if (kind === "model") {
                judgeSwitchTrigger ??= { job, substitution: evidence };
                judgeRetirement.abort();
              }
              throw new ProviderResponseError(
                `Judge response was substituted (${kind}): ${evidence}`,
                { status: 200, bodyExcerpt: evidence },
              );
            }
            return judgeResponse;
          } catch (error) {
            if (error instanceof ProviderConfigurationError) throw error;
            judgeFailureKind = "provider_error";
            if (error instanceof ProviderResponseError) {
              try {
                await job.recordAttempt(
                  {
                    outcome: "provider_error",
                    content: "",
                    usage: { inputTokens: 0, outputTokens: 0 },
                    costUsd: 0,
                    costIsEstimate: true,
                    errorDetail: {
                      status: error.status,
                      bodyExcerpt: error.bodyExcerpt,
                    },
                  },
                  judgeLogicalCallId,
                  judgeProviderId,
                );
              } catch (persistenceError) {
                judgePersistenceFailure = persistenceError;
                throw persistenceError;
              }
            }
            throw error;
          } finally {
            const spendId = randomUUID();
            try {
              await writeReplayFact(
                input.store,
                input.budget.projectId,
                spendId,
                spendEventSchema.parse({
                  actor: "judge",
                  phase:
                    job.cell.step.selectionStage ?? job.cell.step.corpusSplit,
                  costUsd: judgeResponse?.costUsd ?? 0,
                  provider: judgeProviderId,
                  reconcilableTo: {
                    executionId: job.executionId,
                    judgeModel: judge.judgeModel,
                    invocation: judgeInvocation,
                    costUnavailable: judgeResponse === undefined,
                    costIsEstimate: judgeResponse?.costIsEstimate ?? true,
                    usage: judgeResponse?.usage ?? null,
                  },
                }),
              );
              await reservation.refund(judgeResponse?.costUsd ?? 0);
            } catch (persistenceError) {
              judgePersistenceFailure = persistenceError;
              throw persistenceError;
            } finally {
              activeRefunds.delete(refundComplete);
              resolveRefund();
            }
          }
        },
        judgeModel: judge.judgeModel,
        supportsStructuredOutput: judge.supportsStructuredOutput,
        task: job.cell.recordedCase.task,
        reference:
          typeof job.cell.recordedCase.referenceOutput === "string"
            ? job.cell.recordedCase.referenceOutput
            : JSON.stringify(job.cell.recordedCase.referenceOutput),
        candidate: job.candidateOutput,
      });
      return { status: "success", assessment };
    } catch (error) {
      if (
        error instanceof ProviderConfigurationError ||
        isUsageLimit(error) ||
        judgePersistenceFailure !== undefined
      ) {
        throw error;
      }
      if (error instanceof BudgetRefusalError) {
        return { status: "blocked", message: error.message };
      }
      if (retirement.aborted && error === retirement.reason) {
        return { status: "failure", rateLimited: false };
      }
      await recordJudgeFailure(job, judge.judgeModel, judgeFailureKind, error);
      return {
        status: "failure",
        rateLimited:
          error instanceof BlockedError && error.kind === "rate-limit",
      };
    }
  }

  async function recordUnusableJudge(
    judge: (typeof judges)[number],
    nextJudge: (typeof judges)[number] | undefined,
    trigger: JudgeCell,
    consecutiveAssessments: number,
    substitution: string | undefined,
    rateLimited: boolean,
  ): Promise<void> {
    const cause =
      substitution === undefined
        ? " after three consecutive terminal failures"
        : `: it answered as another model (${substitution})`;
    input.judge!.warning?.(
      "judge_unusable",
      nextJudge === undefined
        ? `Judge ${judge.judgeModel} is unusable${cause}; no eligible fallback judge remains.`
        : `Judge ${judge.judgeModel} is unusable${cause}; switching to ${nextJudge.judgeModel}.`,
    );
    const noteId = randomUUID();
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      noteId,
      spendEventSchema.parse({
        actor: "judge",
        phase:
          trigger.cell.step.selectionStage ?? trigger.cell.step.corpusSplit,
        costUsd: 0,
        provider: judgeProviderId,
        reconcilableTo: {
          judgeModel: judge.judgeModel,
          judgeStatus: "unusable",
          ...(substitution === undefined
            ? rateLimited
              ? {
                  note: "rate_limited",
                  runId: input.budget.runId,
                  consecutiveAssessments,
                }
              : {
                  note: "three_consecutive_terminal_failures",
                  consecutiveAssessments,
                }
            : { note: "model_substituted", substitution }),
        },
      }),
    );
  }

  async function processJudgeCell(job: JudgeCell): Promise<void> {
    const judge = judges[activeJudgeIndex];
    if (judge === undefined) return;
    const outcome = await attemptJudge(job, judge);
    if (outcome.status === "success") {
      if (judgeSwitchTrigger === null) {
        judgeFailurePending = [];
        consecutiveJudgeFailures = 0;
        judgeStreakRateLimited = false;
      }
      await completeWithAssessment(job, outcome.assessment);
      return;
    }
    if (outcome.status === "blocked") {
      result.blocked.push({
        stepId: job.cell.step.stepId,
        caseId: job.cell.recordedCase.caseId,
        candidateId: job.cell.candidate.id,
        kind: "budget",
        message: outcome.message,
      });
      return;
    }
    judgeFailurePending.push(job);
    if (judgeSwitchTrigger !== null) return;
    consecutiveJudgeFailures += 1;
    if (outcome.rateLimited) judgeStreakRateLimited = true;
    if (consecutiveJudgeFailures >= 3)
      judgeSwitchTrigger = { job, rateLimited: judgeStreakRateLimited };
  }

  function startJudgeJob(work: () => Promise<void>): void {
    const job: Promise<void> = work()
      .catch((error: unknown) => {
        failure ??= error;
      })
      .then(() => {
        judgeJobs.delete(job);
        pumpJudges();
      });
    judgeJobs.add(job);
  }

  function pumpJudges(): void {
    if (failure !== undefined) return;
    if (judgeSwitchTrigger !== null) {
      if (judgeJobs.size > 0) return;
      const {
        job: trigger,
        substitution,
        rateLimited = false,
      } = judgeSwitchTrigger;
      const judge = judges[activeJudgeIndex]!;
      const nextJudge = judges[activeJudgeIndex + 1];
      const consecutiveAssessments = consecutiveJudgeFailures;
      judgeSwitchTrigger = null;
      activeJudgeIndex += 1;
      judgeRetirement = new AbortController();
      judgeQueue.unshift(...judgeFailurePending);
      judgeFailurePending = [];
      consecutiveJudgeFailures = 0;
      judgeStreakRateLimited = false;
      startJudgeJob(() =>
        recordUnusableJudge(
          judge,
          nextJudge,
          trigger,
          consecutiveAssessments,
          substitution,
          rateLimited,
        ),
      );
      return;
    }
    while (judgeJobs.size < JUDGE_CONCURRENCY) {
      const job = judgeQueue.shift();
      if (job === undefined) return;
      startJudgeJob(() => processJudgeCell(job));
    }
  }

  function attemptRecorder(cell: ReplayCell, executionId: string) {
    const logicalCallId = randomUUID();
    let actualCostUsd = 0;
    async function recordAttempt(
      attempt: ProviderAttempt,
      attemptLogicalCallId = logicalCallId,
      providerId = input.provider.providerId,
    ): Promise<void> {
      actualCostUsd += attempt.costUsd;
      const attemptId = mintAttemptId();
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        attemptId,
        requestAttemptSchema.parse({
          attemptId,
          logicalCallId: attemptLogicalCallId,
          executionId,
          streamOutcome: attempt.outcome,
          usage: attempt.usage,
          costUsd: attempt.costUsd,
          costIsEstimate: attempt.costIsEstimate,
          ...(attempt.errorDetail === undefined
            ? {}
            : { errorDetail: attempt.errorDetail }),
          ...(attempt.providerResponseId === undefined
            ? {}
            : { providerResponseId: attempt.providerResponseId }),
          ...(attempt.finishReason === undefined
            ? {}
            : { finishReason: attempt.finishReason }),
          ...(attempt.latencyMs === undefined
            ? {}
            : { latencyMs: attempt.latencyMs }),
          ...(attempt.servedModel === undefined
            ? {}
            : { servedModel: attempt.servedModel }),
          ...(attempt.substitution === undefined
            ? {}
            : { substitution: attempt.substitution }),
        }),
      );
      const spendId = randomUUID();
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        spendId,
        spendEventSchema.parse({
          actor: "replay-driver",
          phase: cell.step.selectionStage ?? cell.step.corpusSplit,
          costUsd: attempt.costUsd,
          provider: providerId,
          reconcilableTo: {
            attemptId,
            logicalCallId: attemptLogicalCallId,
            executionId,
            candidateId: cell.candidate.id,
            costIsEstimate: attempt.costIsEstimate,
          },
        }),
      );
    }
    return { recordAttempt, actualCost: () => actualCostUsd };
  }

  async function runCell(cell: ReplayCell): Promise<void> {
    const key = replayCorrelationKey(
      cell.step.evidenceQuestionId,
      cell.recordedCase.caseId,
      cell.candidate.id,
    );
    if (existing.has(key)) {
      result.skipped += 1;
      const pending = replayState.unassessed.get(key);
      if (pending !== undefined && input.judge !== undefined) {
        judgeQueue.push({
          cell,
          executionId: pending.executionId,
          candidateOutput: pending.candidateOutput,
          recordAttempt: attemptRecorder(cell, pending.executionId)
            .recordAttempt,
        });
        pumpJudges();
      }
      return;
    }

    if (cell.candidate.pricing === null) {
      throw new ProviderConfigurationError(
        `Candidate has no pricing: ${cell.candidate.id}`,
      );
    }
    let reservation: BudgetReservation;
    try {
      reservation = await reserveWhenFree(
        input.budget,
        {
          contextTokens: cell.recordedCase.contextTokens,
          maxOutputTokens: cell.recordedCase.maxOutputTokens,
          pricing: cell.candidate.pricing,
        },
        activeRefunds,
      );
    } catch (error) {
      if (error instanceof BudgetRefusalError) {
        result.blocked.push({
          stepId: cell.step.stepId,
          caseId: cell.recordedCase.caseId,
          candidateId: cell.candidate.id,
          kind: "budget",
          message: error.message,
        });
        return;
      }
      throw error;
    }

    let resolveRefund = (): void => undefined;
    const refundComplete = new Promise<void>((resolve) => {
      resolveRefund = resolve;
    });
    activeRefunds.add(refundComplete);
    let heartbeatFailure: unknown;
    let heartbeatWork: Promise<void> = Promise.resolve();
    const heartbeatTimer = setInterval(() => {
      heartbeatWork = heartbeatWork
        .then(() => reservation.heartbeat())
        .catch((error: unknown) => {
          heartbeatFailure ??= error;
        });
    }, BUDGET_HEARTBEAT_INTERVAL_MS);

    const executionId = mintExecutionId();
    const recorder = attemptRecorder(cell, executionId);
    try {
      let response;
      try {
        response = await input.provider.chat({
          model: cell.candidate.id,
          messages: toWireMessages(
            cell.recordedCase.messages,
            cell.recordedCase.system,
          ),
          temperature: cell.recordedCase.temperature,
          maxOutputTokens: cell.recordedCase.maxOutputTokens,
          estimatedInputTokens: cell.recordedCase.contextTokens,
          tools: cell.recordedCase.tools,
          toolChoice: cell.recordedCase.toolChoice,
          responseFormat: cell.recordedCase.responseFormat,
          headers: cell.recordedCase.headers,
          onAttempt: recorder.recordAttempt,
        });
      } catch (error) {
        if (error instanceof ProviderConfigurationError) throw error;
        if (error instanceof BlockedError) {
          if (error.kind !== "rate-limit" || error.observedCeiling === null) {
            throw error;
          }
          result.blocked.push({
            stepId: cell.step.stepId,
            caseId: cell.recordedCase.caseId,
            candidateId: cell.candidate.id,
            kind: error.kind,
            message: error.message,
            observedCeiling: error.observedCeiling,
          });
          return;
        }
        if (error instanceof ProviderRequestError) {
          await writeReplayFact(
            input.store,
            input.budget.projectId,
            executionId,
            executionSchema.parse({
              executionId,
              evidenceQuestionId: cell.step.evidenceQuestionId,
              caseId: cell.recordedCase.caseId,
              stepId: cell.step.stepId,
              candidateId: cell.candidate.id,
              trajectoryId: cell.recordedCase.trajectoryId,
              corpusSplit: cell.recordedCase.corpusSplit,
              selectionStage: cell.step.selectionStage ?? cell.step.corpusSplit,
              terminalOutcome: "failure",
              finalOutput: null,
              attribution: "lost",
            }),
          );
          result.completed += 1;
          return;
        }
        throw error;
      }
      if (heartbeatFailure !== undefined) throw heartbeatFailure;

      const { substitution } = response;
      if (substitution !== undefined) {
        await writeReplayFact(
          input.store,
          input.budget.projectId,
          executionId,
          executionSchema.parse({
            executionId,
            evidenceQuestionId: cell.step.evidenceQuestionId,
            caseId: cell.recordedCase.caseId,
            stepId: cell.step.stepId,
            candidateId: cell.candidate.id,
            trajectoryId: cell.recordedCase.trajectoryId,
            corpusSplit: cell.recordedCase.corpusSplit,
            selectionStage: cell.step.selectionStage ?? cell.step.corpusSplit,
            terminalOutcome: "abstain",
            finalOutput: response.content,
            attribution: "substituted",
          }),
        );
        result.substituted.push({
          candidateId: cell.candidate.id,
          substitution,
        });
        result.completed += 1;
        return;
      }
      const silentFailure =
        response.content.trim().length === 0 &&
        response.usage.outputTokens === 0;
      const execution = executionSchema.parse({
        executionId,
        evidenceQuestionId: cell.step.evidenceQuestionId,
        caseId: cell.recordedCase.caseId,
        stepId: cell.step.stepId,
        candidateId: cell.candidate.id,
        trajectoryId: cell.recordedCase.trajectoryId,
        corpusSplit: cell.recordedCase.corpusSplit,
        selectionStage: cell.step.selectionStage ?? cell.step.corpusSplit,
        terminalOutcome: silentFailure ? "failure" : "success",
        finalOutput: response.content,
        attribution: silentFailure ? "silent-failure" : "ok",
      });
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        executionId,
        execution,
      );
      result.completed += 1;
      if (silentFailure || input.judge === undefined) return;
      judgeQueue.push({
        cell,
        executionId,
        candidateOutput: response.content,
        recordAttempt: recorder.recordAttempt,
      });
      pumpJudges();
    } finally {
      try {
        clearInterval(heartbeatTimer);
        await heartbeatWork;
        await reservation.refund(recorder.actualCost());
      } finally {
        activeRefunds.delete(refundComplete);
        resolveRefund();
      }
    }
  }

  async function worker(): Promise<void> {
    while (failure === undefined) {
      const index = nextCell;
      nextCell += 1;
      const cell = cells[index];
      if (cell === undefined) return;
      try {
        await runCell(cell);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(input.concurrency, Math.max(1, cells.length)) },
      () => worker(),
    ),
  );
  while (judgeJobs.size > 0) await Promise.all(judgeJobs);
  if (failure !== undefined) throw failure;
  return result;
}
