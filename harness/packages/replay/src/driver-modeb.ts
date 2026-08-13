import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  executionSchema,
  factKey,
  requestAttemptSchema,
  spendEventSchema,
  type Execution,
  type JsonValue,
  type Store,
} from "@rightmodeler/core";
import {
  SCRATCH_CONTAINER_PATH,
  type DockerCollectResult,
  type DockerExecutor,
  type DockerStatus,
} from "@rightmodeler/executor";

import {
  BudgetRefusalError,
  type Budget,
  type BudgetReservation,
} from "./budget.js";
import {
  replayCorrelationKey,
  terminalReplayCells,
  writeReplayFact,
  type BlockedCell,
  type RecordedCase,
} from "./driver.js";
import type { ModelCatalogEntry, ModelPricing } from "./provider.js";
import {
  startEgressListener,
  type EgressListener,
  type EgressListenerOptions,
} from "./proxy/egress.js";
import type { ReplayStep } from "./shortlist.js";

const APP_CONTAINER_PATH = "/rightmodeler/app";
const RUNTIME_CONTAINER_PATH = "/rightmodeler/runtime";
const CASE_CONTAINER_PATH = `${SCRATCH_CONTAINER_PATH}/driver/case.json`;
const CONFIG_CONTAINER_PATH = `${SCRATCH_CONTAINER_PATH}/driver/config.json`;
const PROXY_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 60_000;
const BUDGET_HEARTBEAT_INTERVAL_MS = 30_000;
const COLLECTION_NAMESPACES = ["driver", "workload", "proxy"] as const;
const STREAM_OUTCOMES = new Set([
  "completed",
  "provider_error",
  "client_cancelled",
  "truncated",
]);

export interface ModeBCase extends RecordedCase {
  readonly input: JsonValue;
}

export type ModeBSwapPolicy = Readonly<Record<string, string>>;

export interface ModeBAppSpec {
  /** Host application directory, mounted read-only at /rightmodeler/app. */
  readonly mountPath: string;
  /** Receives /rightmodeler/scratch/driver/case.json inside the container. */
  readonly command: (caseFile: string) => readonly string[];
  readonly installCommand?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ModeBEgress extends EgressListenerOptions {
  readonly providerId: string;
  readonly catalog: readonly ModelCatalogEntry[];
}

export interface ReplayModeBInput {
  readonly stepRecords: readonly ReplayStep[];
  readonly cases: readonly ModeBCase[];
  readonly swapPolicy: ModeBSwapPolicy;
  readonly executor: DockerExecutor;
  readonly egress: ModeBEgress;
  readonly store: Store;
  readonly budget: Budget;
  readonly image: string;
  readonly appSpec: ModeBAppSpec;
  readonly concurrency: number;
}

export interface ReplayModeBResult {
  completed: number;
  skipped: number;
  blocked: BlockedCell[];
  rejectedRows: number;
  executions: Execution[];
}

interface ModeBCell {
  recordedCase: ModeBCase;
  executionStep: ReplayStep;
  candidateId: string;
  correlationKey: string;
}

interface ValidUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ValidAttemptRow {
  attemptId: string;
  logicalCallId: string;
  executionId: string;
  stepId: string;
  model: string;
  streamOutcome:
    "completed" | "provider_error" | "client_cancelled" | "truncated";
  usage: ValidUsage | null;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  attemptGroup: number;
  upstreamStatus: number | null;
  upstreamSource: "provider" | "egress" | null;
  costUsd: number;
}

interface ValidReservationRow {
  attemptId: string;
  logicalCallId: string;
  executionId: string;
  stepId: string;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  attemptGroup: number;
  reservedUsd: number;
}

interface TerminalEnvelope {
  finalOutput: JsonValue;
}

interface DriverStatus {
  phase: "install" | "proxy" | "workload";
  code?: number | null;
  signal?: string | null;
  error?: string;
}

interface CheckpointIndex {
  count: number;
  rejectedRows: number;
  terminalGroup: number | null;
  pairs: ReadonlySet<string>;
}

interface CollectedInspection {
  attempts: ValidAttemptRow[];
  reservations: ValidReservationRow[];
  blockedRows: number;
  lostRows: number;
  checkpointRows: number;
  terminalGroup: number | null;
  terminalEnvelope: TerminalEnvelope | null;
  driverStatus: DriverStatus | null;
  rejectedRows: number;
  collectionFailed: boolean;
}

interface ContainerResult {
  inspection: CollectedInspection;
  status: DockerStatus | null;
  lifecycleFailed: boolean;
}

interface ReservationWaiter {
  promise: Promise<void>;
  resolve(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  return nonemptyString(value) && !Number.isNaN(Date.parse(value));
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-9);
}

function validateInput(input: ReplayModeBInput): void {
  if (!positiveInteger(input.concurrency)) {
    throw new Error("concurrency must be a positive integer");
  }
  if (input.store !== input.budget.store) {
    throw new Error("Replay store must match the budget store");
  }
  if (input.image.length === 0) throw new Error("image must not be empty");
  if (input.appSpec.mountPath.length === 0) {
    throw new Error("appSpec.mountPath must not be empty");
  }
  const timeoutMs = input.appSpec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!positiveInteger(timeoutMs)) {
    throw new Error("appSpec.timeoutMs must be a positive integer");
  }
  if (
    input.appSpec.installCommand !== undefined &&
    input.appSpec.installCommand.length === 0
  ) {
    throw new Error("appSpec.installCommand must not be empty");
  }
  if (input.egress.providerId.length === 0) {
    throw new Error("egress.providerId must not be empty");
  }
}

