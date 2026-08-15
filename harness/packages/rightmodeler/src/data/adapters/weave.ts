import {
  isRecord,
  jsonValue,
  optionalString,
  requiredString,
  sampleRecords,
  tokenCount,
} from "./shared.js";
import { createRowAdapter } from "./row-adapter.js";

const format = "weave";

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      typeof record.id === "string" &&
      typeof record.trace_id === "string" &&
      typeof record.op_name === "string" &&
      typeof record.started_at === "string" &&
      isRecord(record.inputs) &&
      ("parent_id" in record || isRecord(record.summary)),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

export const weaveAdapter = createRowAdapter({
  format,
  label: "W&B Weave call export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const traceId = requiredString(
      record.trace_id,
      `Weave record ${recordIndex + 1} trace_id`,
      format,
    );
    const inputs = isRecord(record.inputs) ? record.inputs : undefined;
    if (inputs === undefined) throw new Error("Weave inputs must be an object");
    const model = requiredString(
      inputs.model,
      `Weave record ${recordIndex + 1} inputs.model`,
      format,
    );
    const rawMessages = Array.isArray(inputs.messages)
      ? [...inputs.messages]
      : [inputs];
    if (Array.isArray(inputs.tools)) rawMessages.push({ tools: inputs.tools });
    const summary = isRecord(record.summary) ? record.summary : {};
    const usageByModel = isRecord(summary.usage) ? summary.usage : {};
    const usage = isRecord(usageByModel[model])
      ? usageByModel[model]
      : (Object.values(usageByModel).find(isRecord) ?? {});
    const timestamp = optionalString(record.started_at);
    const family = optionalString(record.display_name ?? record.op_name);
    return [
      {
        traceId,
        sortValue: timestamp,
        step: {
          stepIndex: 0,
          model,
          messages: rawMessages.map((message, index) =>
            jsonValue(
              message,
              `Weave record ${recordIndex + 1} input ${index + 1}`,
              format,
            ),
          ),
          output: jsonValue(
            record.output,
            `Weave record ${recordIndex + 1} output`,
            format,
          ),
          usage: {
            inputTokens: tokenCount(
              usage.prompt_tokens,
              `Weave record ${recordIndex + 1} prompt usage`,
              format,
            ),
            outputTokens: tokenCount(
              usage.completion_tokens,
              `Weave record ${recordIndex + 1} completion usage`,
              format,
            ),
          },
          trajectoryId: traceId,
          ...(family === undefined ? {} : { family }),
          ...(timestamp === undefined ? {} : { timestamp }),
        },
      },
    ];
  },
});
