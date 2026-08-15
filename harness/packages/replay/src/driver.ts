import { randomUUID } from "node:crypto";

import {
  assessmentSchema,
  executionSchema,
  factKey,
  factsPrefix,
  factSchema,
  mintAssessmentId,
  mintAttemptId,
  mintExecutionId,
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
} from "@rightmodeler/kernel";

import {
  BudgetRefusalError,
  type Budget,
  type BudgetReservation,
} from "./budget.js";
import {
  BlockedError,
  type ChatMessage,
  type ModelCatalogEntry,
  ProviderConfigurationError,
  ProviderRequestError,
  ProviderResponseError,
  type ProviderAttempt,
  type ProviderClient,
} from "./provider.js";
import type { ReplayStep, StepShortlist } from "./shortlist.js";

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
    }[];
    warning?: (code: string, message: string) => void;
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
}

interface ReplayCell {
  step: ReplayStep;
  recordedCase: RecordedCase;
  candidate: ModelCatalogEntry;
}

interface JudgeCell {
  readonly cell: ReplayCell;
  readonly executionId: string;
  readonly execution: Execution;
  readonly candidateOutput: string;
  readonly recordAttempt: (
    attempt: ProviderAttempt,
    logicalCallId?: ReturnType<typeof randomUUID>,
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
): Promise<{
  readonly completed: Set<string>;
  readonly unusableJudges: Set<string>;
}> {
  const completed = new Set<string>();
  const unusableJudges = new Set<string>();
  for (const key of await store.list(factsPrefix(projectId))) {
    const entry = await store.get(key);
    if (entry === null) throw new Error(`Listed fact is missing: ${key}`);
    const fact = factSchema.parse(
      JSON.parse(Buffer.from(entry.body).toString("utf8")),
    );
    const execution = executionSchema.safeParse(fact);
    if (execution.success) {
      completed.add(
        replayCorrelationKey(
          execution.data.evidenceQuestionId,
          execution.data.caseId,
          execution.data.candidateId,
        ),
      );
    }
    if (
      "actor" in fact &&
      fact.actor === "judge" &&
      typeof fact.reconcilableTo === "object" &&
      fact.reconcilableTo !== null &&
      !Array.isArray(fact.reconcilableTo) &&
      fact.reconcilableTo.judgeStatus === "unusable" &&
      typeof fact.reconcilableTo.judgeModel === "string"
    ) {
      unusableJudges.add(fact.reconcilableTo.judgeModel);
    }
  }
  return { completed, unusableJudges };
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
  );
  const existing = replayState.completed;
  const cells = cellsFor(input);
  const result: ReplayModeAResult = { completed: 0, skipped: 0, blocked: [] };
  const activeRefunds = new Set<Promise<void>>();
  let nextCell = 0;
  const judges = input.judge?.rankedModels.slice(0, 2) ?? [];
  if (input.judge !== undefined && judges.length === 0) {
    throw new Error("At least one ranked judge model is required");
  }
  const unusableJudges = replayState.unusableJudges;
  const firstUsableJudge = judges.findIndex(
    ({ judgeModel }) => !unusableJudges.has(judgeModel),
  );
  let activeJudgeIndex =
    firstUsableJudge === -1 ? judges.length : firstUsableJudge;
  let consecutiveJudgeFailures = 0;
  let judgeFailurePending: JudgeCell[] = [];
  let judgeQueue = Promise.resolve();

