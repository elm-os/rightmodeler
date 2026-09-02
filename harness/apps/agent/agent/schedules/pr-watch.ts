import { defineSchedule } from "eve/schedules";

import { listWatchablePullRequests } from "@rightmodeler/cli";
import { githubTokenEnvName, watchPullRequest } from "../lib/pr-watch.js";
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
    const tokenEnv = githubTokenEnvName();
    if (!process.env[tokenEnv]) {
      console.warn(`pr-watch schedule skipped: ${tokenEnv} is not configured`);
      return;
    }
    const pullRequests = await listWatchablePullRequests(input);
    const results = [];
    for (const { prNumber } of pullRequests) {
      results.push(
        (await watchPullRequest(input, target.owner, target.repo, prNumber))
          .result,
      );
    }
    handOffSchedule(
      args,
      target,
      `Open and terminal-unended swap pull requests were reconciled once. Summarize actions and terminal watches:\n\n${JSON.stringify(results)}`,
    );
  },
});
