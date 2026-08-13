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

const format = "claude-code";
const metadataTypes = new Set([
  "agent-name",
  "ai-title",
  "attachment",
  "file-history-delta",
  "file-history-snapshot",
  "frame-link",
  "last-prompt",
  "mode",
  "permission-mode",
  "pr-link",
  "queue-operation",
  "result",
  "started",
  "system",
]);

function confidence(sample: unknown): number {
  const records = sampleRecords(sample).filter(isRecord);
  if (records.length === 0) return 0;
  const matching = records.filter(
    (record) =>
      (record.type === "user" || record.type === "assistant") &&
      typeof record.sessionId === "string" &&
      typeof record.uuid === "string" &&
      "parentUuid" in record &&
      isRecord(record.message),
  ).length;
  return matching === 0 ? 0 : 0.75 + 0.25 * (matching / records.length);
}

interface TranscriptRecord {
  record: Record<string, unknown>;
  recordIndex: number;
}

interface AssistantGroup {
  sessionId: string;
  messageId: string;
  model: string;
  parentUuid: string;
  timestamp?: string;
  rows: TranscriptRecord[];
}

function ancestorUsers(
  parentUuid: string,
  recordsByUuid: ReadonlyMap<string, Record<string, unknown>>,
  stopAtAssistant: boolean,
): Record<string, unknown>[] {
  const users: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let currentUuid: string | undefined = parentUuid;
  while (currentUuid !== undefined && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    const current = recordsByUuid.get(currentUuid);
    if (current === undefined) break;
    if (current.type === "assistant" && stopAtAssistant) break;
    if (current.type === "user") users.push(current);
    currentUuid = optionalString(current.parentUuid);
  }
  return users;
}

function trajectoryId(
  group: AssistantGroup,
  recordsByUuid: ReadonlyMap<string, Record<string, unknown>>,
): string {
  const users = ancestorUsers(group.parentUuid, recordsByUuid, false);
  for (const user of users) {
    const promptId = optionalString(user.promptId);
    if (promptId !== undefined) return promptId;
  }
  return optionalString(users.at(-1)?.uuid) ?? group.sessionId;
}

