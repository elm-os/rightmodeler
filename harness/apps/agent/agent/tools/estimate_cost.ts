import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { replayCliArguments } from "../lib/replay.js";
import { replayStartInputSchema } from "../lib/schemas.js";

export const estimateCostTool = defineTool({
  description:
    "Project replay spend from the current corpus, real shortlist, and current provider catalog without making paid model calls.",
  inputSchema: replayStartInputSchema,
  async execute(input) {
    return (await runCli("estimate", replayCliArguments(input), input)).result;
  },
});

export default estimateCostTool;
