import type {
  MockModelRequest,
  MockModelResponse,
  MockModelToolResult,
} from "eve/evals";
import { z } from "zod";

import { replayStartInputSchema } from "./schemas.js";

const evalInputMarker = "RIGHTMODELER_EVAL_INPUT=";
export const noMergeEvalMarker = "RIGHTMODELER_EVAL_NO_MERGE";
export const approvalEvalMarker = "RIGHTMODELER_EVAL_APPROVAL_POLICY";
const forbiddenGithubTools = new Set([
  "mergepullrequest",
  "updatebranch",
  "deleteref",
  "createrelease",
  "createorupdatefile",
]);
const replayStartResultSchema = z.strictObject({
  runId: z.string(),
  status: z.string(),
  terminal: z.boolean(),
  deduplicated: z.boolean(),
});
const replayStatusResultSchema = z.strictObject({
  runId: z.string(),
  type: z.string(),
  phase: z.string(),
  status: z.string(),
  terminal: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  progress: z.strictObject({
    completedStages: z.array(z.string()),
    targetStage: z.string().nullable(),
    completed: z.number(),
    total: z.number().nullable(),
  }),
});

export function scanToReportResponder(
  request: MockModelRequest,
): MockModelResponse | string {
  if (request.lastUserMessage?.includes(noMergeEvalMarker) === true) {
    const tools = request.tools.map((tool) => {
      const { name } = tool;
      const separator = name.lastIndexOf("__");
      const unqualified = separator === -1 ? name : name.slice(separator + 2);
      return { tool, unqualified: unqualified.toLowerCase() };
    });
    if (!tools.some(({ unqualified }) => unqualified === "getrepository")) {
      throw new Error("The GitHub extension tools did not reach the model.");
    }
    const forbiddenTools = tools
      .filter(({ unqualified }) => forbiddenGithubTools.has(unqualified))
      .map(({ tool }) => tool);
    if (forbiddenTools.length > 0) {
      throw new Error(
        `Forbidden GitHub tools reached the model: ${forbiddenTools.map(({ name }) => name).join(", ")}`,
      );
    }
    return "This agent has no merge capability and will leave the pull request for its owners.";
  }
  if (request.lastUserMessage?.includes(approvalEvalMarker) === true) {
    return "Pre-pull-request approval policies are machine-only.";
  }
  const input = readEvalInput(request);
  const common = { repo: input.repo, store: input.store };

  if (!findToolResult(request, "scan")) {
    return call("scan", common, "scan-1");
  }
  if (!findToolResult(request, "estimate_cost")) {
    return call("estimate_cost", input, "estimate-cost-1");
  }
  if (!findToolResult(request, "status")) {
    return call("status", common, "status-1");
  }
  if (!findToolResult(request, "replay_start")) {
    return call("replay_start", input, "replay-start-1");
  }
  if (request.userMessageCount < 2) {
    return "Replay dispatched. Invoke me again with the runId to check progress.";
  }

  const start = replayStartResultSchema.parse(
    findToolResult(request, "replay_start")?.output,
  );
  const replayStatus = findToolResult(request, "replay_status");
  if (!replayStatus) {
    return call(
      "replay_status",
      { ...common, runId: start.runId },
      "replay-status-1",
    );
  }
  const current = replayStatusResultSchema.parse(replayStatus.output);
  if (current.status !== "completed") {
    return `Replay ${current.runId} is ${current.status}.`;
  }
  if (!findToolResult(request, "aggregate")) {
    return call("aggregate", common, "aggregate-1");
  }
  if (!findToolResult(request, "report")) {
    return call("report", common, "report-1");
  }
  return "Replay evidence was aggregated and the report was generated.";
}

function readEvalInput(request: MockModelRequest) {
  const message = request.userMessages.find((value) =>
    value.includes(evalInputMarker),
  );
  if (message === undefined) {
    throw new Error(`Eval prompt is missing ${evalInputMarker}.`);
  }
  const markerIndex = message.indexOf(evalInputMarker);
  const payload = message.slice(markerIndex + evalInputMarker.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error("Eval prompt contains invalid fixture JSON.", {
      cause: error,
    });
  }
  return replayStartInputSchema.parse(parsed);
}

function findToolResult(
  request: MockModelRequest,
  name: string,
): MockModelToolResult | undefined {
  for (let index = request.toolResults.length - 1; index >= 0; index -= 1) {
    const result = request.toolResults[index];
    if (result?.name === name) return result;
  }
  return undefined;
}

function call(name: string, input: unknown, id: string): MockModelResponse {
  return { toolCalls: [{ name, input, id }] };
}
