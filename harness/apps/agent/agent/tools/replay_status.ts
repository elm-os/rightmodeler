import { defineTool } from "eve/tools";

import { readReplayStatus } from "../lib/replay.js";
import { replayStatusInputSchema } from "../lib/schemas.js";

export const replayStatusTool = defineTool({
  description:
    "Read one replay run's append-only event record once. This tool never sleeps or polls internally.",
  inputSchema: replayStatusInputSchema,
  async execute(input) {
    return readReplayStatus(input.repo, input.store, input.runId);
  },
});

export default replayStatusTool;