  async function completeWithoutAssessment(job: JudgeCell): Promise<void> {
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      job.executionId,
      job.execution,
    );
    result.completed += 1;
  }

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
          orderConsistent: judged.orderConsistent,
        },
      }),
    );
    await completeWithoutAssessment(job);
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
        provider: input.provider.providerId,
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
    | {
        readonly status: "failure";
      }
  > {
    let judgeInvocation = 0;
    let judgeFailureKind: "response_malformed" | "provider_error" =
      "response_malformed";
    let judgePersistenceFailure: unknown;
    try {
      const assessment = await judgeExecution({
        chat: async (request) => {
          judgeInvocation += 1;
          const judgeLogicalCallId = randomUUID();
          try {
            return await input.judge!.chat(request);
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
                  costUsd: 0,
                  provider: input.provider.providerId,
                  reconcilableTo: {
                    executionId: job.executionId,
                    judgeModel: judge.judgeModel,
                    invocation: judgeInvocation,
                    costUnavailable: true,
                  },
                }),
              );
            } catch (persistenceError) {
              judgePersistenceFailure = persistenceError;
              throw persistenceError;
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
        judgePersistenceFailure !== undefined
      ) {
        throw error;
      }
      await recordJudgeFailure(job, judge.judgeModel, judgeFailureKind, error);
      return { status: "failure" };
    }
  }

  async function flushJudgeFailurePending(): Promise<void> {
    const pending = judgeFailurePending;
    judgeFailurePending = [];
    consecutiveJudgeFailures = 0;
    for (const job of pending) await completeWithoutAssessment(job);
  }

  async function processJudgeCell(job: JudgeCell): Promise<void> {
    const judge = judges[activeJudgeIndex];
    if (judge === undefined) {
      await completeWithoutAssessment(job);
      return;
    }
    const outcome = await attemptJudge(job, judge);
    if (outcome.status === "success") {
      await flushJudgeFailurePending();
      await completeWithAssessment(job, outcome.assessment);
      return;
    }

    judgeFailurePending.push(job);
    consecutiveJudgeFailures += 1;
    if (consecutiveJudgeFailures < 3) return;

    const nextJudge = judges[activeJudgeIndex + 1];
    input.judge!.warning?.(
      "judge_unusable",
      nextJudge === undefined
        ? `Judge ${judge.judgeModel} is unusable after three consecutive terminal failures; no eligible fallback judge remains.`
        : `Judge ${judge.judgeModel} is unusable after three consecutive terminal failures; switching to ${nextJudge.judgeModel}.`,
    );
    const noteId = randomUUID();
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      noteId,
      spendEventSchema.parse({
        actor: "judge",
        phase: job.cell.step.selectionStage ?? job.cell.step.corpusSplit,
        costUsd: 0,
        provider: input.provider.providerId,
        reconcilableTo: {
          judgeModel: judge.judgeModel,
          judgeStatus: "unusable",
          note: "three_consecutive_terminal_failures",
          consecutiveAssessments: consecutiveJudgeFailures,
        },
      }),
    );

    const affected = judgeFailurePending;
    judgeFailurePending = [];
    consecutiveJudgeFailures = 0;
    activeJudgeIndex += 1;
    for (const pending of affected) await processJudgeCell(pending);
  }

  async function scheduleJudgeCell(job: JudgeCell): Promise<void> {
    const scheduled = judgeQueue.then(() => processJudgeCell(job));
    judgeQueue = scheduled.catch(() => undefined);
    await scheduled;
  }

  async function runCell(cell: ReplayCell): Promise<void> {
    const key = replayCorrelationKey(
      cell.step.evidenceQuestionId,
      cell.recordedCase.caseId,
      cell.candidate.id,
    );
    if (existing.has(key)) {
      result.skipped += 1;
      return;
    }

    if (cell.candidate.pricing === null) {
      throw new ProviderConfigurationError(
        `Candidate has no pricing: ${cell.candidate.id}`,
      );
    }
    let reservation: BudgetReservation;
    for (;;) {
      try {
        reservation = await input.budget.reserveExecution({
          contextTokens: cell.recordedCase.contextTokens,
          maxOutputTokens: cell.recordedCase.maxOutputTokens,
          pricing: cell.candidate.pricing,
        });
        break;
      } catch (error) {
        if (error instanceof BudgetRefusalError && error.causedByReservations) {
          const refunds = [...activeRefunds];
          if (refunds.length > 0) {
            await Promise.race(refunds);
          } else {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          continue;
        }
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
    }

    let resolveRefund = (): void => undefined;
    const refundComplete = new Promise<void>((resolve) => {
      resolveRefund = resolve;
    });
    activeRefunds.add(refundComplete);

    const executionId = mintExecutionId();
    const logicalCallId = randomUUID();
    let actualCostUsd = 0;
    async function recordAttempt(
      attempt: ProviderAttempt,
      attemptLogicalCallId = logicalCallId,
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
          provider: input.provider.providerId,
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
          onAttempt: recordAttempt,
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
      if (silentFailure || input.judge === undefined) {
        await writeReplayFact(
          input.store,
          input.budget.projectId,
          executionId,
          execution,
        );
        result.completed += 1;
        return;
      }
      await scheduleJudgeCell({
        cell,
        executionId,
        execution,
        candidateOutput: response.content,
        recordAttempt,
      });
    } finally {
      try {
        await reservation.refund(actualCostUsd);
      } finally {
        activeRefunds.delete(refundComplete);
        resolveRefund();
      }
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextCell;
      nextCell += 1;
      const cell = cells[index];
      if (cell === undefined) return;
      await runCell(cell);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(input.concurrency, Math.max(1, cells.length)) },
      () => worker(),
    ),
  );
  await judgeQueue;
  await flushJudgeFailurePending();
  return result;
}
