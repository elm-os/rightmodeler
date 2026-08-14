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
  messages: readonly ChatMessage[];
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
    judgeModel: string;
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

export async function terminalReplayCells(
  store: Store,
  projectId: string,
): Promise<Set<string>> {
  const completed = new Set<string>();
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
  }
  return completed;
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

function replayMessages(recordedCase: RecordedCase): ChatMessage[] {
  return recordedCase.system === undefined
    ? [...recordedCase.messages]
    : [
        { role: "system", content: recordedCase.system },
        ...recordedCase.messages,
      ];
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
  const existing = await terminalReplayCells(
    input.store,
    input.budget.projectId,
  );
  const cells = cellsFor(input);
  const result: ReplayModeAResult = { completed: 0, skipped: 0, blocked: [] };
  const activeRefunds = new Set<Promise<void>>();
  let nextCell = 0;

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
    try {
      let response;
      try {
        response = await input.provider.chat({
          model: cell.candidate.id,
          messages: replayMessages(cell.recordedCase),
          temperature: cell.recordedCase.temperature,
          maxOutputTokens: cell.recordedCase.maxOutputTokens,
          tools: cell.recordedCase.tools,
          toolChoice: cell.recordedCase.toolChoice,
          responseFormat: cell.recordedCase.responseFormat,
          headers: cell.recordedCase.headers,
          onAttempt: async (attempt) => {
            actualCostUsd += attempt.costUsd;
            const attemptId = mintAttemptId();
            await writeReplayFact(
              input.store,
              input.budget.projectId,
              attemptId,
              requestAttemptSchema.parse({
                attemptId,
                logicalCallId,
                executionId,
                streamOutcome: attempt.outcome,
                usage: attempt.usage,
                costUsd: attempt.costUsd,
                costIsEstimate: attempt.costIsEstimate,
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
                  logicalCallId,
                  executionId,
                  candidateId: cell.candidate.id,
                  costIsEstimate: attempt.costIsEstimate,
                },
              }),
            );
          },
        });
      } catch (error) {
        if (error instanceof ProviderConfigurationError) throw error;
        if (error instanceof BlockedError) {
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
        response.content.length === 0 || response.usage.outputTokens === 0;
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
      const judge = input.judge;

      let judgeInvocation = 0;
      const judged = await judgeExecution({
        chat: async (request) => {
          judgeInvocation += 1;
          try {
            return await judge.chat(request);
          } finally {
            const spendId = randomUUID();
            await writeReplayFact(
              input.store,
              input.budget.projectId,
              spendId,
              spendEventSchema.parse({
                actor: "judge",
                phase: cell.step.selectionStage ?? cell.step.corpusSplit,
                costUsd: 0,
                provider: input.provider.providerId,
                reconcilableTo: {
                  executionId,
                  judgeModel: judge.judgeModel,
                  invocation: judgeInvocation,
                  costUnavailable: true,
                },
              }),
            );
          }
        },
        judgeModel: judge.judgeModel,
        task: cell.recordedCase.task,
        reference:
          typeof cell.recordedCase.referenceOutput === "string"
            ? cell.recordedCase.referenceOutput
            : JSON.stringify(cell.recordedCase.referenceOutput),
        candidate: response.content,
      });
      const assessmentId = mintAssessmentId();
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        assessmentId,
        assessmentSchema.parse({
          assessmentId,
          executionId,
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
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        executionId,
        execution,
      );
      result.completed += 1;
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
  return result;
}