function normalizedSwapPolicy(
  policy: ModeBSwapPolicy,
  steps: ReadonlyMap<string, ReplayStep>,
): ModeBSwapPolicy {
  if (!isRecord(policy)) throw new Error("swapPolicy must be an object");
  const normalized: Record<string, string> = {};
  for (const [stepId, model] of Object.entries(policy)) {
    if (!nonemptyString(stepId) || !nonemptyString(model)) {
      throw new Error("swapPolicy must map non-empty step ids to model ids");
    }
    if (!steps.has(stepId)) {
      throw new Error(`Swap policy references an unknown step: ${stepId}`);
    }
    normalized[stepId] = model;
  }
  if (Object.keys(normalized).length === 0) {
    throw new Error("swapPolicy must contain at least one replacement");
  }
  return normalized;
}

function stepMap(
  steps: readonly ReplayStep[],
): ReadonlyMap<string, ReplayStep> {
  const records = new Map<string, ReplayStep>();
  for (const step of steps) {
    if (records.has(step.stepId)) {
      throw new Error(`Duplicate step record: ${step.stepId}`);
    }
    records.set(step.stepId, step);
  }
  return records;
}

function candidateId(policy: ModeBSwapPolicy): string {
  const entries = Object.entries(policy).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 1
    ? entries[0]![1]
    : JSON.stringify(Object.fromEntries(entries));
}

function cellsFor(
  input: ReplayModeBInput,
  steps: ReadonlyMap<string, ReplayStep>,
  policy: ModeBSwapPolicy,
): ModeBCell[] {
  const selectedCandidateId = candidateId(policy);
  const seenCaseIds = new Set<string>();
  const seenCells = new Set<string>();
  return input.cases.map((recordedCase) => {
    if (seenCaseIds.has(recordedCase.caseId)) {
      throw new Error(`Duplicate case id: ${recordedCase.caseId}`);
    }
    seenCaseIds.add(recordedCase.caseId);
    const executionStep = steps.get(recordedCase.stepId);
    if (executionStep === undefined) {
      throw new Error(`Missing execution step record: ${recordedCase.stepId}`);
    }
    const correlationKey = replayCorrelationKey(
      executionStep.evidenceQuestionId,
      recordedCase.caseId,
      selectedCandidateId,
    );
    if (seenCells.has(correlationKey)) {
      throw new Error(`Duplicate Mode B replay cell: ${correlationKey}`);
    }
    seenCells.add(correlationKey);
    return {
      recordedCase,
      executionStep,
      candidateId: selectedCandidateId,
      correlationKey,
    };
  });
}

function pricingTable(
  catalog: readonly ModelCatalogEntry[],
): Readonly<Record<string, ModelPricing>> {
  const table: Record<string, ModelPricing> = {};
  for (const model of catalog) {
    if (model.id.length === 0) throw new Error("Catalog model id is empty");
    if (Object.hasOwn(table, model.id)) {
      throw new Error(`Duplicate catalog model: ${model.id}`);
    }
    if (model.pricing === null) continue;
    if (
      !nonnegativeNumber(model.pricing.input) ||
      !nonnegativeNumber(model.pricing.output)
    ) {
      throw new Error(`Pricing is invalid for model: ${model.id}`);
    }
    table[model.id] = model.pricing;
  }
  return table;
}

function expectedModel(step: ReplayStep, policy: ModeBSwapPolicy): string {
  const model = policy[step.stepId] ?? step.currentModel;
  if (model === null) throw new Error(`Step has no model: ${step.stepId}`);
  return model;
}

function validatePricing(
  steps: readonly ReplayStep[],
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
): void {
  for (const step of steps) {
    const model = expectedModel(step, policy);
    if (table[model] === undefined) {
      throw new Error(`Pricing is unavailable for model: ${model}`);
    }
  }
}

function createWaiter(): ReservationWaiter {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function reserveCase(
  input: ReplayModeBInput,
  activeRefunds: Set<Promise<void>>,
): Promise<BudgetReservation | null> {
  for (;;) {
    const state = await input.budget.state();
    const availableUsd =
      state.authorizedTotalUsd === undefined
        ? 0
        : Math.max(
            0,
            state.authorizedTotalUsd - state.spentUsd - state.reservedUsd,
          );
    if (
      state.authorizedTotalUsd !== undefined &&
      availableUsd === 0 &&
      activeRefunds.size > 0
    ) {
      await Promise.race(activeRefunds);
      continue;
    }
    try {
      return await input.budget.reserveExecution({
        contextTokens: 1,
        maxOutputTokens: 0,
        pricing: { input: availableUsd, output: 0 },
      });
    } catch (error) {
      if (!(error instanceof BudgetRefusalError)) throw error;
      if (!error.causedByReservations || activeRefunds.size === 0) return null;
      await Promise.race(activeRefunds);
    }
  }
}

function replayRuntimeRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return moduleDirectory.endsWith(`${join("replay", "dist")}`)
    ? moduleDirectory
    : resolve(moduleDirectory, "../dist");
}

async function prepareScratch(
  root: string,
  cell: ModeBCell,
  executionId: string,
  appSpec: ModeBAppSpec,
): Promise<string> {
  const command = appSpec.command(CASE_CONTAINER_PATH);
  if (command.length === 0) {
    throw new Error("appSpec.command must not be empty");
  }
  const scratch = join(root, executionId);
  await mkdir(join(scratch, "driver"), { recursive: true });
  await writeFile(
    join(scratch, "driver", "case.json"),
    `${JSON.stringify({
      caseId: cell.recordedCase.caseId,
      input: cell.recordedCase.input,
      ...(cell.recordedCase.headers === undefined
        ? {}
        : { headers: cell.recordedCase.headers }),
    })}\n`,
    "utf8",
  );
  await writeFile(
    join(scratch, "driver", "config.json"),
    `${JSON.stringify({
      command,
      ...(appSpec.installCommand === undefined
        ? {}
        : { installCommand: appSpec.installCommand }),
    })}\n`,
    "utf8",
  );
  return scratch;
}

