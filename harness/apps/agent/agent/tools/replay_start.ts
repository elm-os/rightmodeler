import { defineTool } from "eve/tools";

import { startReplay } from "../lib/replay.js";
import { replayStartInputSchema } from "../lib/schemas.js";

export const replayStartTool = defineTool({
  description:
    "Claim a replay by its semantic run specification, launch it as detached work, and return immediately with a stable runId. Repeated identical dispatches return the existing runId.",
  inputSchema: replayStartInputSchema,
  async execute(input) {
    return startReplay(input);
  },
});

export default replayStartTool;
