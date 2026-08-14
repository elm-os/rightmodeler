import type { JsonValue } from "@rightmodeler/core";

import type { NormalizedRun } from "../normalized-run.js";

export type TraceFormat =
  | "otel-genai"
  | "openai-jsonl"
  | "langfuse"
  | "braintrust"
  | "langsmith"
  | "openinference"
  | "helicone"
  | "weave"
  | "claude-code"
  | "codex";

export interface DroppedTraceRecord {
  recordIndex: number;
  reason: string;
}

export interface TraceAdaptResult {
  runs: NormalizedRun[];
  droppedRecords: readonly DroppedTraceRecord[];
}

export interface NamedTraceAdapter {
  readonly name: TraceFormat;
  detect(sample: unknown): number;
  adapt(records: unknown): NormalizedRun[];
  adaptWithReport(records: unknown): TraceAdaptResult;
}

export interface DetectionCandidate {
  name: TraceFormat;
  confidence: number;
}

export class TraceParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TraceParseError";
  }
}

export class TraceAdaptError extends Error {
  readonly format: TraceFormat;

  constructor(format: TraceFormat, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TraceAdaptError";
    this.format = format;
  }
}

export class TraceRecordsDroppedError extends TraceAdaptError {
  readonly result: TraceAdaptResult;

  constructor(format: TraceFormat, result: TraceAdaptResult) {
    super(
      format,
      `${format} dropped ${result.droppedRecords.length} unmappable record(s): ${result.droppedRecords
        .map(
          ({ recordIndex, reason }) => `record ${recordIndex + 1}: ${reason}`,
        )
        .join("; ")}`,
    );
    this.name = "TraceRecordsDroppedError";
    this.result = result;
  }
}

export class FormatDetectionError extends Error {
  readonly reason: "ambiguous" | "below_threshold";
  readonly candidates: readonly DetectionCandidate[];

  constructor(
    reason: "ambiguous" | "below_threshold",
    candidates: readonly DetectionCandidate[],
  ) {
    const scores = candidates
      .map(({ name, confidence }) => `${name}=${confidence.toFixed(2)}`)
      .join(", ");
    super(`Trace format ${reason.replace("_", " ")}: ${scores}`);
    this.name = "FormatDetectionError";
    this.reason = reason;
    this.candidates = candidates;
  }
}

const minimumConfidence = 0.6;
const ambiguityMargin = 0.1;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonCandidate(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function sampleRecords(sample: unknown): unknown[] {
  if (typeof sample !== "string") {
    return Array.isArray(sample) ? sample : [sample];
  }

  const parsed = parseJsonCandidate(sample);
  if (parsed !== undefined) {
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const records: unknown[] = [];
  for (const line of sample.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const record = parseJsonCandidate(line);
    if (record === undefined) return [];
    records.push(record);
  }
  return records;
}

export function parseTraceRecords(text: string): unknown[] {
  if (text.trim() === "") {
    throw new TraceParseError("Trace input is empty");
  }

  const parsed = parseJsonCandidate(text);
  if (parsed !== undefined) {
    if (Array.isArray(parsed)) return parsed;
    if (isRecord(parsed)) return [parsed];
    throw new TraceParseError(
      "Trace JSON must contain an object or object list",
    );
  }

  const records: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const record = parseJsonCandidate(line);
    if (!isRecord(record)) {
      throw new TraceParseError(
        `Invalid JSON object at trace line ${index + 1}`,
      );
    }
    records.push(record);
  }
  if (records.length === 0) {
    throw new TraceParseError("Trace input contains no records");
  }
  return records;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function detectFormat(
  sample: string,
  adapters: readonly NamedTraceAdapter[],
): NamedTraceAdapter {
  const scored = adapters
    .map((adapter) => ({
      adapter,
      name: adapter.name,
      confidence: clampConfidence(adapter.detect(sample)),
    }))
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.name.localeCompare(right.name),
    );
  const first = scored[0]!;
  const second = scored[1]!;
  const candidates = scored.map(({ name, confidence }) => ({
    name,
    confidence,
  }));

  if (first.confidence < minimumConfidence) {
    throw new FormatDetectionError("below_threshold", candidates);
  }
  if (first.confidence - second.confidence < ambiguityMargin) {
    throw new FormatDetectionError("ambiguous", candidates);
  }
  return first.adapter;
}

export function adaptWithReport(
  adapter: NamedTraceAdapter,
  records: unknown,
): TraceAdaptResult {
  return adapter.adaptWithReport(records);
}

export function strictRuns(
  format: TraceFormat,
  result: TraceAdaptResult,
): NormalizedRun[] {
  if (result.droppedRecords.length > 0) {
    throw new TraceRecordsDroppedError(format, result);
  }
  return result.runs;
}

export function requiredString(
  value: unknown,
  label: string,
  format: TraceFormat,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceAdaptError(format, `${label} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function tokenCount(
  value: unknown,
  label: string,
  format: TraceFormat,
): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TraceAdaptError(
      format,
      `${label} must be a non-negative integer`,
    );
  }
  return value as number;
}

export function jsonValue(
  value: unknown,
  label: string,
  format: TraceFormat,
): JsonValue {
  const parsed = normalizedJsonValue(value);
  if (parsed === undefined) {
    throw new TraceAdaptError(format, `${label} must be valid JSON data`);
  }
  return parsed;
}

export function normalizedJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const parsed = normalizedJsonValue(item);
      if (parsed === undefined) return undefined;
      result.push(parsed);
    }
    return result;
  }
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = normalizedJsonValue(item);
      if (parsed === undefined) return undefined;
      result[key] = parsed;
    }
    return result;
  }
  return undefined;
}

export function jsonEncodedValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = parseJsonCandidate(value);
  return parsed === undefined ? value : parsed;
}

export function textParts(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const content = item.content ?? item.text;
    if (typeof content === "string" && content.length > 0) {
      parts.push(content);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function startValue(
  record: Record<string, unknown>,
): string | undefined {
  for (const key of [
    "startTimeUnixNano",
    "start_time_unix_nano",
    "startTime",
    "start_time",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function compareStartValues(
  left: string | undefined,
  right: string | undefined,
) {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function recordList(
  records: unknown,
  format: TraceFormat,
  label: string,
): unknown[] {
  if (!Array.isArray(records)) {
    throw new TraceAdaptError(format, `${label} must be a list`);
  }
  return records;
}
