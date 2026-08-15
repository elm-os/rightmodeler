import { defineSchedule } from "eve/schedules";

import { readActiveDetachedReplay } from "@rightmodeler/cli";
import { runCli } from "../lib/cli.js";
import { replayCliArguments } from "../lib/replay.js";
import {
  handOffSchedule,
  scheduleGitHubTarget,
  scheduleReplayInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "0 9 * * 1",
  async run(args) {
    const input = scheduleReplayInput("price-decay");
    const target = scheduleGitHubTarget("price-decay");
    if (input === undefined || target === undefined) return;
    const active = await readActiveDetachedReplay(input);
    if (active !== null) {
      handOffSchedule(
        args,
        target,
        `Price-decay check deferred because detached run ${active.runId} is still ${active.status}. No estimate or pull request was started.`,
      );
      return;
    }
    const estimate = (
      await runCli("estimate", replayCliArguments(input), input)
    ).result;
    handOffSchedule(
      args,
      target,
      `Catalog pricing was rechecked and the shortlist was recalculated. Report material price-decay changes from this estimate:\n\n${JSON.stringify(estimate)}`,
    );
  },
});
