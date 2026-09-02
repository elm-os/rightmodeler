import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { terminalReplayHandoff } from "../agent/lib/replay-watch.js";
import { claimScheduleHandoff } from "../agent/lib/schedules.js";

export default defineEval({
  description:
    "Proves replay continuation decisions, once-only claims, and unattended schedule registration.",
  tags: ["offline"],
  async test(t) {
    const completedReplay = {
      lastRun: {
        runId: "replay-completed",
        type: "replay",
        status: "completed",
      },
    };
    t.check(
      terminalReplayHandoff(completedReplay),
      equals({ runId: "replay-completed", status: "completed" }),
    );
    t.check(
      terminalReplayHandoff({
        lastRun: { ...completedReplay.lastRun, status: "running" },
      }),
      equals(undefined),
    );
    t.check(
      terminalReplayHandoff({
        lastRun: { ...completedReplay.lastRun, type: "init" },
      }),
      equals(undefined),
    );
    t.check(terminalReplayHandoff({ lastRun: null }), equals(undefined));
    t.check(terminalReplayHandoff({}), equals(undefined));

    const previousAgentStore = process.env.RIGHTMODELER_AGENT_STORE;
    const agentStore = await mkdtemp(
      join(tmpdir(), "rightmodeler-agent-handoff-eval-"),
    );
    try {
      process.env.RIGHTMODELER_AGENT_STORE = agentStore;
      const payload = {
        schemaVersion: 1,
        kind: "agent_handoff",
        schedule: "replay-watch",
        runId: "replay-completed",
        status: "completed",
      };
      const key = "replay-continuation:replay-completed";
      t.check(
        await claimScheduleHandoff("replay-watch", key, payload),
        equals(true),
      );
      t.check(
        await claimScheduleHandoff("replay-watch", key, payload),
        equals(false),
      );
    } finally {
      if (previousAgentStore === undefined) {
        delete process.env.RIGHTMODELER_AGENT_STORE;
      } else {
        process.env.RIGHTMODELER_AGENT_STORE = previousAgentStore;
      }
      await rm(agentStore, { recursive: true, force: true });
    }

    for (const schedule of [
      "replay-watch",
      "approved-regression",
      "budget-report",
    ]) {
      const result = await t.target.dispatchSchedule(schedule);
      t.check(
        result.sessionIds,
        satisfies(
          (sessionIds) => Array.isArray(sessionIds),
          `${schedule} sessionIds is an array`,
        ),
      );
    }
    t.succeeded();
  },
});
