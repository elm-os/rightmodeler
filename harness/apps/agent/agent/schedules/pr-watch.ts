import { defineSchedule } from "eve/schedules";

import { listWatchablePullRequests } from "@rightmodeler/cli";
import { runCli } from "../lib/cli.js";
import {
  handOffSchedule,
  scheduleGitHubTarget,
  scheduleHarnessInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "0 * * * *",
  async run(args) {
    const input = scheduleHarnessInput("pr-watch");
    const target = scheduleGitHubTarget("pr-watch");
    if (input === undefined || target === undefined) return;
    const tokenEnv =
      process.env.RIGHTMODELER_GITHUB_TOKEN_ENV ?? "GITHUB_TOKEN";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) {
      throw new Error(
        "RIGHTMODELER_GITHUB_TOKEN_ENV must name an environment variable",
      );
    }
    if (!process.env[tokenEnv]) {
      console.warn(`pr-watch schedule skipped: ${tokenEnv} is not configured`);
      return;
    }
    const pullRequests = await listWatchablePullRequests(input);
    const results = [];
    for (const { prNumber } of pullRequests) {
      results.push(
        (
          await runCli(
            "watch",
            [
              "--owner",
              target.owner,
              "--github-repo",
              target.repo,
              "--pr",
              String(prNumber),
              "--github-base-url",
              process.env.RIGHTMODELER_GITHUB_API_BASE_URL ??
                "https://api.github.com",
              "--github-token-env",
              tokenEnv,
            ],
            { ...input, acceptedExitCodes: [0, 1, 2] },
          )
        ).result,
      );
    }
    handOffSchedule(
      args,
      target,
      `Open and terminal-unended swap pull requests were reconciled once. Summarize actions and terminal watches:\n\n${JSON.stringify(results)}`,
    );
  },
});
