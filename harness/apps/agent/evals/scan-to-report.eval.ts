import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { z } from "zod";

import { runCli } from "../agent/lib/cli.js";
import { replayCliArguments } from "../agent/lib/replay.js";

const execFileAsync = promisify(execFile);

async function makeGitFixture(
  rootDir: string,
  sourceDir: string,
): Promise<string> {
  const repoDir = join(rootDir, "repo");
  await cp(sourceDir, repoDir, { recursive: true });
  const git = (args: readonly string[]) =>
    execFileAsync("git", ["-C", repoDir, ...args]);
  await git(["init", "--initial-branch", "main"]);
  await git(["config", "user.name", "Fixture Author"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["add", "--all"]);
  await git(["commit", "--message", "Seed fixture"]);
  return repoDir;
}

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
  terminal: z.boolean(),
  deduplicated: z.boolean(),
});
const replayStatusSchema = z.strictObject({
  runId: z.string(),
  type: z.string(),
  phase: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  terminal: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  progress: z.strictObject({
    completedStages: z.array(z.string()),
    targetStage: z.string().nullable(),
    completed: z.number(),
    total: z.number().nullable(),
  }),
});
type ReplayStatus = z.infer<typeof replayStatusSchema>;

export default defineEval({
  description:
    "Drives the real fixture from scan through report with a deterministic model and provider.",
  tags: ["offline"],
  timeoutMs: 120_000,
  async test(t) {
    const tempRoot = await mkdtemp(join(tmpdir(), "rightmodeler-agent-eval-"));
    const store = join(tempRoot, "store");
    const repo = await makeGitFixture(
      tempRoot,
      resolve(process.cwd(), "../../fixtures/demo-app"),
    );
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
      const duplicate = replayStartResultSchema.parse(
        (
          await runCli(
            "replay",
            [...replayCliArguments(fixtureInput), "--detach"],
            fixtureInput,
          )
        ).result,
      );
      await t.require(duplicate.runId, equals(dispatch.runId));
      t.check(duplicate.deduplicated, equals(true));
      const terminal = await waitForTerminalReplay(
        repo,
        store,
        dispatch.runId,
        t.signal,
      );
      await t.require(terminal.status, equals("completed"));
      t.check(terminal.progress.completed, equals(8));

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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw signal.reason ?? new Error("Eval aborted.");
    }
    const status = replayStatusSchema.parse(
      (await runCli("status", ["--run", runId], { repo, store })).result,
    );
    if (status.terminal) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Replay ${runId} timed out.`);
}
