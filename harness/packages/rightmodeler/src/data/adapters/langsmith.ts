import {
  isRecord,
  jsonValue,
  optionalString,
  requiredString,
  sampleRecords,
  tokenCount,
} from "./shared.js";
import { createRowAdapter } from "./row-adapter.js";

const format = "langsmith";

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      typeof record.trace_id === "string" &&
      typeof record.run_type === "string" &&
      typeof record.dotted_order === "string" &&
      (isRecord(record.inputs) || isRecord(record.outputs)),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

export const langsmithAdapter = createRowAdapter({
  format,
  label: "LangSmith bulk run export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    if (record.run_type !== "llm") return [];
    const traceId = requiredString(
      record.trace_id,
      `LangSmith record ${recordIndex + 1} trace_id`,
      format,
    );
    const inputs = isRecord(record.inputs) ? record.inputs : undefined;
    const outputs = isRecord(record.outputs) ? record.outputs : undefined;
    if (inputs === undefined || outputs === undefined) {
      throw new Error("LangSmith LLM run must contain inputs and outputs");
    }
    const extra = isRecord(record.extra) ? record.extra : {};
    const metadata = isRecord(extra.metadata)
      ? extra.metadata
      : isRecord(record.metadata)
        ? record.metadata
        : {};
    const invocation = isRecord(extra.invocation_params)
      ? extra.invocation_params
      : {};
    const model = requiredString(
      metadata.ls_model_name ?? invocation.model,
      `LangSmith record ${recordIndex + 1} model`,
      format,
    );
    const rawMessages = Array.isArray(inputs.messages)
      ? inputs.messages
      : [inputs];
    const timestamp = optionalString(record.start_time);
    return [
      {
        traceId,
        sortValue: optionalString(record.dotted_order),
        step: {
          stepIndex: 0,
          model,
          messages: rawMessages.map((message, index) =>
            jsonValue(
              message,
              `LangSmith record ${recordIndex + 1} input ${index + 1}`,
              format,
            ),
          ),
          output: jsonValue(
            outputs,
            `LangSmith record ${recordIndex + 1} outputs`,
            format,
          ),
          usage: {
            inputTokens: tokenCount(
              record.prompt_tokens,
              `LangSmith record ${recordIndex + 1} prompt usage`,
              format,
            ),
            outputTokens: tokenCount(
              record.completion_tokens,
              `LangSmith record ${recordIndex + 1} completion usage`,
              format,
            ),
          },
          trajectoryId:
            optionalString(
              metadata.thread_id ??
                metadata.session_id ??
                metadata.conversation_id,
            ) ?? traceId,
          ...(optionalString(record.name) === undefined
            ? {}
            : { family: optionalString(record.name) }),
          ...(timestamp === undefined ? {} : { timestamp }),
        },
      },
    ];
  },
});
