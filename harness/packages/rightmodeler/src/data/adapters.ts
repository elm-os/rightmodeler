import type { JsonValue } from "@rightmodeler/core";

import {
  normalizedRunSchema,
  type NormalizedRun,
  type NormalizedStep,
} from "./normalized-run.js";

export type TraceFormat = "otel-genai" | "openai-jsonl";

export interface NamedTraceAdapter {
  readonly name: TraceFormat;
  detect(sample: unknown): number;
  adapt(records: unknown): NormalizedRun[];
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonCandidate(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sampleRecords(sample: unknown): unknown[] {
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

function requiredString(
  value: unknown,
  label: string,
  format: TraceFormat,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TraceAdaptError(format, `${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokenCount(
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

function jsonValue(
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

function normalizedJsonValue(value: unknown): JsonValue | undefined {
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

function textParts(value: unknown): string | undefined {
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

function startValue(record: Record<string, unknown>): string | undefined {
  for (const key of [
    "startTimeUnixNano",
    "start_time_unix_nano",
    "startTime",
    "start_time",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

function compareStartValues(
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

function otelConfidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter((record) => {
    const attributes = record.attributes;
    return (
      isRecord(attributes) &&
      typeof attributes["gen_ai.operation.name"] === "string"
    );
  }).length;
  return matching === 0 ? 0 : 0.7 + 0.3 * (matching / records.length);
}

function adaptOtel(records: unknown): NormalizedRun[] {
  const format = "otel-genai";
  if (!Array.isArray(records)) {
    throw new TraceAdaptError(format, "OTel trace records must be a span list");
  }

  const grouped = new Map<
    string,
    { record: Record<string, unknown>; sourceIndex: number }[]
  >();
  for (const [sourceIndex, candidate] of records.entries()) {
    if (!isRecord(candidate)) {
      throw new TraceAdaptError(
        format,
        `OTel span ${sourceIndex + 1} must be an object`,
      );
    }
    const attributes = candidate.attributes;
    if (!isRecord(attributes)) continue;
    const operation = attributes["gen_ai.operation.name"];
    if (typeof operation !== "string") continue;
    if (
      typeof attributes["gen_ai.request.model"] !== "string" &&
      typeof attributes["gen_ai.response.model"] !== "string"
    ) {
      throw new TraceAdaptError(
        format,
        `OTel span ${sourceIndex + 1} is missing its request or response model`,
      );
    }

    const traceId = requiredString(
      candidate.traceId ?? candidate.trace_id,
      `OTel span ${sourceIndex + 1} trace ID`,
      format,
    );
    const group = grouped.get(traceId) ?? [];
    group.push({ record: candidate, sourceIndex });
    grouped.set(traceId, group);
  }
  if (grouped.size === 0) {
    throw new TraceAdaptError(format, "No OTel GenAI inference spans found");
  }

  return [...grouped.entries()].map(([traceId, spans]) => {
    if (
      spans.length > 1 &&
      spans.some(({ record }) => startValue(record) === undefined)
    ) {
      throw new TraceAdaptError(
        format,
        `OTel trajectory ${traceId} must provide a start time for every span`,
      );
    }
    spans.sort(
      (left, right) =>
        compareStartValues(startValue(left.record), startValue(right.record)) ||
        left.sourceIndex - right.sourceIndex,
    );
    const steps = spans.map(({ record }, stepIndex) => {
      const attributes = record.attributes as Record<string, unknown>;
      const model = requiredString(
        attributes["gen_ai.request.model"] ??
          attributes["gen_ai.response.model"],
        `OTel trace ${traceId} model`,
        format,
      );
      const messages = attributes["gen_ai.input.messages"];
      if (!Array.isArray(messages)) {
        throw new TraceAdaptError(
          format,
          `OTel trace ${traceId} input messages must be an array`,
        );
      }
      if (attributes["gen_ai.output.messages"] === undefined) {
        throw new TraceAdaptError(
          format,
          `OTel trace ${traceId} is missing output messages`,
        );
      }

      const step: NormalizedStep = {
        stepIndex,
        model,
        messages: messages.map((message, index) =>
          jsonValue(
            message,
            `OTel trace ${traceId} input message ${index + 1}`,
            format,
          ),
        ),
        output: jsonValue(
          attributes["gen_ai.output.messages"],
          `OTel trace ${traceId} output messages`,
          format,
        ),
        usage: {
          inputTokens: tokenCount(
            attributes["gen_ai.usage.input_tokens"],
            `OTel trace ${traceId} input usage`,
            format,
          ),
          outputTokens: tokenCount(
            attributes["gen_ai.usage.output_tokens"],
            `OTel trace ${traceId} output usage`,
            format,
          ),
        },
        trajectoryId: traceId,
      };
      const systemPrompt = textParts(attributes["gen_ai.system_instructions"]);
      if (systemPrompt !== undefined) step.systemPrompt = systemPrompt;
      // Family attribution is v0: prefer the explicit custom attribute, then the legacy heuristic.
      const family =
        optionalString(attributes["rightmodeler.family"]) ??
        optionalString(attributes["gen_ai.prompt.name"]);
      if (family !== undefined) step.family = family;
      const timestamp = startValue(record);
      if (timestamp !== undefined) step.timestamp = timestamp;
      return step;
    });

    return normalizedRunSchema.parse({
      version: "2",
      traceId,
      sourceFormat: format,
      steps,
    });
  });
}

function openAiConfidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      Array.isArray(record.messages) &&
      isRecord(record.response) &&
      Array.isArray(record.response.choices),
  ).length;
  return matching === 0 ? 0 : 0.7 + 0.3 * (matching / records.length);
}

function adaptOpenAi(records: unknown): NormalizedRun[] {
  const format = "openai-jsonl";
  if (!Array.isArray(records)) {
    throw new TraceAdaptError(format, "OpenAI trace records must be a list");
  }

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const [index, candidate] of records.entries()) {
    if (!isRecord(candidate)) {
      throw new TraceAdaptError(
        format,
        `OpenAI record ${index + 1} must be an object`,
      );
    }
    const trajectoryId = requiredString(
      candidate.case_id,
      `OpenAI record ${index + 1} case_id`,
      format,
    );
    const group = grouped.get(trajectoryId) ?? [];
    group.push(candidate);
    grouped.set(trajectoryId, group);
  }
  if (grouped.size === 0) {
    throw new TraceAdaptError(format, "OpenAI trace contains no records");
  }

  return [...grouped.entries()].map(([traceId, group]) => {
    const steps = group.map((record, stepIndex) => {
      if (!Array.isArray(record.messages)) {
        throw new TraceAdaptError(
          format,
          `OpenAI trace ${traceId} messages must be an array`,
        );
      }
      const response = record.response;
      if (!isRecord(response) || !Array.isArray(response.choices)) {
        throw new TraceAdaptError(
          format,
          `OpenAI trace ${traceId} response choices must be an array`,
        );
      }
      const choice = response.choices[0];
      if (!isRecord(choice) || !isRecord(choice.message)) {
        throw new TraceAdaptError(
          format,
          `OpenAI trace ${traceId} is missing its first response message`,
        );
      }
      const model = requiredString(
        record.model ?? response.model,
        `OpenAI trace ${traceId} model`,
        format,
      );
      const usage = isRecord(record.usage)
        ? record.usage
        : isRecord(response.usage)
          ? response.usage
          : {};
      const systemMessages = record.messages.filter(
        (message) => isRecord(message) && message.role === "system",
      );
      const messages = record.messages.filter(
        (message) => !isRecord(message) || message.role !== "system",
      );
      const step: NormalizedStep = {
        stepIndex,
        model,
        messages: messages.map((message, index) =>
          jsonValue(
            message,
            `OpenAI trace ${traceId} input message ${index + 1}`,
            format,
          ),
        ),
        output: jsonValue(
          choice.message,
          `OpenAI trace ${traceId} response message`,
          format,
        ),
        usage: {
          inputTokens: tokenCount(
            usage.prompt_tokens,
            `OpenAI trace ${traceId} input usage`,
            format,
          ),
          outputTokens: tokenCount(
            usage.completion_tokens,
            `OpenAI trace ${traceId} output usage`,
            format,
          ),
        },
        trajectoryId: traceId,
      };
      const systemPrompt = systemMessages
        .map((message) => textParts(message.content))
        .filter((value): value is string => value !== undefined)
        .join("\n");
      if (systemPrompt !== "") step.systemPrompt = systemPrompt;
      const family = optionalString(record.name);
      if (family !== undefined) step.family = family;
      const timestamp = optionalString(record.timestamp);
      if (timestamp !== undefined) step.timestamp = timestamp;
      return step;
    });

    return normalizedRunSchema.parse({
      version: "2",
      traceId,
      sourceFormat: format,
      steps,
    });
  });
}

export const otelGenAiAdapter: NamedTraceAdapter = {
  name: "otel-genai",
  detect: otelConfidence,
  adapt: adaptOtel,
};

export const openAiJsonlAdapter: NamedTraceAdapter = {
  name: "openai-jsonl",
  detect: openAiConfidence,
  adapt: adaptOpenAi,
};

export const traceAdapters = [
  otelGenAiAdapter,
  openAiJsonlAdapter,
] as const satisfies readonly NamedTraceAdapter[];
