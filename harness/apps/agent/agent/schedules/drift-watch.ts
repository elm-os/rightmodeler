import { defineSchedule } from "eve/schedules";
import { resolve } from "node:path";

import { runCli } from "../lib/cli.js";
import {
  handOffSchedule,
  scheduleGitHubTarget,
  scheduleTraceInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "0 8 * * *",
  async run(args) {
    const input = scheduleTraceInput("drift-watch");
    const target = scheduleGitHubTarget("drift-watch");
    if (input === undefined || target === undefined) return;
    const drift = await runCli(
      "drift",
      ["--traces", resolve(input.traces)],
      input,
    );
    handOffSchedule(
      args,
      target,
      `Corpus drift was compared with the active published corpus. Review the proposal before approving or publishing it.\n\n${JSON.stringify(drift.result)}`,
    );
  },
});
