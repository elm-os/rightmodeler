import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { resolveReplayInput } from "../lib/defaults.js";
import { replayCliArguments } from "../lib/replay.js";
import { replayStartInputSchema } from "../lib/schemas.js";

export const replayStartTool = defineTool({
  description:
    "Claim a replay by its semantic run specification, launch it as detached work, and return immediately with a stable runId. Repeated identical dispatches return the existing runId.",
  inputSchema: replayStartInputSchema,
  async execute(input, ctx) {
    const resolved = resolveReplayInput(input);
    return (
      await runCli("replay", [...replayCliArguments(resolved), "--detach"], {
        ...input,
        signal: ctx.abortSignal,
      })
    ).result;
  },
});

export default replayStartTool;