function launchCase(
  input: ReplayModeBInput,
  listener: EgressListener,
  cell: ModeBCell,
  executionId: string,
  scratchHostPath: string,
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
  leaseUsd: number,
  resume: boolean,
): Promise<string> {
  return input.executor.launch({
    image: input.image,
    command: [
      "node",
      `${RUNTIME_CONTAINER_PATH}/proxy/container-supervisor.mjs`,
      CONFIG_CONTAINER_PATH,
    ],
    env: {
      OPENAI_API_KEY: "container-placeholder",
      OPENAI_BASE_URL: `http://127.0.0.1:${PROXY_PORT}/v1`,
      RM_RUN_ID: input.budget.runId,
      RM_CASE_ID: cell.recordedCase.caseId,
      RM_EXECUTION_ID: executionId,
      RM_SCRATCH: SCRATCH_CONTAINER_PATH,
      RM_PROXY_HOST: "127.0.0.1",
      RM_PROXY_PORT: String(PROXY_PORT),
      RM_EGRESS_URL: `http://host.docker.internal:${listener.port}`,
      RM_SWAP_POLICY: JSON.stringify(policy),
      RM_PRICING_TABLE: JSON.stringify(table),
      RM_BUDGET_LEASE: JSON.stringify({ maxUsd: leaseUsd }),
      ...(resume ? { RM_RESUME: "1" } : {}),
    },
    mounts: [
      {
        hostPath: input.appSpec.mountPath,
        containerPath: APP_CONTAINER_PATH,
        readOnly: true,
      },
      {
        hostPath: replayRuntimeRoot(),
        containerPath: RUNTIME_CONTAINER_PATH,
        readOnly: true,
      },
    ],
    scratchHostPath,
    timeoutMs: input.appSpec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    hostPorts: [
      {
        containerHost: "host.docker.internal",
        note: `Mode B egress on host port ${listener.port}`,
      },
    ],
    labels: {
      "com.rightmodeler.run": input.budget.runId,
      "com.rightmodeler.case": cell.recordedCase.caseId,
      "com.rightmodeler.execution": executionId,
    },
  });
}

async function waitForExit(
  executor: DockerExecutor,
  handle: string,
): Promise<DockerStatus> {
  for (;;) {
    const status = await executor.status(handle);
    if (status.state === "exited") return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

function textFiles(
  collected: DockerCollectResult,
): ReadonlyMap<string, string> {
  return new Map(
    collected.files.map((file) => [
      `${file.namespace}/${file.path}`,
      Buffer.from(file.contents).toString("utf8"),
    ]),
  );
}

function parsedLines(source: string): Array<unknown | undefined> {
  return source
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    });
}

function checkpointPair(logicalCallId: string | null, group: number): string {
  return JSON.stringify([logicalCallId, group]);
}

function parseCheckpoints(
  source: string | undefined,
  expectedCaseId: string,
): CheckpointIndex {
  if (source === undefined) {
    return { count: 0, rejectedRows: 0, terminalGroup: null, pairs: new Set() };
  }
  let sequence = 0;
  let highestGroup = 0;
  let rejectedRows = 0;
  const groups = new Map<string, number>();
  const pairs = new Set<string>();
  for (const row of parsedLines(source)) {
    if (
      !isRecord(row) ||
      row.caseId !== expectedCaseId ||
      !positiveInteger(row.seqPos) ||
      row.seqPos !== sequence + 1 ||
      !positiveInteger(row.attemptGroup) ||
      (row.logicalCallId !== null && !nonemptyString(row.logicalCallId))
    ) {
      rejectedRows += 1;
      continue;
    }
    const logicalCallId = row.logicalCallId;
    const priorGroup =
      logicalCallId === null ? undefined : groups.get(logicalCallId);
    const expectedGroup = priorGroup ?? highestGroup + 1;
    if (row.attemptGroup !== expectedGroup) {
      rejectedRows += 1;
      continue;
    }
    sequence = row.seqPos;
    highestGroup = Math.max(highestGroup, row.attemptGroup);
    if (logicalCallId !== null && priorGroup === undefined) {
      groups.set(logicalCallId, row.attemptGroup);
    }
    pairs.add(checkpointPair(logicalCallId, row.attemptGroup));
  }
  return {
    count: sequence,
    rejectedRows,
    terminalGroup: highestGroup === 0 ? null : highestGroup,
    pairs,
  };
}

