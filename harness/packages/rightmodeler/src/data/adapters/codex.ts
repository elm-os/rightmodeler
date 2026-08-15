import {
  normalizedRunSchema,
  type NormalizedRun,
  type NormalizedStep,
} from "../normalized-run.js";
import {
  TraceAdaptError,
  isRecord,
  jsonValue,
  optionalString,
  recordList,
  requiredString,
  sampleRecords,
  strictRuns,
  tokenCount,
  type DroppedTraceRecord,
  type NamedTraceAdapter,
  type TraceAdaptResult,
} from "./shared.js";

const format = "codex";
const metadataTypes = new Set([
  "compacted",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "security_risk_score",
  "world_state",
]);

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  const meta = records.some(
    (record) =>
      record.type === "session_meta" &&
      isRecord(record.payload) &&
      typeof record.payload.id === "string" &&
      typeof record.payload.cwd === "string" &&
      typeof record.payload.cli_version === "string" &&
      typeof record.payload.model_provider === "string",
  );
  if (!meta) return 0;
  const content = records.some(
    (record) =>
      (record.type === "turn_context" ||
        record.type === "response_item" ||
        record.type === "event_msg") &&
      isRecord(record.payload),
  );
  return content ? 0.95 : 0.75;
}

interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}

interface TurnState {
  turnId: string;
  model: string;
  order: number;
  timestamp?: string;
  inputs: unknown[];
  outputs: unknown[];
  baselineUsage?: Usage;
  finalUsage?: Usage;
  lastUsage?: Usage;
}

function usage(value: unknown): Usage | undefined {
  return isRecord(value)
    ? {
        input_tokens: value.input_tokens,
        output_tokens: value.output_tokens,
      }
    : undefined;
}

function usageDelta(final: unknown, baseline: unknown): unknown {
  if (typeof final !== "number") return final;
  return typeof baseline === "number" ? Math.max(0, final - baseline) : final;
}

