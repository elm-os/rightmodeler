import {
  normalizedRunSchema,
  type NormalizedRun,
  type NormalizedStep,
} from "./normalized-run.js";
import {
  TraceAdaptError,
  compareStartValues,
  isRecord,
  jsonEncodedValue,
  jsonValue,
  optionalNonnegativeNumber,
  optionalString,
  optionalUsage,
  otlpAttributes,
  otlpSpans,
  requiredString,
  sampleRecords,
  strictRuns,
  textParts,
  tokenCount,
  type NamedTraceAdapter,
  type DroppedTraceRecord,
  type TraceAdaptResult,
} from "./adapters/shared.js";
import {
  adaptSpans,
  type SpanStep,
  type SpanTree,
  type TraceSpan,
} from "./adapters/spans.js";
import { aiSdkAdapter } from "./adapters/ai-sdk.js";
import { bifrostAdapter } from "./adapters/bifrost.js";
import { braintrustAdapter } from "./adapters/braintrust.js";
import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { heliconeAdapter } from "./adapters/helicone.js";
import { langfuseAdapter } from "./adapters/langfuse.js";
import { langsmithAdapter } from "./adapters/langsmith.js";
import { openInferenceAdapter } from "./adapters/openinference.js";
import { weaveAdapter } from "./adapters/weave.js";

export * from "./adapters/shared.js";
export { aiSdkAdapter } from "./adapters/ai-sdk.js";
export { bifrostAdapter } from "./adapters/bifrost.js";
export { braintrustAdapter } from "./adapters/braintrust.js";
export { claudeCodeAdapter } from "./adapters/claude-code.js";
export { codexAdapter } from "./adapters/codex.js";
export { heliconeAdapter } from "./adapters/helicone.js";
export { langfuseAdapter } from "./adapters/langfuse.js";
export { langsmithAdapter } from "./adapters/langsmith.js";
export { openInferenceAdapter } from "./adapters/openinference.js";
export { weaveAdapter } from "./adapters/weave.js";

function otelSpans(records: unknown[]): unknown[] {
  return records.flatMap((record) =>
    isRecord(record) && Array.isArray(record.resourceSpans)
      ? otlpSpans(record).map((span) => ({
          ...span,
          attributes: otlpAttributes(span),
        }))
      : [record],
  );
}

function otelConfidence(sample: unknown): number {
  const records = otelSpans(sampleRecords(sample)).filter(isRecord);
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

const structuralOperations = new Set([
  "agent_step",
  "execute_tool",
  "create_agent",
  "embeddings",
  "rerank",
]);

function isInference(span: TraceSpan): boolean {
  const operation = span.attributes["gen_ai.operation.name"];
  return (
    typeof operation === "string" &&
    !structuralOperations.has(operation) &&
    operation !== "invoke_agent"
  );
}

function hasInferenceDescendant(
  span: TraceSpan,
  tree: SpanTree,
  seen = new Set<TraceSpan>(),
): boolean {
  return tree.childrenOf(span).some((child) => {
    if (seen.has(child)) return false;
    seen.add(child);
    return isInference(child) || hasInferenceDescendant(child, tree, seen);
  });
}

function agentName(span: TraceSpan, tree: SpanTree): string | undefined {
  const seen = new Set<TraceSpan>();
  for (
    let parent = tree.parentOf(span);
    parent !== undefined && !seen.has(parent);
    parent = tree.parentOf(parent)
  ) {
    seen.add(parent);
    if (parent.attributes["gen_ai.operation.name"] === "invoke_agent") {
      return optionalString(parent.attributes["gen_ai.agent.name"]);
    }
  }
  return undefined;
}

function otelStep(span: TraceSpan, tree: SpanTree): SpanStep {
  const format = "otel-genai";
  const { attributes, sourceIndex } = span;
  const operation = attributes["gen_ai.operation.name"];
  if (typeof operation !== "string" || structuralOperations.has(operation)) {
    return { kind: "skip" };
  }
  if (operation === "invoke_agent" && hasInferenceDescendant(span, tree)) {
    return { kind: "skip" };
  }
  if (optionalString(attributes["rightmodeler.replay"]) !== undefined) {
    return { kind: "excluded", reason: "replay_traffic" };
  }
  if (
    attributes["gen_ai.output.messages"] === undefined &&
    attributes["gen_ai.response.finish_reasons"] === undefined
  ) {
    return { kind: "excluded", reason: "stream_incomplete" };
  }
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
    span.traceId,
    `OTel span ${sourceIndex + 1} trace ID`,
    format,
  );
  const model = requiredString(
    attributes["gen_ai.request.model"] ?? attributes["gen_ai.response.model"],
    `OTel trace ${traceId} model`,
    format,
  );
  const usage = optionalUsage(
    attributes["gen_ai.usage.input_tokens"],
    attributes["gen_ai.usage.output_tokens"],
    `OTel trace ${traceId}`,
    format,
  );
  const messages = jsonEncodedValue(attributes["gen_ai.input.messages"]);
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
  const systemPrompt = textParts(
    jsonEncodedValue(attributes["gen_ai.system_instructions"]),
  );
  const family =
    optionalString(attributes["rightmodeler.family"]) ??
    optionalString(attributes["gen_ai.prompt.name"]) ??
    optionalString(attributes["gen_ai.agent.name"]) ??
    agentName(span, tree);
  return {
    kind: "step",
    step: {
      model,
      messages: messages.map((message, index) =>
        jsonValue(
          message,
          `OTel trace ${traceId} input message ${index + 1}`,
          format,
        ),
      ),
      output: jsonValue(
        jsonEncodedValue(attributes["gen_ai.output.messages"]),
        `OTel trace ${traceId} output messages`,
        format,
      ),
      ...(usage === undefined ? {} : { usage }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(family === undefined ? {} : { family }),
    },
  };
}

function adaptOtelWithReport(records: unknown): TraceAdaptResult {
  return adaptSpans("otel-genai", "OTel", records, otelStep);
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
      const stepUsage = optionalUsage(
        usage.prompt_tokens,
        usage.completion_tokens,
        `OpenAI trace ${traceId}`,
        format,
      );
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
        ...(stepUsage === undefined ? {} : { usage: stepUsage }),
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
  format: "openai-jsonl",
  adapt: (records: unknown) => NormalizedRun[],
): TraceAdaptResult {
  if (!Array.isArray(records)) {
    throw new TraceAdaptError(format, `${format} trace records must be a list`);
  }

  const accepted: Array<{ record: unknown; recordIndex: number }> = [];
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

  return {
    runs:
      accepted.length === 0 ? [] : adapt(accepted.map(({ record }) => record)),
    droppedRecords,
  };
}

export const otelGenAiAdapter: NamedTraceAdapter = {
  name: "otel-genai",
  detect: otelConfidence,
  adapt: (records) => {
    const result = adaptOtelWithReport(records);
    if (result.runs.length === 0 && result.droppedRecords.length === 0) {
      throw new TraceAdaptError(
        "otel-genai",
        "No OTel GenAI inference spans found",
      );
    }
    return strictRuns("otel-genai", result);
  },
  adaptWithReport: adaptOtelWithReport,
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
  aiSdkAdapter,
  openAiJsonlAdapter,
  langfuseAdapter,
  braintrustAdapter,
  langsmithAdapter,
  openInferenceAdapter,
  heliconeAdapter,
  weaveAdapter,
  claudeCodeAdapter,
  codexAdapter,
  bifrostAdapter,
] as const satisfies readonly NamedTraceAdapter[];
