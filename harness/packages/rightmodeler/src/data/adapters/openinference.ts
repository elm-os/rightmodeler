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
} from "./shared.js";
import { createRowAdapter, type MappedTraceStep } from "./row-adapter.js";

const format = "openinference";

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

export const openInferenceAdapter = createRowAdapter({
  format,
  label: "OpenInference OTLP file export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const mapped: MappedTraceStep[] = [];
    for (const [spanIndex, span] of otlpSpans(record).entries()) {
      const spanAttributes = otlpAttributes(span);
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
      const usage = optionalUsage(
        spanAttributes["llm.token_count.prompt"],
        spanAttributes["llm.token_count.completion"],
        `OpenInference record ${recordIndex + 1}`,
        format,
      );
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
