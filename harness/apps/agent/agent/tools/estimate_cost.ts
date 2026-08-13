import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { harnessInputSchema } from "../lib/schemas.js";

export const estimateCostTool = defineTool({
  description:
    "Preview the resumable pipeline before replay. The current CLI does not expose a dollar estimate, so this tool reports that limit explicitly instead of inventing one.",
  inputSchema: harnessInputSchema,
  async execute(input) {
    const plan = (await runCli("init", ["--plan"], input)).result;
    return {
      available: false,
      reason: "The installed CLI exposes a stage plan but no cost estimate.",
      plan,
    };
  },
});

export default estimateCostTool;
