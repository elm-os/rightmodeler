import {
  normalizedRunSchema,
  type NormalizedRun,
  type NormalizedStep,
} from "./normalized-run.js";
import {
  TraceAdaptError,
  compareStartValues,
  isRecord,
  jsonValue,
  optionalNonnegativeNumber,
  optionalString,
  requiredString,
  sampleRecords,
  startValue,
  textParts,
  tokenCount,
  type NamedTraceAdapter,
  type DroppedTraceRecord,
  type TraceAdaptResult,
} from "./adapters/shared.js";
import { braintrustAdapter } from "./adapters/braintrust.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { heliconeAdapter } from "./adapters/helicone.js";
import { langfuseAdapter } from "./adapters/langfuse.js";
import { langsmithAdapter } from "./adapters/langsmith.js";
import { openInferenceAdapter } from "./adapters/openinference.js";
import { weaveAdapter } from "./adapters/weave.js";

export * from "./adapters/shared.js";
export { braintrustAdapter } from "./adapters/braintrust.js";
export { claudeCodeAdapter } from "./adapters/claude-code.js";
export { codexAdapter } from "./adapters/codex.js";
export { heliconeAdapter } from "./adapters/helicone.js";
export { langfuseAdapter } from "./adapters/langfuse.js";
export { langsmithAdapter } from "./adapters/langsmith.js";
export { openInferenceAdapter } from "./adapters/openinference.js";
export { weaveAdapter } from "./adapters/weave.js";

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

  const grouped = new Map<
    string,
    Array<{ record: Record<string, unknown>; sourceIndex: number }>
  >();
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
    group.push({ record: candidate, sourceIndex: index });
    grouped.set(trajectoryId, group);
  }
  if (grouped.size === 0) {
    throw new TraceAdaptError(format, "OpenAI trace contains no records");
  }

  return [...grouped.entries()].map(([traceId, group]) => {
    group.sort(
      (left, right) =>
        compareStartValues(
          optionalString(left.record.timestamp),
          optionalString(right.record.timestamp),
        ) || left.sourceIndex - right.sourceIndex,
    );
    const steps = group.map(({ record }, stepIndex) => {
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
      const costUsd = optionalNonnegativeNumber(
        record.cost_usd ?? response.cost_usd,
        `OpenAI trace ${traceId} cost_usd`,
        format,
      );
      if (costUsd !== undefined) step.costUsd = costUsd;
      const durationMs = optionalNonnegativeNumber(
        record.duration_ms ?? response.duration_ms ?? record.latency_ms,
        `OpenAI trace ${traceId} duration_ms`,
        format,
      );
      if (durationMs !== undefined) step.durationMs = durationMs;
      if (record.evaluator !== undefined) {
        step.evaluator = jsonValue(
          record.evaluator,
          `OpenAI trace ${traceId} evaluator`,
          format,
        );
      }
      if (record.evaluator_version !== undefined) {
        step.evaluatorVersion = jsonValue(
          record.evaluator_version,
          `OpenAI trace ${traceId} evaluator version`,
          format,
        );
      }
      if (record.retry_count !== undefined) {
        step.retryCount = tokenCount(
          record.retry_count,
          `OpenAI trace ${traceId} retry count`,
          format,
        );
      }
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

function existingAdapterReport(
  records: unknown,
  format: "otel-genai" | "openai-jsonl",
  adapt: (records: unknown) => NormalizedRun[],
): TraceAdaptResult {
  if (!Array.isArray(records)) {
    throw new TraceAdaptError(format, `${format} trace records must be a list`);
  }

  let accepted: Array<{ record: unknown; recordIndex: number }> = [];
  const droppedRecords: DroppedTraceRecord[] = [];
  for (const [recordIndex, record] of records.entries()) {
    try {
      if (adapt([record]).length === 0) {
        droppedRecords.push({
          recordIndex,
          reason: "record does not contain a mappable model call",
        });
      } else {
        accepted.push({ record, recordIndex });
      }
    } catch (error) {
      droppedRecords.push({
        recordIndex,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (format === "otel-genai") {
    const traceCounts = new Map<string, number>();
    for (const { record } of accepted) {
      if (!isRecord(record)) continue;
      const traceId = optionalString(record.traceId ?? record.trace_id);
      if (traceId !== undefined) {
        traceCounts.set(traceId, (traceCounts.get(traceId) ?? 0) + 1);
      }
    }
    accepted = accepted.filter(({ record, recordIndex }) => {
      if (!isRecord(record)) return true;
      const traceId = optionalString(record.traceId ?? record.trace_id);
      if (
        traceId !== undefined &&
        (traceCounts.get(traceId) ?? 0) > 1 &&
        startValue(record) === undefined
      ) {
        droppedRecords.push({
          recordIndex,
          reason: `OTel trajectory ${traceId} is missing its start time`,
        });
        return false;
      }
      return true;
    });
  }

  return {
    runs:
      accepted.length === 0 ? [] : adapt(accepted.map(({ record }) => record)),
    droppedRecords,
  };
}

export const otelGenAiAdapter: NamedTraceAdapter = {
  name: "otel-genai",
  detect: otelConfidence,
  adapt: adaptOtel,
  adaptWithReport: (records) =>
    existingAdapterReport(records, "otel-genai", adaptOtel),
};

export const openAiJsonlAdapter: NamedTraceAdapter = {
  name: "openai-jsonl",
  detect: openAiConfidence,
  adapt: adaptOpenAi,
  adaptWithReport: (records) =>
    existingAdapterReport(records, "openai-jsonl", adaptOpenAi),
};

export const traceAdapters = [
  otelGenAiAdapter,
  openAiJsonlAdapter,
  langfuseAdapter,
  braintrustAdapter,
  langsmithAdapter,
  openInferenceAdapter,
  heliconeAdapter,
  weaveAdapter,
  claudeCodeAdapter,
  codexAdapter,
] as const satisfies readonly NamedTraceAdapter[];
