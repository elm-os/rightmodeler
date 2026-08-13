import { defineTool } from "eve/tools";

import { machineApproval } from "../lib/approval.js";
import { runCli } from "../lib/cli.js";
import { openSwapPrInputSchema } from "../lib/schemas.js";

export const openSwapPrTool = defineTool({
  description:
    "Run every machine gate and open the harness's draft model-swap pull request. This tool never merges and has no force path.",
  inputSchema: openSwapPrInputSchema,
  approval: machineApproval,
  async execute(input) {
    const args = [
      "--owner",
      input.owner,
      "--github-base-url",
      input.githubBaseUrl,
      "--github-token-env",
      input.githubTokenEnv,
    ];
    if (input.dryRun === true) args.push("--dry-run");
    return (
      await runCli("apply", args, {
        repo: input.repo,
        store: input.store,
        acceptedExitCodes: [0, 1],
      })
    ).result;
  },
});

export default openSwapPrTool;