function adaptWithReport(records: unknown): TraceAdaptResult {
  const source = recordList(records, format, "Codex rollout");
  const droppedRecords: DroppedTraceRecord[] = [];
  const turns = new Map<string, TurnState>();
  let traceId: string | undefined;
  let activeTurn: TurnState | undefined;
  let cumulativeUsage: Usage | undefined;

  for (const [recordIndex, candidate] of source.entries()) {
    if (!isRecord(candidate) || !isRecord(candidate.payload)) {
      droppedRecords.push({
        recordIndex,
        reason: "Codex rollout record must contain an object payload",
      });
      continue;
    }
    const type = optionalString(candidate.type);
    const payload = candidate.payload;
    if (type === undefined) {
      droppedRecords.push({ recordIndex, reason: "record type is missing" });
      continue;
    }
    if (metadataTypes.has(type)) continue;
    if (type === "session_meta") {
      try {
        const id = requiredString(
          payload.id ?? payload.session_id,
          `Codex record ${recordIndex + 1} session id`,
          format,
        );
        if (traceId === undefined) traceId = id;
      } catch (error) {
        droppedRecords.push({
          recordIndex,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (type === "turn_context") {
      try {
        const turnId = requiredString(
          payload.turn_id,
          `Codex record ${recordIndex + 1} turn_id`,
          format,
        );
        const model = requiredString(
          payload.model,
          `Codex record ${recordIndex + 1} model`,
          format,
        );
        activeTurn = {
          turnId,
          model,
          order: recordIndex,
          timestamp: optionalString(candidate.timestamp),
          inputs: [],
          outputs: [],
          baselineUsage: cumulativeUsage,
        };
        turns.set(turnId, activeTurn);
      } catch (error) {
        activeTurn = undefined;
        droppedRecords.push({
          recordIndex,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (type === "event_msg") {
      if (payload.type === "token_count" && activeTurn !== undefined) {
        try {
          const info = isRecord(payload.info) ? payload.info : {};
          const total = usage(info.total_token_usage);
          const last = usage(info.last_token_usage);
          for (const candidateUsage of [total, last]) {
            if (candidateUsage === undefined) continue;
            tokenCount(
              candidateUsage.input_tokens,
              `Codex record ${recordIndex + 1} input usage`,
              format,
            );
            tokenCount(
              candidateUsage.output_tokens,
              `Codex record ${recordIndex + 1} output usage`,
              format,
            );
          }
          if (total !== undefined) {
            activeTurn.finalUsage = total;
            cumulativeUsage = total;
          }
          if (last !== undefined) activeTurn.lastUsage = last;
        } catch (error) {
          droppedRecords.push({
            recordIndex,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      continue;
    }
    if (type !== "response_item") {
      droppedRecords.push({
        recordIndex,
        reason: `unsupported Codex rollout type ${type}`,
      });
      continue;
    }
    const passthrough = isRecord(
      payload.internal_chat_message_metadata_passthrough,
    )
      ? payload.internal_chat_message_metadata_passthrough
      : {};
    const turn =
      turns.get(optionalString(passthrough.turn_id) ?? "") ?? activeTurn;
    if (turn === undefined) {
      droppedRecords.push({
        recordIndex,
        reason: "Codex response item has no turn context",
      });
      continue;
    }
    const payloadType = optionalString(payload.type);
    if (payloadType === "message" || payloadType === "agent_message") {
      if (!Array.isArray(payload.content)) {
        droppedRecords.push({
          recordIndex,
          reason: "Codex message content must be an array",
        });
      } else if (payload.role === "user") {
        turn.inputs.push(payload);
      } else if (
        payload.role === "assistant" ||
        payloadType === "agent_message"
      ) {
        turn.outputs.push(payload);
      }
      continue;
    }
    if (
      payloadType === "function_call" ||
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call" ||
      payloadType === "custom_tool_call_output" ||
      payloadType === "web_search_call" ||
      payloadType === "tool_search_call" ||
      payloadType === "tool_search_output"
    ) {
      turn.outputs.push(payload);
      continue;
    }
    if (payloadType === "reasoning") continue;
    droppedRecords.push({
      recordIndex,
      reason: `unsupported Codex response item ${payloadType ?? "<missing>"}`,
    });
  }

  const runs: NormalizedRun[] = [];
  if (traceId !== undefined) {
    const ordered = [...turns.values()]
      .filter((turn) => turn.outputs.length > 0)
      .sort((left, right) => left.order - right.order);
    const steps: NormalizedStep[] = ordered.map((turn, stepIndex) => {
      const final = turn.finalUsage;
      const baseline = turn.baselineUsage;
      const selected = final ?? turn.lastUsage ?? {};
      return {
        stepIndex,
        model: turn.model,
        messages: turn.inputs.map((message, index) =>
          jsonValue(
            message,
            `Codex turn ${turn.turnId} input ${index + 1}`,
            format,
          ),
        ),
        output: jsonValue(
          turn.outputs,
          `Codex turn ${turn.turnId} output`,
          format,
        ),
        usage: {
          inputTokens: tokenCount(
            final === undefined
              ? selected.input_tokens
              : usageDelta(final.input_tokens, baseline?.input_tokens),
            `Codex turn ${turn.turnId} input usage`,
            format,
          ),
          outputTokens: tokenCount(
            final === undefined
              ? selected.output_tokens
              : usageDelta(final.output_tokens, baseline?.output_tokens),
            `Codex turn ${turn.turnId} output usage`,
            format,
          ),
        },
        trajectoryId: turn.turnId,
        ...(turn.timestamp === undefined ? {} : { timestamp: turn.timestamp }),
      };
    });
    if (steps.length > 0) {
      runs.push(
        normalizedRunSchema.parse({
          version: "2",
          traceId,
          sourceFormat: format,
          steps,
        }),
      );
    }
  }
  return { runs, droppedRecords };
}

export const codexAdapter: NamedTraceAdapter = {
  name: format,
  detect: confidence,
  adapt(records) {
    const result = adaptWithReport(records);
    if (result.runs.length === 0 && result.droppedRecords.length === 0) {
      throw new TraceAdaptError(format, "No Codex model turns found");
    }
    return strictRuns(format, result);
  },
  adaptWithReport,
};
