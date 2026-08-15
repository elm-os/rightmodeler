import { defineTool } from "eve/tools";

import { applySwaps } from "@rightmodeler/cli";
import { machineApproval } from "../lib/approval.js";
import { openSwapPrInputSchema } from "../lib/schemas.js";

export const openSwapPrTool = defineTool({
  description:
    "Run every machine gate and open the harness's draft model-swap pull request. This tool never merges and has no force path.",
  inputSchema: openSwapPrInputSchema,
  approval: machineApproval,
  async execute(input) {
    return applySwaps(input);
  },
});

export default openSwapPrTool;
