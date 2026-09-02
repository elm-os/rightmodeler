import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { harnessInputSchema } from "../lib/schemas.js";

export const statusTool = defineTool({
  description:
    "Read the harness store once and report its current stage, fact, corpus, and run state.",
  inputSchema: harnessInputSchema,
  async execute(input, ctx) {
    return (await runCli("status", [], { ...input, signal: ctx.abortSignal }))
      .result;
  },
});

export default statusTool;
