import {
  isRecord,
  jsonEncodedValue,
  jsonValue,
  optionalString,
  requiredString,
  sampleRecords,
  tokenCount,
} from "./shared.js";
import { createRowAdapter, type MappedTraceStep } from "./row-adapter.js";

const format = "openinference";

function otlpValue(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) {
    const parsed = Number(value.intValue);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  if ("doubleValue" in value) return value.doubleValue;
  if ("boolValue" in value) return value.boolValue;
  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map(otlpValue);
  }
  if (isRecord(value.kvlistValue) && Array.isArray(value.kvlistValue.values)) {
    return Object.fromEntries(
      value.kvlistValue.values.flatMap((item) =>
        isRecord(item) && typeof item.key === "string"
          ? [[item.key, otlpValue(item.value)]]
          : [],
      ),
    );
  }
  return undefined;
}

function attributes(span: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(span.attributes)) return {};
  return Object.fromEntries(
    span.attributes.flatMap((attribute) =>
      isRecord(attribute) && typeof attribute.key === "string"
        ? [[attribute.key, otlpValue(attribute.value)]]
        : [],
    ),
  );
}

function spans(record: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(record.resourceSpans)) return [];
  return record.resourceSpans.flatMap((resource) =>
    isRecord(resource) && Array.isArray(resource.scopeSpans)
      ? resource.scopeSpans.flatMap((scope) =>
          isRecord(scope) && Array.isArray(scope.spans)
            ? scope.spans.filter(isRecord)
            : [],
        )
      : [],
  );
}

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter((record) =>
    spans(record).some((span) => {
      const spanAttributes = attributes(span);
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

export const openInferenceAdapter = createRowAdapter({
  format,
  label: "OpenInference OTLP file export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const mapped: MappedTraceStep[] = [];
    for (const [spanIndex, span] of spans(record).entries()) {
      const spanAttributes = attributes(span);
      if (spanAttributes["openinference.span.kind"] !== "LLM") continue;
      const traceId = requiredString(
        span.traceId,
        `OpenInference record ${recordIndex + 1} span ${spanIndex + 1} traceId`,
        format,
      );
      const model = requiredString(
        spanAttributes["llm.model_name"],
        `OpenInference record ${recordIndex + 1} span ${spanIndex + 1} model`,
        format,
      );
      let rawMessages: unknown[] = indexedMessages(
        spanAttributes,
        "llm.input_messages",
      );
      if (
        rawMessages.length === 0 &&
        spanAttributes["input.value"] !== undefined
      ) {
        const input = jsonEncodedValue(spanAttributes["input.value"]);
        rawMessages = Array.isArray(input) ? input : [input];
      }
      const tools = toolDefinitions(spanAttributes);
      if (tools.length > 0) rawMessages.push({ tools });
      const outputMessages = indexedMessages(
        spanAttributes,
        "llm.output_messages",
      );
      const output =
        outputMessages.length > 0
          ? outputMessages
          : jsonEncodedValue(spanAttributes["output.value"]);
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
          usage: {
            inputTokens: tokenCount(
              spanAttributes["llm.token_count.prompt"],
              `OpenInference record ${recordIndex + 1} prompt usage`,
              format,
            ),
            outputTokens: tokenCount(
              spanAttributes["llm.token_count.completion"],
              `OpenInference record ${recordIndex + 1} completion usage`,
              format,
            ),
          },
          trajectoryId: optionalString(spanAttributes["session.id"]) ?? traceId,
          ...(optionalString(span.name) === undefined
            ? {}
            : { family: optionalString(span.name) }),
          ...(optionalString(span.startTimeUnixNano) === undefined
            ? {}
            : { timestamp: optionalString(span.startTimeUnixNano) }),
        },
      });
    }
    return mapped;
  },
});
