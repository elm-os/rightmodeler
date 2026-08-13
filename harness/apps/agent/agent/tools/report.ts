import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { harnessInputSchema } from "../lib/schemas.js";

export const reportTool = defineTool({
  description:
    "Write and return the harness report after every family has reached a terminal state.",
  inputSchema: harnessInputSchema,
  async execute(input) {
    return (await runCli("report", [], { ...input, acceptedExitCodes: [0, 1] }))
      .result;
  },
});

export default reportTool;