function validUsage(value: unknown): ValidUsage | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !nonnegativeInteger(value.inputTokens) ||
    !nonnegativeInteger(value.outputTokens) ||
    !nonnegativeInteger(value.totalTokens) ||
    value.totalTokens !== value.inputTokens + value.outputTokens
  ) {
    return undefined;
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function validIdentity(
  row: Record<string, unknown>,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
): boolean {
  return (
    row.runId === input.budget.runId &&
    row.caseId === cell.recordedCase.caseId &&
    row.executionId === executionId
  );
}

function expectedStepModel(
  stepId: string,
  steps: ReadonlyMap<string, ReplayStep>,
  policy: ModeBSwapPolicy,
): string | null {
  const step = steps.get(stepId);
  return step === undefined ? null : expectedModel(step, policy);
}

function parseAttempt(
  row: Record<string, unknown>,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
  steps: ReadonlyMap<string, ReplayStep>,
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
  checkpoints: CheckpointIndex,
): ValidAttemptRow | null {
  const usage = validUsage(row.usage);
  if (
    !validIdentity(row, input, cell, executionId) ||
    !nonemptyString(row.stepId) ||
    !nonemptyString(row.attemptId) ||
    !nonemptyString(row.logicalCallId) ||
    !positiveInteger(row.attemptGroup) ||
    !checkpoints.pairs.has(
      checkpointPair(row.logicalCallId, row.attemptGroup),
    ) ||
    !nonemptyString(row.model) ||
    row.model !== expectedStepModel(row.stepId, steps, policy) ||
    !nonemptyString(row.streamOutcome) ||
    !STREAM_OUTCOMES.has(row.streamOutcome) ||
    usage === undefined ||
    !nonnegativeInteger(row.estimatedInputTokens) ||
    !nonnegativeInteger(row.maxOutputTokens) ||
    row.attribution !== "ok" ||
    !nonnegativeNumber(row.reservedUsd) ||
    !nonnegativeNumber(row.leaseChargeUsd) ||
    !nonnegativeNumber(row.costUsd) ||
    typeof row.costIsEstimate !== "boolean" ||
    row.costIsEstimate !== (usage === null) ||
    (row.responseSpoolPath !== null &&
      typeof row.responseSpoolPath !== "string") ||
    (row.finishedWithoutSentinel !== undefined &&
      row.finishedWithoutSentinel !== true) ||
    !timestamp(row.startedAt) ||
    !timestamp(row.endedAt) ||
    Date.parse(row.endedAt) < Date.parse(row.startedAt)
  ) {
    return null;
  }
  const pricing = table[row.model];
  if (pricing === undefined) return null;
  const reservedUsd =
    row.estimatedInputTokens * pricing.input +
    row.maxOutputTokens * pricing.output;
  const costUsd =
    usage === null
      ? reservedUsd
      : usage.inputTokens * pricing.input + usage.outputTokens * pricing.output;
  if (
    !closeEnough(row.reservedUsd, reservedUsd) ||
    !closeEnough(row.leaseChargeUsd, costUsd) ||
    !closeEnough(row.costUsd, costUsd)
  ) {
    return null;
  }
  const upstreamStatus = row.upstreamStatus;
  const upstreamSource = row.upstreamSource;
  if (!(
    (upstreamStatus === null && upstreamSource === null) ||
    (positiveInteger(upstreamStatus) &&
      upstreamStatus >= 100 &&
      upstreamStatus <= 599 &&
      (upstreamSource === "provider" || upstreamSource === "egress"))
  )) {
    return null;
  }
  if (
    upstreamSource === null &&
    row.streamOutcome !== "truncated" &&
    row.streamOutcome !== "client_cancelled"
  ) {
    return null;
  }
  return {
    attemptId: row.attemptId,
    logicalCallId: row.logicalCallId,
    executionId,
    stepId: row.stepId,
    model: row.model,
    streamOutcome: row.streamOutcome as ValidAttemptRow["streamOutcome"],
    usage,
    estimatedInputTokens: row.estimatedInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    attemptGroup: row.attemptGroup,
    upstreamStatus,
    upstreamSource,
    costUsd,
  };
}

function parseReservation(
  row: Record<string, unknown>,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
  steps: ReadonlyMap<string, ReplayStep>,
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
  checkpoints: CheckpointIndex,
): ValidReservationRow | null {
  if (
    !validIdentity(row, input, cell, executionId) ||
    !nonemptyString(row.stepId) ||
    !nonemptyString(row.attemptId) ||
    !nonemptyString(row.logicalCallId) ||
    !positiveInteger(row.attemptGroup) ||
    !checkpoints.pairs.has(
      checkpointPair(row.logicalCallId, row.attemptGroup),
    ) ||
    !nonemptyString(row.model) ||
    row.model !== expectedStepModel(row.stepId, steps, policy) ||
    !nonnegativeInteger(row.estimatedInputTokens) ||
    !nonnegativeInteger(row.maxOutputTokens) ||
    !nonnegativeNumber(row.reservedUsd) ||
    !timestamp(row.startedAt)
  ) {
    return null;
  }
  const pricing = table[row.model];
  if (pricing === undefined) return null;
  const reservedUsd =
    row.estimatedInputTokens * pricing.input +
    row.maxOutputTokens * pricing.output;
  if (!closeEnough(row.reservedUsd, reservedUsd)) return null;
  return {
    attemptId: row.attemptId,
    logicalCallId: row.logicalCallId,
    executionId,
    stepId: row.stepId,
    model: row.model,
    estimatedInputTokens: row.estimatedInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    attemptGroup: row.attemptGroup,
    reservedUsd,
  };
}

function validBlockedRow(
  row: Record<string, unknown>,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
  steps: ReadonlyMap<string, ReplayStep>,
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
  checkpoints: CheckpointIndex,
): boolean {
  if (
    !validIdentity(row, input, cell, executionId) ||
    row.reason !== "budget" ||
    !nonemptyString(row.stepId) ||
    !nonemptyString(row.logicalCallId) ||
    !positiveInteger(row.attemptGroup) ||
    !checkpoints.pairs.has(
      checkpointPair(row.logicalCallId, row.attemptGroup),
    ) ||
    !nonemptyString(row.model) ||
    row.model !== expectedStepModel(row.stepId, steps, policy) ||
    !nonnegativeInteger(row.estimatedInputTokens) ||
    !nonnegativeInteger(row.maxOutputTokens) ||
    !nonnegativeNumber(row.estimatedWorstCaseUsd) ||
    !isRecord(row.lease) ||
    !nonnegativeNumber(row.lease.maxUsd) ||
    !isRecord(row.requiredLease) ||
    !nonnegativeNumber(row.requiredLease.maxUsd) ||
    row.requiredLease.maxUsd <= row.lease.maxUsd ||
    !timestamp(row.timestamp)
  ) {
    return false;
  }
  const pricing = table[row.model];
  return (
    pricing !== undefined &&
    closeEnough(
      row.estimatedWorstCaseUsd,
      row.estimatedInputTokens * pricing.input +
        row.maxOutputTokens * pricing.output,
    )
  );
}

function validLostRow(
  row: Record<string, unknown>,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
  steps: ReadonlyMap<string, ReplayStep>,
  checkpoints: CheckpointIndex,
): boolean {
  return (
    validIdentity(row, input, cell, executionId) &&
    (row.stepId === null ||
      (nonemptyString(row.stepId) && steps.has(row.stepId))) &&
    nonemptyString(row.attemptId) &&
    (row.logicalCallId === null || nonemptyString(row.logicalCallId)) &&
    positiveInteger(row.attemptGroup) &&
    checkpoints.pairs.has(
      checkpointPair(row.logicalCallId, row.attemptGroup),
    ) &&
    row.attribution === "lost" &&
    row.streamOutcome === null &&
    row.usage === null &&
    row.costUsd === null &&
    row.costIsEstimate === false &&
    row.reservedUsd === 0 &&
    row.leaseChargeUsd === 0 &&
    nonemptyString(row.rejectionReason) &&
    timestamp(row.startedAt) &&
    timestamp(row.endedAt) &&
    Date.parse(row.endedAt) >= Date.parse(row.startedAt)
  );
}

function terminalEnvelope(
  source: string | undefined,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
): TerminalEnvelope | null {
  if (source === undefined) return null;
  const last = source
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .at(-1);
  if (last === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.runId !== input.budget.runId ||
    value.caseId !== cell.recordedCase.caseId ||
    !input.cases.some(({ caseId }) => caseId === value.caseId) ||
    value.executionId !== executionId ||
    !Object.hasOwn(value, "finalOutput")
  ) {
    return null;
  }
  const execution = executionSchema.safeParse({
    executionId,
    evidenceQuestionId: cell.executionStep.evidenceQuestionId,
    caseId: cell.recordedCase.caseId,
    stepId: cell.executionStep.stepId,
    candidateId: cell.candidateId,
    trajectoryId: cell.recordedCase.trajectoryId,
    corpusSplit: cell.recordedCase.corpusSplit,
    selectionStage:
      cell.executionStep.selectionStage ?? cell.recordedCase.corpusSplit,
    terminalOutcome: "success",
    finalOutput: value.finalOutput,
    attribution: "ok",
  });
  return execution.success ? { finalOutput: execution.data.finalOutput } : null;
}

function parseDriverStatus(source: string | undefined): DriverStatus | null {
  if (source === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    (value.phase !== "install" &&
      value.phase !== "proxy" &&
      value.phase !== "workload") ||
    (value.code !== undefined &&
      value.code !== null &&
      !nonnegativeInteger(value.code)) ||
    (value.signal !== undefined &&
      value.signal !== null &&
      !nonemptyString(value.signal)) ||
    (value.error !== undefined && !nonemptyString(value.error))
  ) {
    return null;
  }
  return {
    phase: value.phase,
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function inspectCollection(
  collected: DockerCollectResult,
  input: ReplayModeBInput,
  cell: ModeBCell,
  executionId: string,
  steps: ReadonlyMap<string, ReplayStep>,
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
): CollectedInspection {
  const files = textFiles(collected);
  const attemptPath = `proxy/attempts/${executionId}.0.jsonl`;
  const checkpointPath = `proxy/checkpoints/${cell.recordedCase.caseId}.jsonl`;
  const checkpoints = parseCheckpoints(
    files.get(checkpointPath),
    cell.recordedCase.caseId,
  );
  const attempts: ValidAttemptRow[] = [];
  const reservations: ValidReservationRow[] = [];
  const reservationIds = new Set<string>();
  const attemptIds = new Set<string>();
  let blockedRows = 0;
  let lostRows = 0;
  let rejectedRows = collected.skipped.length + checkpoints.rejectedRows;
  const collectionFailed = collected.skipped.some(
    ({ namespace, path }) =>
      (namespace === "workload" && path === "stdout.jsonl") ||
      (namespace === "driver" && path === "status.json") ||
      (namespace === "proxy" &&
        (path.startsWith("attempts/") || path.startsWith("checkpoints/"))),
  );

  for (const [path, source] of files) {
    if (path.startsWith("proxy/checkpoints/") && path.endsWith(".jsonl")) {
      if (path !== checkpointPath) rejectedRows += parsedLines(source).length;
      continue;
    }
    if (!path.startsWith("proxy/attempts/") || !path.endsWith(".jsonl")) {
      continue;
    }
    for (const value of parsedLines(source)) {
      if (path !== attemptPath || !isRecord(value)) {
        rejectedRows += 1;
        continue;
      }
      if (value.kind === "request_attempt") {
        const attempt = parseAttempt(
          value,
          input,
          cell,
          executionId,
          steps,
          policy,
          table,
          checkpoints,
        );
        if (attempt === null || attemptIds.has(attempt.attemptId)) {
          rejectedRows += 1;
          continue;
        }
        const reservationIndex = reservations.findIndex(
          ({ attemptId }) => attemptId === attempt.attemptId,
        );
        if (reservationIndex === -1) {
          rejectedRows += 1;
          continue;
        }
        reservations.splice(reservationIndex, 1);
        attemptIds.add(attempt.attemptId);
        attempts.push(attempt);
        continue;
      }
      if (value.kind === "attempt_reservation") {
        const reservation = parseReservation(
          value,
          input,
          cell,
          executionId,
          steps,
          policy,
          table,
          checkpoints,
        );
        if (
          reservation === null ||
          reservationIds.has(reservation.attemptId) ||
          attemptIds.has(reservation.attemptId)
        ) {
          rejectedRows += 1;
          continue;
        }
        reservationIds.add(reservation.attemptId);
        reservations.push(reservation);
        continue;
      }
      if (value.kind === "blocked") {
        if (
          !validBlockedRow(
            value,
            input,
            cell,
            executionId,
            steps,
            policy,
            table,
            checkpoints,
          )
        ) {
          rejectedRows += 1;
          continue;
        }
        blockedRows += 1;
        continue;
      }
      if (value.kind === "lost") {
        if (
          !validLostRow(value, input, cell, executionId, steps, checkpoints) ||
          !nonemptyString(value.attemptId) ||
          attemptIds.has(value.attemptId)
        ) {
          rejectedRows += 1;
          continue;
        }
        attemptIds.add(value.attemptId);
        lostRows += 1;
        continue;
      }
      rejectedRows += 1;
    }
  }

  const stdout = files.get("workload/stdout.jsonl");
  const envelope = terminalEnvelope(stdout, input, cell, executionId);
  if (stdout !== undefined && stdout.trim().length > 0 && envelope === null) {
    rejectedRows += 1;
  }
  const rawDriverStatus = files.get("driver/status.json");
  const driverStatus = parseDriverStatus(rawDriverStatus);
  if (rawDriverStatus !== undefined && driverStatus === null) rejectedRows += 1;
  return {
    attempts,
    reservations,
    blockedRows,
    lostRows,
    checkpointRows: checkpoints.count,
    terminalGroup: checkpoints.terminalGroup,
    terminalEnvelope: envelope,
    driverStatus,
    rejectedRows,
    collectionFailed,
  };
}

function failedInspection(): CollectedInspection {
  return {
    attempts: [],
    reservations: [],
    blockedRows: 0,
    lostRows: 0,
    checkpointRows: 0,
    terminalGroup: null,
    terminalEnvelope: null,
    driverStatus: null,
    rejectedRows: 0,
    collectionFailed: true,
  };
}

function workloadFinished(inspection: CollectedInspection): boolean {
  return (
    inspection.driverStatus?.phase === "workload" &&
    inspection.driverStatus.error === undefined
  );
}

function shouldResume(
  status: DockerStatus | null,
  statusFailed: boolean,
  inspection: CollectedInspection,
): boolean {
  return (
    inspection.checkpointRows > 0 &&
    inspection.terminalEnvelope === null &&
    !inspection.collectionFailed &&
    status?.timedOut !== true &&
    !workloadFinished(inspection) &&
    (statusFailed || status?.oomKilled === true || status?.exitCode !== 0)
  );
}

async function runContainer(
  input: ReplayModeBInput,
  listener: EgressListener,
  cell: ModeBCell,
  executionId: string,
  scratchHostPath: string,
  policy: ModeBSwapPolicy,
  table: Readonly<Record<string, ModelPricing>>,
  leaseUsd: number,
  steps: ReadonlyMap<string, ReplayStep>,
): Promise<ContainerResult> {
  let resume = false;
  for (let launchNumber = 0; launchNumber < 2; launchNumber += 1) {
    let handle: string;
    try {
      handle = await launchCase(
        input,
        listener,
        cell,
        executionId,
        scratchHostPath,
        policy,
        table,
        leaseUsd,
        resume,
      );
    } catch {
      return {
        inspection: failedInspection(),
        status: null,
        lifecycleFailed: true,
      };
    }

    let status: DockerStatus | null = null;
    let statusFailed = false;
    let inspection = failedInspection();
    let destroyFailed = false;
    try {
      try {
        status = await waitForExit(input.executor, handle);
      } catch {
        statusFailed = true;
      }
      try {
        const collected = await input.executor.collect(handle, {
          namespaces: COLLECTION_NAMESPACES,
          scratchHostPath,
        });
        inspection = inspectCollection(
          collected,
          input,
          cell,
          executionId,
          steps,
          policy,
          table,
        );
      } catch {
        inspection = failedInspection();
      }
    } finally {
      try {
        await input.executor.destroy(handle);
      } catch {
        destroyFailed = true;
      }
    }

    if (
      launchNumber === 0 &&
      !destroyFailed &&
      shouldResume(status, statusFailed, inspection)
    ) {
      resume = true;
      continue;
    }
    return {
      inspection,
      status,
      lifecycleFailed: statusFailed || destroyFailed,
    };
  }
  throw new Error("Mode B resume loop exhausted unexpectedly");
}

function terminalAttempts(
  inspection: CollectedInspection,
): readonly ValidAttemptRow[] {
  return inspection.terminalGroup === null
    ? []
    : inspection.attempts.filter(
        ({ attemptGroup }) => attemptGroup === inspection.terminalGroup,
      );
}

function rateLimitBlocked(inspection: CollectedInspection): boolean {
  const groups = new Map<number, ValidAttemptRow[]>();
  for (const attempt of inspection.attempts) {
    const group = groups.get(attempt.attemptGroup) ?? [];
    group.push(attempt);
    groups.set(attempt.attemptGroup, group);
  }
  return [...groups.values()].some(
    (attempts) =>
      attempts.length > 0 &&
      attempts.every(
        ({ upstreamSource, upstreamStatus }) =>
          upstreamSource === "provider" && upstreamStatus === 429,
      ),
  );
}

function modelMisbehaved(inspection: CollectedInspection): boolean {
  const attempts = terminalAttempts(inspection);
  return (
    attempts.length > 0 &&
    attempts.every(
      ({ streamOutcome, upstreamSource, upstreamStatus }) =>
        upstreamSource === "provider" &&
        upstreamStatus !== null &&
        upstreamStatus < 400 &&
        streamOutcome === "truncated",
    )
  );
}

function egressFailed(inspection: CollectedInspection): boolean {
  return inspection.attempts.some(
    ({ streamOutcome, upstreamSource }) =>
      upstreamSource === "egress" ||
      (upstreamSource === null && streamOutcome === "truncated"),
  );
}

function infrastructureFailed(result: ContainerResult): boolean {
  if (
    result.lifecycleFailed ||
    result.inspection.collectionFailed ||
    result.inspection.lostRows > 0 ||
    result.status === null ||
    result.status.timedOut ||
    result.status.oomKilled ||
    egressFailed(result.inspection)
  ) {
    return true;
  }
  const driverStatus = result.inspection.driverStatus;
  if (
    driverStatus === null ||
    driverStatus.phase !== "workload" ||
    driverStatus.error !== undefined
  ) {
    return true;
  }
  const expectedExit = driverStatus.code ?? 1;
  return result.status.exitCode !== expectedExit;
}

async function writeAttemptFacts(
  input: ReplayModeBInput,
  cell: ModeBCell,
  attempts: readonly ValidAttemptRow[],
  reservations: readonly ValidReservationRow[],
): Promise<number> {
  let totalCostUsd = 0;
  const chargeable: Array<
    ValidAttemptRow & { conservativeReservation: boolean }
  > = [
    ...attempts.map((attempt) => ({
      ...attempt,
      conservativeReservation: false,
    })),
    ...reservations.map((reservation) => ({
      ...reservation,
      streamOutcome: "truncated" as const,
      usage: null,
      upstreamStatus: null,
      upstreamSource: null,
      costUsd: reservation.reservedUsd,
      conservativeReservation: true,
    })),
  ];
  for (const attempt of chargeable) {
    totalCostUsd += attempt.costUsd;
    const existing = await input.store.get(
      factKey(input.budget.projectId, attempt.attemptId),
    );
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      attempt.attemptId,
      requestAttemptSchema.parse({
        attemptId: attempt.attemptId,
        logicalCallId: attempt.logicalCallId,
        executionId: attempt.executionId,
        streamOutcome: attempt.streamOutcome,
        usage: attempt.usage,
        costUsd: attempt.costUsd,
        costIsEstimate: true,
      }),
    );
    if (existing !== null) continue;
    const spendId = randomUUID();
    await writeReplayFact(
      input.store,
      input.budget.projectId,
      spendId,
      spendEventSchema.parse({
        actor: "replay-driver",
        phase:
          input.stepRecords.find(({ stepId }) => stepId === attempt.stepId)
            ?.selectionStage ?? cell.recordedCase.corpusSplit,
        costUsd: attempt.costUsd,
        provider: input.egress.providerId,
        reconcilableTo: {
          attemptId: attempt.attemptId,
          logicalCallId: attempt.logicalCallId,
          executionId: attempt.executionId,
          candidateId: cell.candidateId,
          stepId: attempt.stepId,
          model: attempt.model,
          attemptGroup: attempt.attemptGroup,
          estimatedInputTokens: attempt.estimatedInputTokens,
          maxOutputTokens: attempt.maxOutputTokens,
          upstreamStatus: attempt.upstreamStatus,
          upstreamSource: attempt.upstreamSource,
          conservativeReservation: attempt.conservativeReservation,
          costIsEstimate: true,
        },
      }),
    );
  }
  return totalCostUsd;
}

function executionFor(
  cell: ModeBCell,
  executionId: string,
  outcome: "success" | "failure",
  finalOutput: JsonValue,
  attribution: "ok" | "lost" | "silent-failure",
): Execution {
  return executionSchema.parse({
    executionId,
    evidenceQuestionId: cell.executionStep.evidenceQuestionId,
    caseId: cell.recordedCase.caseId,
    stepId: cell.executionStep.stepId,
    candidateId: cell.candidateId,
    trajectoryId: cell.recordedCase.trajectoryId,
    corpusSplit: cell.recordedCase.corpusSplit,
    selectionStage:
      cell.executionStep.selectionStage ?? cell.recordedCase.corpusSplit,
    terminalOutcome: outcome,
    finalOutput,
    attribution,
  });
}

/**
 * Runs the client's pipeline in a container and joins validated execution and
 * metering records. Assessment remains a host-side caller step.
 */
export async function replayModeB(
  input: ReplayModeBInput,
): Promise<ReplayModeBResult> {
  validateInput(input);
  const steps = stepMap(input.stepRecords);
  const policy = normalizedSwapPolicy(input.swapPolicy, steps);
  const cells = cellsFor(input, steps, policy);
  const existing = await terminalReplayCells(
    input.store,
    input.budget.projectId,
  );
  const pending = cells.filter((cell) => !existing.has(cell.correlationKey));
  const result: ReplayModeBResult = {
    completed: 0,
    skipped: cells.length - pending.length,
    blocked: [],
    rejectedRows: 0,
    executions: [],
  };
  if (pending.length === 0) return result;

  const table = pricingTable(input.egress.catalog);
  validatePricing(input.stepRecords, policy, table);
  const workerLimit =
    (await input.budget.state()).authorizedTotalUsd === undefined
      ? input.concurrency
      : 1;
  const activeRefunds = new Set<Promise<void>>();
  let scratchRoot: string | null = null;
  let listener: EgressListener | null = null;
  let nextCell = 0;

  async function runCell(cell: ModeBCell): Promise<void> {
    const reservation = await reserveCase(input, activeRefunds);
    if (reservation === null) {
      result.blocked.push({
        kind: "budget",
        stepId: cell.executionStep.stepId,
        caseId: cell.recordedCase.caseId,
        candidateId: cell.candidateId,
        message: "Budget cap cannot cover this Mode B case",
      });
      return;
    }
    const waiter = createWaiter();
    activeRefunds.add(waiter.promise);
    let actualCostUsd = 0;
    let heartbeatFailure: unknown;
    let heartbeatWork = reservation.heartbeat().catch((error: unknown) => {
      heartbeatFailure = error;
    });
    const heartbeatTimer = setInterval(() => {
      heartbeatWork = heartbeatWork
        .then(() => reservation.heartbeat())
        .catch((error: unknown) => {
          heartbeatFailure ??= error;
        });
    }, BUDGET_HEARTBEAT_INTERVAL_MS);
    const executionId = randomUUID();
    try {
      if (scratchRoot === null || listener === null) {
        throw new Error("Mode B runtime is not initialized");
      }
      const scratchHostPath = await prepareScratch(
        scratchRoot,
        cell,
        executionId,
        input.appSpec,
      );
      const leaseUsd =
        (await input.budget.state()).authorizedTotalUsd === undefined
          ? Number.MAX_SAFE_INTEGER
          : reservation.reservedUsd;
      const container = await runContainer(
        input,
        listener,
        cell,
        executionId,
        scratchHostPath,
        policy,
        table,
        leaseUsd,
        steps,
      );
      const inspection = container.inspection;
      result.rejectedRows += inspection.rejectedRows;
      actualCostUsd = await writeAttemptFacts(
        input,
        cell,
        inspection.attempts,
        inspection.reservations,
      );
      if (heartbeatFailure !== undefined) throw heartbeatFailure;

      const successfulEnvelope =
        container.status?.exitCode === 0 &&
        inspection.terminalEnvelope !== null;
      if (rateLimitBlocked(inspection)) {
        result.blocked.push({
          kind: "rate-limit",
          stepId: cell.executionStep.stepId,
          caseId: cell.recordedCase.caseId,
          candidateId: cell.candidateId,
          message: "Provider retries exhausted after HTTP 429",
          observedCeiling: 1,
        });
        return;
      }
      if (inspection.blockedRows > 0) {
        result.blocked.push({
          kind: "budget",
          stepId: cell.executionStep.stepId,
          caseId: cell.recordedCase.caseId,
          candidateId: cell.candidateId,
          message: "The in-container proxy exhausted its budget lease",
        });
        return;
      }

      const infrastructureLost = infrastructureFailed(container);
      const envelope = inspection.terminalEnvelope;
      const targetStepExercised = inspection.attempts.some(
        ({ stepId }) => stepId === cell.recordedCase.stepId,
      );
      const outputTokens = inspection.attempts.reduce(
        (total, attempt) => total + (attempt.usage?.outputTokens ?? 0),
        0,
      );
      let execution: Execution;
      if (
        successfulEnvelope &&
        envelope !== null &&
        !infrastructureLost &&
        envelope.finalOutput === "" &&
        outputTokens === 0
      ) {
        execution = executionFor(
          cell,
          executionId,
          "failure",
          envelope.finalOutput,
          "silent-failure",
        );
      } else if (
        successfulEnvelope &&
        envelope !== null &&
        targetStepExercised
      ) {
        execution = executionFor(
          cell,
          executionId,
          "success",
          envelope.finalOutput,
          infrastructureLost ? "lost" : "ok",
        );
      } else {
        execution = executionFor(
          cell,
          executionId,
          "failure",
          targetStepExercised ? (envelope?.finalOutput ?? null) : null,
          !infrastructureLost &&
            targetStepExercised &&
            modelMisbehaved(inspection)
            ? "ok"
            : "lost",
        );
      }
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        executionId,
        execution,
      );
      existing.add(cell.correlationKey);
      result.executions.push(execution);
      result.completed += 1;
    } catch (error) {
      actualCostUsd = reservation.reservedUsd;
      const spendId = randomUUID();
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        spendId,
        spendEventSchema.parse({
          actor: "replay-driver",
          phase:
            cell.executionStep.selectionStage ?? cell.recordedCase.corpusSplit,
          costUsd: actualCostUsd,
          provider: input.egress.providerId,
          reconcilableTo: {
            executionId,
            caseId: cell.recordedCase.caseId,
            candidateId: cell.candidateId,
            failure: "mode_b_case_failed",
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error),
          },
        }),
      );
      throw error;
    } finally {
      try {
        clearInterval(heartbeatTimer);
        await heartbeatWork;
        await reservation.refund(actualCostUsd);
      } finally {
        activeRefunds.delete(waiter.promise);
        waiter.resolve();
      }
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextCell;
      nextCell += 1;
      const cell = pending[index];
      if (cell === undefined) return;
      await runCell(cell);
    }
  }

  try {
    listener = await startEgressListener({
      providerBaseUrl: input.egress.providerBaseUrl,
      apiKeyEnv: input.egress.apiKeyEnv,
      hostname: input.egress.hostname,
      port: input.egress.port,
    });
    scratchRoot = await mkdtemp(
      join(dirname(resolve(input.appSpec.mountPath)), ".rightmodeler-modeb-"),
    );
  } catch {
    if (listener !== null) await listener.close().catch(() => undefined);
    for (const cell of pending) {
      const executionId = randomUUID();
      const execution = executionFor(
        cell,
        executionId,
        "failure",
        null,
        "lost",
      );
      await writeReplayFact(
        input.store,
        input.budget.projectId,
        executionId,
        execution,
      );
      result.executions.push(execution);
      result.completed += 1;
    }
    result.executions.sort((left, right) =>
      left.caseId.localeCompare(right.caseId),
    );
    return result;
  }

  let workerFailure: unknown;
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(workerLimit, pending.length) }, () =>
        worker(),
      ),
    );
    workerFailure = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    )?.reason;
  } finally {
    try {
      if (scratchRoot !== null) {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    } finally {
      if (listener !== null) await listener.close();
    }
  }
  if (workerFailure !== undefined) throw workerFailure;
  result.executions.sort((left, right) =>
    left.caseId.localeCompare(right.caseId),
  );
  return result;
}
