import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { resolveReplayInput } from "../lib/defaults.js";
import { replayCliArguments } from "../lib/replay.js";
import { replayStartInputSchema } from "../lib/schemas.js";

export const estimateCostTool = defineTool({
  description:
    "Project replay spend from the current corpus, real shortlist, and current provider catalog without making paid model calls.",
  inputSchema: replayStartInputSchema,
  async execute(input, ctx) {
    const resolved = resolveReplayInput(input);
    return (
      await runCli("estimate", replayCliArguments(resolved), {
        ...input,
        signal: ctx.abortSignal,
      })
    ).result;
  },
});

export default estimateCostTool;
