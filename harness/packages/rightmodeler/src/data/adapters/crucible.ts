import {
  isRecord,
  jsonEncodedValue,
  jsonValue,
  optionalNonnegativeNumber,
  optionalString,
  optionalUsage,
  requiredString,
  sampleRecords,
  textParts,
} from "./shared.js";
import { createRowAdapter } from "./row-adapter.js";

const format = "crucible";
const supportedSchema = "crucible.span/1";
// Bodies a step is built from. When Crucible cuts one at its size cap, the call is incomplete.
const stepBodies = [
  "input",
  "output",
  "system_instructions",
  "tool_definitions",
];

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      typeof record.schema === "string" &&
      record.schema.startsWith("crucible.span/"),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

// An empty body is exported as an empty string.
function hasBody(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function isCut(span: Record<string, unknown>, field: string): boolean {
  return (
    (Array.isArray(span.truncated_fields) &&
      span.truncated_fields.includes(field)) ||
    span[`${field}_truncation`] === "cap_exceeded"
  );
}

// A cut body is a raw text prefix, no longer valid JSON, so it is read as opaque text.
function spanBody(span: Record<string, unknown>, field: string): unknown {
  return isCut(span, field) ? span[field] : jsonEncodedValue(span[field]);
}

// An indexed_messages body comes from flattened, indexed message keys. Crucible stores it rebuilt as the
// message array, in index order; a body that holds each message under its index is read in index order too.
function messagesByIndex(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return [...value];
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => /^\d+$/.test(key))
  ) {
    return undefined;
  }
  return Object.entries(value)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, message]) => message);
}

export const crucibleAdapter = createRowAdapter({
  format,
  label: "Crucible span export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const label = `Crucible record ${recordIndex + 1}`;
    if (record.schema !== supportedSchema) {
      throw new Error(
        `${label} has schema ${String(record.schema)}; this rightmodeler reads ${supportedSchema}`,
      );
    }
    const span = record.span;
    if (!isRecord(span)) throw new Error(`${label} span must be an object`);
    if (span.observation_type !== "generation") return null;
    const traceId = requiredString(span.trace_id, `${label} trace_id`, format);
    const attributes = spanBody(span, "attributes");
    const metadata = spanBody(span, "metadata");
    // A rightmodeler key set as a span attribute stays in the residual attributes; one set under
    // crucible.metadata. lands in metadata.
    const marker = (key: string) =>
      optionalString(isRecord(attributes) ? attributes[key] : undefined) ??
      optionalString(isRecord(metadata) ? metadata[key] : undefined);
    if (marker("rightmodeler.replay") !== undefined) {
      return [{ traceId, excluded: "replay_traffic" }];
    }
    if (span.status_code === "error") {
      return [{ traceId, excluded: "call_failed" }];
    }
    if (stepBodies.some((field) => isCut(span, field))) {
      return [{ traceId, excluded: "content_truncated" }];
    }
    if (
      !hasBody(span.output) &&
      (!Array.isArray(span.finish_reasons) || span.finish_reasons.length === 0)
    ) {
      return [{ traceId, excluded: "stream_incomplete" }];
    }
    if (!hasBody(span.input) || !hasBody(span.output)) {
      return [{ traceId, excluded: "content_hidden" }];
    }

    const model = requiredString(
      optionalString(span.model_response) ?? span.model_requested,
      `${label} model`,
      format,
    );
    const indexed = span.io_shape === "indexed_messages";
    const input = spanBody(span, "input");
    const indexedInput = indexed ? messagesByIndex(input) : undefined;
    if (indexed && indexedInput === undefined) {
      throw new Error(
        `${label} input must be a message array or an object keyed by message index`,
      );
    }
    const messages =
      indexedInput ??
      (span.io_shape === "genai_messages" && Array.isArray(input)
        ? [...input]
        : isRecord(input) && Array.isArray(input.messages)
          ? [...input.messages]
          : [input]);
    // A call that offered tools, or called one, carries its definitions, which keeps it out of
    // replay.
    const tools = hasBody(span.tool_definitions)
      ? spanBody(span, "tool_definitions")
      : [];
    const offered = Array.isArray(tools)
      ? tools.length > 0
      : !isRecord(tools) || Object.keys(tools).length > 0;
    if (
      offered ||
      (typeof span.tool_call_count === "number" && span.tool_call_count > 0)
    ) {
      messages.push({ tool_definitions: tools });
    }
    // io_shape is the input's shape, so an indexed call's output is read by index only when it was
    // recorded that way.
    const recordedOutput = spanBody(span, "output");
    const output =
      (indexed ? messagesByIndex(recordedOutput) : undefined) ?? recordedOutput;
    const systemPrompt = optionalString(
      textParts(spanBody(span, "system_instructions")),
    );
    const usage = isRecord(span.usage) ? span.usage : {};
    const stepUsage = optionalUsage(usage.input, usage.output, label, format);
    // Without a price row Crucible records a cost of 0, which is unknown, not free.
    const costUsd =
      span.cost_source === "none"
        ? undefined
        : optionalNonnegativeNumber(
            span.total_cost_usd,
            `${label} total_cost_usd`,
            format,
          );
    const durationUs = optionalNonnegativeNumber(
      span.duration_us,
      `${label} duration_us`,
      format,
    );
    const timestamp = optionalString(span.start_time);
    const family =
      marker("rightmodeler.family") ?? optionalString(span.prompt_name);
    return [
      {
        traceId,
        sortValue: timestamp,
        step: {
          stepIndex: 0,
          model,
          messages: messages.map((message, index) =>
            jsonValue(message, `${label} input ${index + 1}`, format),
          ),
          output: jsonValue(output, `${label} output`, format),
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
          ...(stepUsage === undefined ? {} : { usage: stepUsage }),
          ...(costUsd === undefined ? {} : { costUsd }),
          ...(durationUs === undefined
            ? {}
            : { durationMs: durationUs / 1000 }),
          trajectoryId: optionalString(span.session_id) ?? traceId,
          ...(timestamp === undefined ? {} : { timestamp }),
          ...(family === undefined ? {} : { family }),
        },
      },
    ];
  },
});
