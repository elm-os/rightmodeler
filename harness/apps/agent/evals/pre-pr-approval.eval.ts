import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { approvalEvalMarker } from "../agent/lib/eval-model.js";
import { aggregateTool } from "../agent/tools/aggregate.js";
import { estimateCostTool } from "../agent/tools/estimate_cost.js";
import { openSwapPrTool } from "../agent/tools/open_swap_pr.js";
import { replayStartTool } from "../agent/tools/replay_start.js";
import { replayStatusTool } from "../agent/tools/replay_status.js";
import { reportTool } from "../agent/tools/report.js";
import { scanTool } from "../agent/tools/scan.js";
import { statusTool } from "../agent/tools/status.js";

const approvalFreeTools = [
  scanTool,
  estimateCostTool,
  statusTool,
  replayStartTool,
  replayStatusTool,
  aggregateTool,
  reportTool,
];

export default defineEval({
  description:
    "Proves every pre-pull-request tool omits approval or uses the machine-only never policy.",
  tags: ["offline"],
  async test(t) {
    await t.send(approvalEvalMarker);
    t.succeeded();
    t.usedNoTools();
    t.check(
      approvalFreeTools,
      satisfies<typeof approvalFreeTools>(
        (tools) => tools.every((tool) => tool.approval === undefined),
        "read and dispatch tools omit approval",
      ),
    );
    const approval = openSwapPrTool.approval;
    if (approval === undefined) {
      throw new Error("open_swap_pr must declare the never approval policy");
    }
    const policy = typeof approval === "function" ? approval : approval.request;
    t.check(
      await policy({} as Parameters<typeof policy>[0]),
      equals("not-applicable"),
    );
  },
});
