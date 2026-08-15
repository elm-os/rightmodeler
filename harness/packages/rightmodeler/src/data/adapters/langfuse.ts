import {
  isRecord,
  jsonEncodedValue,
  jsonValue,
  optionalString,
  requiredString,
  sampleRecords,
  tokenCount,
} from "./shared.js";
import { createRowAdapter } from "./row-adapter.js";

const format = "langfuse";

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      typeof record.trace_id === "string" &&
      "parent_observation_id" in record &&
      typeof record.type === "string" &&
      ["GENERATION", "SPAN", "TOOL", "AGENT", "CHAIN"].includes(record.type) &&
      ("provided_model_name" in record || "usage_details" in record),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

export const langfuseAdapter = createRowAdapter({
  format,
  label: "Langfuse observation export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    if (record.type !== "GENERATION") return [];
    const traceId = requiredString(
      record.trace_id,
      `Langfuse record ${recordIndex + 1} trace_id`,
      format,
    );
    const model = requiredString(
      record.provided_model_name,
      `Langfuse record ${recordIndex + 1} provided_model_name`,
      format,
    );
    const input = jsonEncodedValue(record.input);
    const output = jsonEncodedValue(record.output);
    const inputObject = isRecord(input) ? input : undefined;
    const rawMessages = Array.isArray(inputObject?.messages)
      ? inputObject.messages
      : [input];
    const messages = rawMessages.map((message, index) =>
      jsonValue(
        message,
        `Langfuse record ${recordIndex + 1} input ${index + 1}`,
        format,
      ),
    );
    if (record.tool_definitions !== undefined) {
      messages.push(
        jsonValue(
          { tool_definitions: record.tool_definitions },
          `Langfuse record ${recordIndex + 1} tool definitions`,
          format,
        ),
      );
    }
    const toolCalls = Array.isArray(record.tool_calls)
      ? record.tool_calls.map(jsonEncodedValue)
      : [];
    const usage = isRecord(record.usage_details) ? record.usage_details : {};
    const step = {
      stepIndex: 0,
      model,
      messages,
      output: jsonValue(
        toolCalls.length === 0 ? output : { value: output, toolCalls },
        `Langfuse record ${recordIndex + 1} output`,
        format,
      ),
      usage: {
        inputTokens: tokenCount(
          usage.input,
          `Langfuse record ${recordIndex + 1} input usage`,
          format,
        ),
        outputTokens: tokenCount(
          usage.output,
          `Langfuse record ${recordIndex + 1} output usage`,
          format,
        ),
      },
      trajectoryId:
        optionalString(record.session_id) ??
        requiredString(
          record.trace_id,
          `Langfuse record ${recordIndex + 1} trajectory`,
          format,
        ),
      ...(optionalString(record.prompt_name ?? record.name) === undefined
        ? {}
        : { family: optionalString(record.prompt_name ?? record.name) }),
      ...(optionalString(record.start_time) === undefined
        ? {}
        : { timestamp: optionalString(record.start_time) }),
    };
    return [{ traceId, sortValue: optionalString(record.start_time), step }];
  },
});
