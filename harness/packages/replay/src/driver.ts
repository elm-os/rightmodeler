import { randomUUID } from "node:crypto";

import {
  assessmentSchema,
  executionSchema,
  factKey,
  factsPrefix,
  factSchema,
  jsonValueSchema,
  mintAssessmentId,
  mintAttemptId,
  mintExecutionId,
  requestAttemptSchema,
  type Fact,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";

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
  type ProviderClient,
} from "./provider.js";
import type { ReplayStep, StepShortlist } from "./shortlist.js";

export interface RecordedCase {
  caseId: string;
  stepId: string;
  trajectoryId: string;
  corpusSplit: string;
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

export interface JudgeChatRequest {
  messages: readonly ChatMessage[];
  temperature: number;
  stream: false;
}

export interface JudgeChatResponse {
  content: string;
}

export type JudgeChat = (
  request: JudgeChatRequest,
) => Promise<JudgeChatResponse>;

export interface ReplayModeAInput {
  steps: readonly ReplayStep[];
  cases: readonly RecordedCase[];
  candidates: readonly StepShortlist[];
  provider: ProviderClient;
  judgeChat: JudgeChat;
  store: Store;
  budget: Budget;
  concurrency: number;
}

export interface BlockedCell {
  stepId: string;
  caseId: string;
  candidateId: string;
  kind: "rate-limit" | "budget";
  message: string;
}

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

interface JudgeAssessment {
  evaluatorId: string;
  metricName: string;
  score: number;
  passed: boolean;
  rubricVersion: string;
  artifactRef: JsonValue;
}

function correlationKey(
  evidenceQuestionId: string,
  caseId: string,
  candidateId: string,
): string {
  return JSON.stringify([evidenceQuestionId, caseId, candidateId]);
}

async function writeFact(
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

async function terminalCells(
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
        correlationKey(
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

function parseJudgeAssessment(content: string): JudgeAssessment {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Judge response was not valid JSON: ${message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Judge response must be an object");
  }
  const assessment = value as Record<string, unknown>;
  if (
    typeof assessment.evaluatorId !== "string" ||
    assessment.evaluatorId.length === 0 ||
    typeof assessment.metricName !== "string" ||
    assessment.metricName.length === 0 ||
    typeof assessment.score !== "number" ||
    !Number.isFinite(assessment.score) ||
    typeof assessment.passed !== "boolean" ||
    typeof assessment.rubricVersion !== "string" ||
    assessment.rubricVersion.length === 0
  ) {
    throw new Error("Judge response is missing required assessment fields");
  }
  return {
    evaluatorId: assessment.evaluatorId,
    metricName: assessment.metricName,
    score: assessment.score,
    passed: assessment.passed,
    rubricVersion: assessment.rubricVersion,
    artifactRef: jsonValueSchema.parse(assessment.artifactRef),
  };
}

async function assess(
  judgeChat: JudgeChat,
  recordedCase: RecordedCase,
  candidateOutput: string,
): Promise<JudgeAssessment> {
  const response = await judgeChat({
    messages: [
      {
        role: "system",
        content:
          "Compare the candidate output with the accepted reference. Return only JSON with evaluatorId, metricName, score, passed, rubricVersion, and artifactRef.",
      },
      {
        role: "user",
        content: JSON.stringify({
          referenceOutput: recordedCase.referenceOutput,
          candidateOutput,
        }),
      },
    ],
    temperature: 0,
    stream: false,
  });
  return parseJudgeAssessment(response.content);
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
  const existing = await terminalCells(input.store, input.budget.projectId);
  const cells = cellsFor(input);
  const result: ReplayModeAResult = { completed: 0, skipped: 0, blocked: [] };
  let nextCell = 0;

  async function runCell(cell: ReplayCell): Promise<void> {
    const key = correlationKey(
      cell.step.evidenceQuestionId,
      cell.recordedCase.caseId,
      cell.candidate.id,
    );
    if (existing.has(key)) {
      result.skipped += 1;
      return;
    }

    let reservation: BudgetReservation;
    try {
      reservation = await input.budget.reserveExecution({
        contextTokens: cell.recordedCase.contextTokens,
        maxOutputTokens: cell.recordedCase.maxOutputTokens,
        pricing: cell.candidate.pricing,
      });
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

    const executionId = mintExecutionId();
    const logicalCallId = randomUUID();
    let actualCostUsd = 0;
    let attemptWriteError: unknown;
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
            try {
              const attemptId = mintAttemptId();
              await writeFact(
                input.store,
                input.budget.projectId,
                attemptId,
                requestAttemptSchema.parse({
                  attemptId,
                  logicalCallId,
                  executionId,
                  streamOutcome:
                    attempt.outcome === "completed"
                      ? "completed"
                      : "provider_error",
                  usage: attempt.usage,
                  costUsd: attempt.costUsd,
                  costIsEstimate: attempt.costIsEstimate,
                }),
              );
            } catch (error) {
              attemptWriteError = error;
              throw error;
            }
          },
        });
        actualCostUsd = response.costUsd;
      } catch (error) {
        if (error === attemptWriteError) throw error;
        if (error instanceof ProviderConfigurationError) throw error;
        if (error instanceof BlockedError) {
          result.blocked.push({
            stepId: cell.step.stepId,
            caseId: cell.recordedCase.caseId,
            candidateId: cell.candidate.id,
            kind: error.kind,
            message: error.message,
          });
          return;
        }
        await writeFact(
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
            selectionStage: cell.step.selectionStage ?? "shortlist",
            terminalOutcome: "failure",
            finalOutput: null,
            attribution: "ok",
          }),
        );
        result.completed += 1;
        return;
      }

      const silentFailure =
        response.content.length === 0 || response.usage.outputTokens === 0;
      await writeFact(
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
          selectionStage: cell.step.selectionStage ?? "shortlist",
          terminalOutcome: silentFailure ? "failure" : "success",
          finalOutput: response.content,
          attribution: silentFailure ? "silent-failure" : "ok",
        }),
      );
      result.completed += 1;
      if (silentFailure) return;

      const judged = await assess(
        input.judgeChat,
        cell.recordedCase,
        response.content,
      );
      const assessmentId = mintAssessmentId();
      await writeFact(
        input.store,
        input.budget.projectId,
        assessmentId,
        assessmentSchema.parse({
          assessmentId,
          executionId,
          ...judged,
        }),
      );
    } finally {
      await reservation.refund(actualCostUsd);
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
