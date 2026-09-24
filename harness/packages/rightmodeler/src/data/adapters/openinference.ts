import {
  isRecord,
  jsonEncodedValue,
  jsonValue,
  optionalString,
  optionalUsage,
  otlpAttributes,
  otlpSpans,
  requiredString,
  sampleRecords,
  type TraceExclusionReason,
} from "./shared.js";
import {
  createRowAdapter,
  type ExcludedTraceEntry,
  type MappedTraceStep,
} from "./row-adapter.js";

const format = "openinference";
const redacted = "__REDACTED__";

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter((record) =>
    otlpSpans(record).some((span) => {
      const spanAttributes = otlpAttributes(span);
      return (
        typeof spanAttributes["openinference.span.kind"] === "string" &&
        Object.keys(spanAttributes).some((key) => key.startsWith("llm."))
      );
    }),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

function indexedMessages(
  spanAttributes: Record<string, unknown>,
  prefix: string,
): Record<string, unknown>[] {
  const messages = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(spanAttributes)) {
    const match = new RegExp(`^${prefix}\\.(\\d+)\\.message\\.(.+)$`).exec(key);
    if (match === null) continue;
    const index = Number(match[1]);
    const message = messages.get(index) ?? {};
    message[match[2]!] = jsonEncodedValue(value);
    messages.set(index, message);
  }
  return [...messages.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, message]) => message);
}

function toolDefinitions(spanAttributes: Record<string, unknown>): unknown[] {
  return Object.entries(spanAttributes).flatMap(([key, value]) =>
    /^llm\.tools\.\d+\.tool\.json_schema$/.test(key)
      ? [jsonEncodedValue(value)]
      : [],
  );
}

function exclusion(
  span: Record<string, unknown>,
  spanAttributes: Record<string, unknown>,
  inputMessages: readonly unknown[],
  outputMessages: readonly unknown[],
): TraceExclusionReason | undefined {
  if (optionalString(spanAttributes["rightmodeler.replay"]) !== undefined) {
    return "replay_traffic";
  }
  const statusCode = isRecord(span.status) ? span.status.code : undefined;
  if (
    statusCode === 2 ||
    statusCode === "STATUS_CODE_ERROR" ||
    (Array.isArray(span.events) &&
      span.events.some(
        (event) => isRecord(event) && event.name === "exception",
      ))
  ) {
    return "call_failed";
  }
  if (
    (spanAttributes["input.value"] === redacted &&
      inputMessages.length === 0) ||
    (spanAttributes["output.value"] === redacted && outputMessages.length === 0)
  ) {
    return "content_hidden";
  }
  return undefined;
}

function requestBody(
  spanAttributes: Record<string, unknown>,
): { model: string; messages: unknown[] } | undefined {
  const body = jsonEncodedValue(spanAttributes["input.value"]);
  if (!isRecord(body) || !Array.isArray(body.messages)) return undefined;
  const model = optionalString(body.model);
  return model === undefined ? undefined : { model, messages: body.messages };
}

function responseMessage(spanAttributes: Record<string, unknown>): unknown {
  const response = jsonEncodedValue(spanAttributes["output.value"]);
  if (
    !isRecord(response) ||
    !Array.isArray(response.choices) ||
    response.choices.length === 0
  ) {
    return undefined;
  }
  const choice: unknown = response.choices[0];
  return isRecord(choice) ? choice.message : undefined;
}

export const openInferenceAdapter = createRowAdapter({
  format,
  label: "OpenInference OTLP file export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const mapped: Array<MappedTraceStep | ExcludedTraceEntry> = [];
    for (const [spanIndex, span] of otlpSpans(record).entries()) {
      const spanAttributes = otlpAttributes(span);
      if (spanAttributes["openinference.span.kind"] !== "LLM") continue;
      const spanTraceId = requiredString(
        span.traceId,
        `OpenInference record ${recordIndex + 1} span ${spanIndex + 1} traceId`,
        format,
      );
      const traceId =
        optionalString(spanAttributes["session.id"]) ?? spanTraceId;
      const inputMessages = indexedMessages(
        spanAttributes,
        "llm.input_messages",
      );
      const outputMessages = indexedMessages(
        spanAttributes,
        "llm.output_messages",
      );
      const excluded = exclusion(
        span,
        spanAttributes,
        inputMessages,
        outputMessages,
      );
      if (excluded !== undefined) {
        mapped.push({ traceId, excluded });
        continue;
      }
      const recordedOutput =
        outputMessages.length > 0
          ? outputMessages
          : jsonEncodedValue(spanAttributes["output.value"]);
      const request = requestBody(spanAttributes);
      let model: string;
      let rawMessages: unknown[];
      let output: unknown;
      if (request === undefined) {
        model = requiredString(
          spanAttributes["llm.model_name"],
          `OpenInference record ${recordIndex + 1} span ${spanIndex + 1} model`,
          format,
        );
        rawMessages = inputMessages;
        if (
          rawMessages.length === 0 &&
          spanAttributes["input.value"] !== undefined
        ) {
          const input = jsonEncodedValue(spanAttributes["input.value"]);
          rawMessages = Array.isArray(input) ? input : [input];
        }
        const tools = toolDefinitions(spanAttributes);
        if (tools.length > 0) rawMessages.push({ tools });
        output = recordedOutput;
      } else {
        model = request.model;
        rawMessages = request.messages;
        output = responseMessage(spanAttributes) ?? recordedOutput;
      }
      const usage = optionalUsage(
        spanAttributes["llm.token_count.prompt"],
        spanAttributes["llm.token_count.completion"],
        `OpenInference record ${recordIndex + 1}`,
        format,
      );
      const family =
        optionalString(spanAttributes["rightmodeler.family"]) ??
        optionalString(span.name);
      mapped.push({
        traceId,
        sortValue: optionalString(span.startTimeUnixNano),
        step: {
          stepIndex: 0,
          model,
          messages: rawMessages.map((message, index) =>
            jsonValue(
              message,
              `OpenInference record ${recordIndex + 1} input ${index + 1}`,
              format,
            ),
          ),
          output: jsonValue(
            output,
            `OpenInference record ${recordIndex + 1} output`,
            format,
          ),
          ...(usage === undefined ? {} : { usage }),
          trajectoryId: traceId,
          ...(family === undefined ? {} : { family }),
          ...(optionalString(span.startTimeUnixNano) === undefined
            ? {}
            : { timestamp: optionalString(span.startTimeUnixNano) }),
        },
      });
    }
    return mapped;
  },
});
