import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { z } from "zod";

import { machineApproval } from "../agent/lib/approval.js";
import {
  readReplayStatus,
  replayEventPath,
  startReplay,
  type ReplayStatus,
} from "../agent/lib/replay.js";
import { aggregateTool } from "../agent/tools/aggregate.js";
import { estimateCostTool } from "../agent/tools/estimate_cost.js";
import { openSwapPrTool } from "../agent/tools/open_swap_pr.js";
import { replayStartTool } from "../agent/tools/replay_start.js";
import { replayStatusTool } from "../agent/tools/replay_status.js";
import { reportTool } from "../agent/tools/report.js";
import { scanTool } from "../agent/tools/scan.js";
import { statusTool } from "../agent/tools/status.js";

interface StubProvider {
  port: number;
  close(): Promise<void>;
}

interface StubProviderModule {
  startStubProvider(input: { port: number }): Promise<StubProvider>;
}

const replayStartResultSchema = z.strictObject({
  runId: z.string(),
  status: z.string(),
  deduplicated: z.boolean(),
});

const prePullRequestTools = [
  scanTool,
  estimateCostTool,
  statusTool,
  replayStartTool,
  replayStatusTool,
  aggregateTool,
  reportTool,
];

export default defineEval({
  description:
    "Drives the real fixture from scan through report with a deterministic model and provider.",
  tags: ["offline"],
  timeoutMs: 120_000,
  async test(t) {
    const tempRoot = await mkdtemp(join(tmpdir(), "rightmodeler-agent-eval-"));
    const store = join(tempRoot, "store");
    const repo = resolve(process.cwd(), "../../fixtures/demo-app");
    const traces = resolve(
      process.cwd(),
      "../../fixtures/traces/otel-genai.json",
    );
    const stubModuleUrl = pathToFileURL(
      resolve(process.cwd(), "../../fixtures/stub-provider/server.mjs"),
    );
    const stubModule = (await import(
      stubModuleUrl.href
    )) as unknown as StubProviderModule;
    const stub = await stubModule.startStubProvider({ port: 0 });

    try {
      const fixtureInput = {
        repo,
        store,
        traces,
        baseUrl: `http://127.0.0.1:${stub.port}/v1`,
        apiKeyEnv: "RIGHTMODELER_AGENT_FIXTURE_API_KEY",
        maxCostUsd: 25,
      };
      const first = await t.send(
        `Run scan through report for this fixture. RIGHTMODELER_EVAL_INPUT=${JSON.stringify(fixtureInput)}`,
      );
      const dispatch = replayStartResultSchema.parse(
        first.requireToolCall("replay_start").output,
      );
      const duplicate = await startReplay(fixtureInput);
      await t.require(duplicate.runId, equals(dispatch.runId));
      t.check(duplicate.deduplicated, equals(true));
      const terminal = await waitForTerminalReplay(
        repo,
        store,
        dispatch.runId,
        t.signal,
      );
      await t.require(terminal.status, equals("completed"));
      t.check(terminal.eventCount, equals(3));

      await t.send(`Continue the dispatched replay ${dispatch.runId}.`);

      t.succeeded();
      t.noFailedActions();
      t.toolOrder([
        "scan",
        "estimate_cost",
        "status",
        "replay_start",
        "replay_status",
        "aggregate",
        "report",
      ]);
      t.calledTool("report", { count: 1 });
      t.check(
        prePullRequestTools,
        satisfies<typeof prePullRequestTools>(
          (tools) =>
            tools.every(
              (tool) =>
                tool.approval === undefined ||
                tool.approval === machineApproval,
            ),
          "pre-pull-request tools omit approval or use never",
        ),
      );
      t.check(openSwapPrTool.approval, equals(machineApproval));
      t.check(
        await machineApproval({} as Parameters<typeof machineApproval>[0]),
        equals("not-applicable"),
      );
    } finally {
      await stub.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
});

async function waitForTerminalReplay(
  repo: string,
  store: string,
  runId: string,
  signal: AbortSignal,
): Promise<ReplayStatus> {
  const path = replayEventPath(repo, store, runId);
  return new Promise((resolveStatus, rejectStatus) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const check = async () => {
      try {
        const status = await readReplayStatus(repo, store, runId);
        if (isTerminal(status.status)) {
          finish(() => resolveStatus(status));
        }
      } catch (error) {
        finish(() => rejectStatus(error));
      }
    };
    const watcher = watch(path, () => void check());
    const timeout = setTimeout(
      () => finish(() => rejectStatus(new Error(`Replay ${runId} timed out.`))),
      90_000,
    );
    const onAbort = () =>
      finish(() => rejectStatus(signal.reason ?? new Error("Eval aborted.")));
    signal.addEventListener("abort", onAbort, { once: true });
    void check();
  });
}

function isTerminal(status: ReplayStatus["status"]): boolean {
  return ["completed", "needs_input", "budget_limited", "failed"].includes(
    status,
  );
}
