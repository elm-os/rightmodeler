import { defineSchedule } from "eve/schedules";

import { runCli } from "../lib/cli.js";
import { terminalReplayHandoff } from "../lib/replay-watch.js";
import {
  claimScheduleHandoff,
  handOffSchedule,
  scheduleCliTimeoutMs,
  scheduleGitHubTarget,
  scheduleHarnessInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "*/15 * * * *",
  async run(args) {
    const input = scheduleHarnessInput("replay-watch");
    const target = scheduleGitHubTarget("replay-watch");
    if (input === undefined || target === undefined) return;
    const status = await runCli("status", [], {
      ...input,
      timeoutMs: scheduleCliTimeoutMs,
    });
    const handoff = terminalReplayHandoff(status.result);
    if (handoff === undefined) return;
    const claimed = await claimScheduleHandoff(
      "replay-watch",
      `replay-continuation:${handoff.runId}`,
      {
        schemaVersion: 1,
        kind: "agent_handoff",
        schedule: "replay-watch",
        runId: handoff.runId,
        status: handoff.status,
      },
    );
    if (!claimed) return;
    handOffSchedule(
      args,
      target,
      `Detached replay ${handoff.runId} reached terminal status ${handoff.status}. Call replay_status once, then aggregate and report. Open the swap pull request only when every machine gate is green.`,
    );
  },
});
