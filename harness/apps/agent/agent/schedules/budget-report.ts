import { defineSchedule } from "eve/schedules";

import { runCli } from "../lib/cli.js";
import { readAgentSpendSummary } from "../lib/persistence.js";
import {
  handOffSchedule,
  scheduleGitHubTarget,
  scheduleHarnessInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "0 17 * * 5",
  async run(args) {
    const input = scheduleHarnessInput("budget-report");
    const target = scheduleGitHubTarget("budget-report");
    if (input === undefined || target === undefined) return;
    const [harness, agentSpend] = await Promise.all([
      runCli("status", [], input),
      readAgentSpendSummary(),
    ]);
    handOffSchedule(
      args,
      target,
      `Prepare the scheduled budget report from harness state and supplemental agent-side spend. Keep the two ledgers distinct:\n\n${JSON.stringify({ harness: harness.result, agentSpend })}`,
    );
  },
});
