import {
  isRecord,
  jsonValue,
  optionalString,
  requiredString,
  sampleRecords,
  tokenCount,
} from "./shared.js";
import { createRowAdapter } from "./row-adapter.js";

const format = "braintrust";

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      typeof record.span_id === "string" &&
      typeof record.root_span_id === "string" &&
      isRecord(record.span_attributes) &&
      (Array.isArray(record.span_parents) || "experiment_id" in record),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

export const braintrustAdapter = createRowAdapter({
  format,
  label: "Braintrust span export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const attributes = isRecord(record.span_attributes)
      ? record.span_attributes
      : undefined;
    if (attributes?.type !== "llm") return [];
    const traceId = requiredString(
      record.root_span_id,
      `Braintrust record ${recordIndex + 1} root_span_id`,
      format,
    );
    const metadata = isRecord(record.metadata) ? record.metadata : {};
    const metrics = isRecord(record.metrics) ? record.metrics : {};
    const model = requiredString(
      metadata.model,
      `Braintrust record ${recordIndex + 1} metadata.model`,
      format,
    );
    const rawMessages = Array.isArray(record.input)
      ? record.input
      : [record.input];
    const timestamp = optionalString(record.created);
    return [
      {
        traceId,
        sortValue:
          typeof metrics.start === "number" ? String(metrics.start) : timestamp,
        step: {
          stepIndex: 0,
          model,
          messages: rawMessages.map((message, index) =>
            jsonValue(
              message,
              `Braintrust record ${recordIndex + 1} input ${index + 1}`,
              format,
            ),
          ),
          output: jsonValue(
            record.output,
            `Braintrust record ${recordIndex + 1} output`,
            format,
          ),
          usage: {
            inputTokens: tokenCount(
              metrics.prompt_tokens,
              `Braintrust record ${recordIndex + 1} prompt usage`,
              format,
            ),
            outputTokens: tokenCount(
              metrics.completion_tokens,
              `Braintrust record ${recordIndex + 1} completion usage`,
              format,
            ),
          },
          trajectoryId: traceId,
          ...(optionalString(attributes.name) === undefined
            ? {}
            : { family: optionalString(attributes.name) }),
          ...(timestamp === undefined ? {} : { timestamp }),
        },
      },
    ];
  },
});
