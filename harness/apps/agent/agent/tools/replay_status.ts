import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { replayStatusInputSchema } from "../lib/schemas.js";

export const replayStatusTool = defineTool({
  description:
    "Read one persisted replay run once, including progress and terminality. This tool never sleeps or polls internally.",
  inputSchema: replayStatusInputSchema,
  async execute(input) {
    return (await runCli("status", ["--run", input.runId], input)).result;
  },
});

export default replayStatusTool;
