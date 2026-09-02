import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { harnessInputSchema } from "../lib/schemas.js";

export const scanTool = defineTool({
  description:
    "Scan a repository for model call sites and persist the resumable harness state.",
  inputSchema: harnessInputSchema,
  async execute(input, ctx) {
    return (await runCli("scan", [], { ...input, signal: ctx.abortSignal }))
      .result;
  },
});

export default scanTool;
