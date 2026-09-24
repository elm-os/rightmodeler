import {
  adaptSpans,
  traceSpans,
  type SpanStep,
  type TraceSpan,
} from "./spans.js";
import {
  TraceAdaptError,
  isRecord,
  jsonEncodedValue,
  jsonValue,
  optionalString,
  optionalUsage,
  recordList,
  requiredString,
  sampleRecords,
  strictRuns,
  type NamedTraceAdapter,
  type TraceAdaptResult,
} from "./shared.js";

const format = "ai-sdk";
const stepOperations = new Set([
  "ai.generateText.doGenerate",
  "ai.streamText.doStream",
  "ai.generateObject.doGenerate",
  "ai.streamObject.doStream",
]);
const objectOperations = new Set([
  "ai.generateObject.doGenerate",
  "ai.streamObject.doStream",
]);
const finishReasons: Record<string, string> = {
  stop: "stop",
  length: "length",
  "content-filter": "content_filter",
  "tool-calls": "tool_call",
  error: "error",
  other: "stop",
  unknown: "stop",
};

function isAiOperation(span: TraceSpan): boolean {
  const operation = span.attributes["ai.operationId"];
  return typeof operation === "string" && operation.startsWith("ai.");
}

function detect(sample: unknown): number {
  const spans = traceSpans(sampleRecords(sample));
  if (spans.length === 0) return 0;
  const matching = spans.filter(isAiOperation).length;
  return matching === 0 ? 0 : 0.7 + 0.3 * (matching / spans.length);
}

function toolResponse(output: unknown): unknown {
  if (!isRecord(output)) return undefined;
  if (
    output.type === "text" ||
    output.type === "error-text" ||
    output.type === "json" ||
    output.type === "error-json"
  ) {
    return output.value;
  }
  if (output.type === "execution-denied") {
    return {
      denied: true,
      ...(output.reason === undefined ? {} : { reason: output.reason }),
    };
  }
  return output;
}

function inputPart(part: unknown): unknown {
  if (!isRecord(part)) return part;
  switch (part.type) {
    case "text":
      return { type: "text", content: part.text };
    case "reasoning":
      return { type: "reasoning", content: part.text };
    case "tool-call":
      return {
        type: "tool_call",
        id: part.toolCallId ?? null,
        name: part.toolName,
        arguments: jsonEncodedValue(part.input),
      };
    case "tool-result": {
      const response = toolResponse(part.output);
      return {
        type: "tool_call_response",
        id: part.toolCallId ?? null,
        ...(response === undefined ? {} : { response }),
      };
    }
    default:
      return part;
  }
}

function outputParts(
  attributes: Record<string, unknown>,
  label: string,
): unknown[] {
  const reasoning = attributes["ai.response.reasoning"];
  const text = attributes["ai.response.text"];
  const toolCalls = attributes["ai.response.toolCalls"];
  const parts: unknown[] = [];
  if (typeof reasoning === "string" && reasoning.length > 0) {
    parts.push({ type: "reasoning", content: reasoning });
  }
  if (typeof text === "string" && text.length > 0) {
    parts.push({ type: "text", content: text });
  }
  if (toolCalls !== undefined) {
    for (const call of recordList(
      jsonEncodedValue(toolCalls),
      format,
      `${label} ai.response.toolCalls`,
    )) {
      parts.push(
        isRecord(call)
          ? {
              type: "tool_call",
              id: call.toolCallId,
              name: call.toolName,
              arguments: jsonEncodedValue(call.input),
            }
          : call,
      );
    }
  }
  return parts;
}

function aiSdkStep(span: TraceSpan): SpanStep {
  const { attributes } = span;
  const operation = attributes["ai.operationId"];
  if (typeof operation !== "string" || !stepOperations.has(operation)) {
    return { kind: "skip" };
  }
  if (attributes["ai.response.finishReason"] === undefined) {
    return { kind: "excluded", reason: "stream_incomplete" };
  }

  const label = `AI SDK span ${span.sourceIndex + 1}`;
  const model = requiredString(
    attributes["ai.model.id"] ?? attributes["gen_ai.request.model"],
    `${label} model`,
    format,
  );
  const prompt = jsonEncodedValue(attributes["ai.prompt.messages"]);
  if (!Array.isArray(prompt)) {
    throw new TraceAdaptError(
      format,
      `${label} has no ai.prompt.messages; keep telemetry recordInputs enabled`,
    );
  }
  const system: string[] = [];
  const messages: unknown[] = [];
  for (const message of prompt) {
    if (
      isRecord(message) &&
      message.role === "system" &&
      typeof message.content === "string"
    ) {
      if (message.content.length > 0) system.push(message.content);
    } else if (isRecord(message)) {
      messages.push({
        role: message.role,
        parts:
          typeof message.content === "string"
            ? [{ type: "text", content: message.content }]
            : recordList(
                message.content,
                format,
                `${label} message content`,
              ).map(inputPart),
      });
    } else {
      messages.push(message);
    }
  }

  const objectOutput = objectOperations.has(operation);
  const outputKeys = objectOutput
    ? ["ai.response.object"]
    : ["ai.response.text", "ai.response.toolCalls", "ai.response.reasoning"];
  if (outputKeys.every((key) => attributes[key] === undefined)) {
    throw new TraceAdaptError(
      format,
      `${label} has no recorded output; keep telemetry recordOutputs enabled`,
    );
  }
  const parts = objectOutput
    ? [{ type: "text", content: String(attributes["ai.response.object"]) }]
    : outputParts(attributes, label);
  const finishReason = requiredString(
    attributes["ai.response.finishReason"],
    `${label} finish reason`,
    format,
  );

  const usage = optionalUsage(
    attributes["ai.usage.inputTokens"] ??
      attributes["gen_ai.usage.input_tokens"],
    attributes["ai.usage.outputTokens"] ??
      attributes["gen_ai.usage.output_tokens"],
    label,
    format,
  );
  const family =
    optionalString(attributes["rightmodeler.family"]) ??
    optionalString(attributes["ai.telemetry.functionId"]);
  return {
    kind: "step",
    step: {
      model,
      messages: messages.map((message, index) =>
        jsonValue(message, `${label} input message ${index + 1}`, format),
      ),
      output: jsonValue(
        [
          {
            role: "assistant",
            parts,
            finish_reason: finishReasons[finishReason] ?? finishReason,
          },
        ],
        `${label} output`,
        format,
      ),
      ...(usage === undefined ? {} : { usage }),
      ...(system.length === 0 ? {} : { systemPrompt: system.join("\n") }),
      ...(family === undefined ? {} : { family }),
    },
  };
}

function adaptWithReport(records: unknown): TraceAdaptResult {
  return adaptSpans(format, "AI SDK", records, aiSdkStep);
}

export const aiSdkAdapter: NamedTraceAdapter = {
  name: format,
  detect,
  adapt: (records) => {
    const result = adaptWithReport(records);
    if (result.runs.length === 0 && result.droppedRecords.length === 0) {
      throw new TraceAdaptError(format, "No AI SDK model call spans found");
    }
    return strictRuns(format, result);
  },
  adaptWithReport,
};
