import { defineSchedule } from "eve/schedules";

import {
  listApprovedSwapSets,
  readActiveDetachedReplay,
} from "@rightmodeler/cli";
import { runCli } from "../lib/cli.js";
import { replayCliArguments } from "../lib/replay.js";
import {
  handOffSchedule,
  scheduleGitHubTarget,
  scheduleReplayInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "0 8 * * *",
  async run(args) {
    const input = scheduleReplayInput("drift-watch");
    const target = scheduleGitHubTarget("drift-watch");
    if (input === undefined || target === undefined) return;
    const active = await readActiveDetachedReplay(input);
    if (active !== null) {
      handOffSchedule(
        args,
        target,
        `Drift regression deferred because detached run ${active.runId} is still ${active.status}. No estimate, replay, or pull request was started.`,
      );
      return;
    }
    const approvedSwaps = await listApprovedSwapSets(input);
    const regressions: Array<Record<string, unknown>> = [];
    for (const approved of approvedSwaps) {
      try {
        const scoped = [
          ...replayCliArguments(input),
          "--approved-run",
          approved.runSpecDigest,
        ];
        const estimate = (await runCli("estimate", scoped, input)).result;
        const dispatch = (
          await runCli("replay", [...scoped, "--detach"], input)
        ).result;
        regressions.push({ approved, estimate, dispatch });
        if (dispatch.terminal !== true) break;
      } catch (error) {
        regressions.push({
          approved,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (regressions.length === 0) {
      regressions.push({
        approved: null,
        status: (await runCli("status", [], input)).result,
        note: "No merged approved swaps are available for regression.",
      });
    }
    handOffSchedule(
      args,
      target,
      `Approved swaps were costed against the current catalog. At most one unfinished regression was dispatched so project checkpoints remain serialized; terminal and stale approvals were reported without blocking later approvals. Do not poll or open a pull request in this turn; report run IDs and any loud no-op.\n\n${JSON.stringify(regressions)}`,
    );
  },
});
