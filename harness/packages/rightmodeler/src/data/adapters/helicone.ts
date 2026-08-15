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

const format = "helicone";

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      typeof record.request_id === "string" &&
      typeof record.response_id === "string" &&
      typeof record.request_created_at === "string" &&
      "request_body" in record &&
      "response_body" in record &&
      ("prompt_tokens" in record || "request_properties" in record),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

export const heliconeAdapter = createRowAdapter({
  format,
  label: "Helicone request export",
  detect: confidence,
  mapRecord(record, recordIndex) {
    const requestId = requiredString(
      record.request_id,
      `Helicone record ${recordIndex + 1} request_id`,
      format,
    );
    const request = jsonEncodedValue(record.request_body);
    const response = jsonEncodedValue(record.response_body);
    if (!isRecord(request) || !isRecord(response)) {
      throw new Error(
        "Helicone request_body and response_body must be objects",
      );
    }
    const schema = isRecord(record.llmSchema) ? record.llmSchema : {};
    const schemaRequest = isRecord(schema.request) ? schema.request : {};
    const rawMessages = Array.isArray(request.messages)
      ? [...request.messages]
      : Array.isArray(schemaRequest.messages)
        ? [...schemaRequest.messages]
        : [request];
    const tools = Array.isArray(request.tools)
      ? request.tools
      : Array.isArray(schemaRequest.tools)
        ? schemaRequest.tools
        : [];
    if (tools.length > 0) rawMessages.push({ tools });
    const model = requiredString(
      record.model ??
        record.response_model ??
        record.request_model ??
        request.model ??
        schemaRequest.model,
      `Helicone record ${recordIndex + 1} model`,
      format,
    );
    const properties = isRecord(record.request_properties)
      ? record.request_properties
      : isRecord(record.properties)
        ? record.properties
        : {};
    const trajectoryId =
      optionalString(properties["Helicone-Session-Id"]) ?? requestId;
    const timestamp = optionalString(record.request_created_at);
    return [
      {
        traceId: trajectoryId,
        sortValue: timestamp,
        step: {
          stepIndex: 0,
          model,
          messages: rawMessages.map((message, index) =>
            jsonValue(
              message,
              `Helicone record ${recordIndex + 1} input ${index + 1}`,
              format,
            ),
          ),
          output: jsonValue(
            response,
            `Helicone record ${recordIndex + 1} response`,
            format,
          ),
          usage: {
            inputTokens: tokenCount(
              record.prompt_tokens,
              `Helicone record ${recordIndex + 1} prompt usage`,
              format,
            ),
            outputTokens: tokenCount(
              record.completion_tokens,
              `Helicone record ${recordIndex + 1} completion usage`,
              format,
            ),
          },
          trajectoryId,
          ...(timestamp === undefined ? {} : { timestamp }),
        },
      },
    ];
  },
});
