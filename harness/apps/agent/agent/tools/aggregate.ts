import { defineTool } from "eve/tools";

import { runCli } from "../lib/cli.js";
import { harnessInputSchema } from "../lib/schemas.js";

export const aggregateTool = defineTool({
  description:
    "Aggregate terminal replay evidence into family verdicts using the resumable harness store.",
  inputSchema: harnessInputSchema,
  async execute(input) {
    return (await runCli("aggregate", [], input)).result;
  },
});

export default aggregateTool;
