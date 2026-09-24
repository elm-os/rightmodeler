import {
  isRecord,
  jsonValue,
  optionalNonnegativeNumber,
  optionalString,
  optionalUsage,
  requiredString,
  sampleRecords,
  tokenCount,
} from "./shared.js";
import { createRowAdapter } from "./row-adapter.js";

const format = "bifrost";
const chatObjects = new Set(["chat_completion", "chat_completion_stream"]);

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      Array.isArray(record.input_history) &&
      typeof record.provider === "string" &&
      typeof record.model === "string" &&
      typeof record.fallback_index === "number" &&
      typeof record.number_of_retries === "number",
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

export const bifrostAdapter = createRowAdapter({
  format,
  label: "Bifrost log export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const id = requiredString(
      record.id,
      `Bifrost record ${recordIndex + 1} id`,
      format,
    );
    const label = `Bifrost log ${id}`;
    if (typeof record.object !== "string" || !chatObjects.has(record.object)) {
      throw new Error(
        `${label} is not a chat completion (object ${String(record.object)}); export chat completions only (objects=chat_completion,chat_completion_stream)`,
      );
    }
    const traceId = optionalString(record.session_id) ?? id;
    const metadata = isRecord(record.metadata) ? record.metadata : {};
    if (metadata.rightmodeler === "replay") {
      return [{ traceId, excluded: "replay_traffic" }];
    }
    if (record.status === "processing") {
      return [{ traceId, excluded: "stream_incomplete" }];
    }
    if (record.status !== "success") {
      return [{ traceId, excluded: "call_failed" }];
    }
    if (
      typeof record.fallback_index === "number" &&
      record.fallback_index > 0
    ) {
      return [{ traceId, excluded: "fallback_answer" }];
    }
    if (record.content_hidden === true) {
      return [{ traceId, excluded: "content_hidden" }];
    }

    const provider = requiredString(
      record.provider,
      `${label} provider`,
      format,
    );
    const model = requiredString(record.model, `${label} model`, format);
    if (!Array.isArray(record.input_history)) {
      throw new Error(`${label} input_history must be a list`);
    }
    const tokenUsage = isRecord(record.token_usage) ? record.token_usage : {};
    const usage = optionalUsage(
      tokenUsage.prompt_tokens,
      tokenUsage.completion_tokens,
      label,
      format,
    );
    const costUsd = optionalNonnegativeNumber(
      record.cost,
      `${label} cost`,
      format,
    );
    const durationMs = optionalNonnegativeNumber(
      record.latency,
      `${label} latency`,
      format,
    );
    const timestamp = optionalString(record.timestamp);
    const family = optionalString(metadata["rightmodeler-family"]);
    return [
      {
        traceId,
        sortValue: timestamp,
        step: {
          stepIndex: 0,
          model: `${provider}/${optionalString(record.alias) ?? model}`,
          messages: record.input_history.map((message, index) =>
            jsonValue(message, `${label} input ${index + 1}`, format),
          ),
          output: jsonValue(record.output_message, `${label} output`, format),
          ...(usage === undefined ? {} : { usage }),
          ...(costUsd === undefined ? {} : { costUsd }),
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(record.number_of_retries === undefined
            ? {}
            : {
                retryCount: tokenCount(
                  record.number_of_retries,
                  `${label} number_of_retries`,
                  format,
                ),
              }),
          trajectoryId: traceId,
          ...(timestamp === undefined ? {} : { timestamp }),
          ...(family === undefined ? {} : { family }),
        },
      },
    ];
  },
});
