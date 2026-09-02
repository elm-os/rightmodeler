import { defineSchedule } from "eve/schedules";

import {
  listApprovedSwapSets,
  readActiveDetachedReplay,
} from "@rightmodeler/cli";
import { runCli } from "../lib/cli.js";
import { replayCliArguments } from "../lib/replay.js";
import {
  claimScheduleHandoff,
  handOffSchedule,
  scheduleCliTimeoutMs,
  scheduleGitHubTarget,
  scheduleReplayInput,
} from "../lib/schedules.js";

export default defineSchedule({
  cron: "0 7 * * 2",
  async run(args) {
    const input = scheduleReplayInput("approved-regression");
    const target = scheduleGitHubTarget("approved-regression");
    if (input === undefined || target === undefined) return;
    const cli = { repo: input.repo, store: input.store };
    const active = await readActiveDetachedReplay(cli);
    if (active !== null) {
      handOffSchedule(
        args,
        target,
        `Approved regression deferred because detached run ${active.runId} is still ${active.status}. No paid replay was started.`,
      );
      return;
    }
    for (const set of await listApprovedSwapSets(cli)) {
      const claimed = await claimScheduleHandoff(
        "approved-regression",
        `approved-regression:${set.runSpecDigest}`,
        {
          schemaVersion: 1,
          kind: "agent_handoff",
          schedule: "approved-regression",
          runSpecDigest: set.runSpecDigest,
          prNumber: set.prNumber,
        },
      );
      if (!claimed) continue;
      const replay = await runCli(
        "replay",
        [...replayCliArguments(input), "--approved-run", set.runSpecDigest],
        {
          ...cli,
          acceptedExitCodes: [0, 2, 3],
          timeoutMs: scheduleCliTimeoutMs,
        },
      );
      handOffSchedule(
        args,
        target,
        `Approved swap set from merged pull request #${set.prNumber} with run spec digest ${set.runSpecDigest} was regression-tested. Report the replay result:\n\n${JSON.stringify(replay.result)}`,
      );
      return;
    }
  },
});