function adaptWithReport(records: unknown): TraceAdaptResult {
  const source = recordList(records, format, "Claude Code transcript");
  const droppedRecords: DroppedTraceRecord[] = [];
  const recordsByUuid = new Map<string, Record<string, unknown>>();
  const groups = new Map<string, AssistantGroup>();

  for (const [recordIndex, candidate] of source.entries()) {
    if (!isRecord(candidate)) {
      droppedRecords.push({
        recordIndex,
        reason: "Claude Code transcript record must be an object",
      });
      continue;
    }
    const type = optionalString(candidate.type);
    if (type === undefined) {
      droppedRecords.push({ recordIndex, reason: "record type is missing" });
      continue;
    }
    const uuid = optionalString(candidate.uuid);
    if (uuid !== undefined) recordsByUuid.set(uuid, candidate);
    if (metadataTypes.has(type)) continue;
    if (type === "user") {
      if (
        optionalString(candidate.sessionId) === undefined ||
        uuid === undefined ||
        !isRecord(candidate.message)
      ) {
        droppedRecords.push({
          recordIndex,
          reason:
            "Claude Code user record is missing sessionId, uuid, or message",
        });
      }
      continue;
    }
    if (type !== "assistant") {
      droppedRecords.push({
        recordIndex,
        reason: `unsupported Claude Code record type ${type}`,
      });
      continue;
    }

    try {
      const sessionId = requiredString(
        candidate.sessionId,
        `Claude Code record ${recordIndex + 1} sessionId`,
        format,
      );
      const parentUuid = requiredString(
        candidate.parentUuid,
        `Claude Code record ${recordIndex + 1} parentUuid`,
        format,
      );
      const message = candidate.message;
      if (!isRecord(message) || !Array.isArray(message.content)) {
        throw new Error(
          "Claude Code assistant message content must be an array",
        );
      }
      const messageId = requiredString(
        message.id,
        `Claude Code record ${recordIndex + 1} message.id`,
        format,
      );
      const model = requiredString(
        message.model,
        `Claude Code record ${recordIndex + 1} message.model`,
        format,
      );
      if (!isRecord(message.usage)) {
        throw new Error(
          "Claude Code assistant message usage must be an object",
        );
      }
      tokenCount(
        message.usage.input_tokens,
        `Claude Code record ${recordIndex + 1} input usage`,
        format,
      );
      tokenCount(
        message.usage.output_tokens,
        `Claude Code record ${recordIndex + 1} output usage`,
        format,
      );
      const key = `${sessionId}:${messageId}`;
      const group = groups.get(key);
      if (group !== undefined) {
        if (group.model !== model) {
          throw new Error(
            "Claude Code assistant message changed model between rows",
          );
        }
        group.rows.push({ record: candidate, recordIndex });
        group.timestamp =
          optionalString(candidate.timestamp) ?? group.timestamp;
      } else {
        groups.set(key, {
          sessionId,
          messageId,
          model,
          parentUuid,
          timestamp: optionalString(candidate.timestamp),
          rows: [{ record: candidate, recordIndex }],
        });
      }
    } catch (error) {
      droppedRecords.push({
        recordIndex,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const groupedSteps = new Map<
    string,
    Array<{ order: number; step: NormalizedStep }>
  >();
  for (const group of groups.values()) {
    const content: unknown[] = [];
    let finalUsage: Record<string, unknown> = {};
    let order = Number.MAX_SAFE_INTEGER;
    for (const { record, recordIndex } of group.rows) {
      const message = record.message as Record<string, unknown>;
      content.push(...(message.content as unknown[]));
      finalUsage = message.usage as Record<string, unknown>;
      order = Math.min(order, recordIndex);
    }
    const inputs = ancestorUsers(
      group.parentUuid,
      recordsByUuid,
      true,
    ).reverse();
    const toolResults = inputs.flatMap((input) => {
      const message = input.message;
      return isRecord(message) && Array.isArray(message.content)
        ? message.content.filter(
            (block) => isRecord(block) && block.type === "tool_result",
          )
        : [];
    });
    const step: NormalizedStep = {
      stepIndex: 0,
      model: group.model,
      messages: inputs.map((input, index) =>
        jsonValue(
          input.message,
          `Claude Code message ${group.messageId} input ${index + 1}`,
          format,
        ),
      ),
      output: jsonValue(
        {
          role: "assistant",
          content,
          ...(toolResults.length === 0 ? {} : { toolResults }),
        },
        `Claude Code message ${group.messageId} output`,
        format,
      ),
      usage: {
        inputTokens: tokenCount(
          finalUsage.input_tokens,
          `Claude Code message ${group.messageId} input usage`,
          format,
        ),
        outputTokens: tokenCount(
          finalUsage.output_tokens,
          `Claude Code message ${group.messageId} output usage`,
          format,
        ),
      },
      trajectoryId: trajectoryId(group, recordsByUuid),
      ...(group.timestamp === undefined ? {} : { timestamp: group.timestamp }),
    };
    const steps = groupedSteps.get(group.sessionId) ?? [];
    steps.push({ order, step });
    groupedSteps.set(group.sessionId, steps);
  }

  const runs: NormalizedRun[] = [...groupedSteps.entries()].map(
    ([traceId, ordered]) => {
      ordered.sort((left, right) => left.order - right.order);
      return normalizedRunSchema.parse({
        version: "2",
        traceId,
        sourceFormat: format,
        steps: ordered.map(({ step }, stepIndex) => ({ ...step, stepIndex })),
      });
    },
  );
  return { runs, droppedRecords };
}

export const claudeCodeAdapter: NamedTraceAdapter = {
  name: format,
  detect: confidence,
  adapt(records) {
    const result = adaptWithReport(records);
    if (result.runs.length === 0 && result.droppedRecords.length === 0) {
      throw new TraceAdaptError(
        format,
        "No Claude Code assistant messages found",
      );
    }
    return strictRuns(format, result);
  },
  adaptWithReport,
};
