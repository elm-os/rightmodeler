import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FsStore,
  reportKey,
  runsPrefix,
  setupStateKey,
} from "@rightmodeler/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeCli } from "./cli.js";
import { PIPELINE_STAGES } from "./pipeline.js";
import type { CliIo } from "./protocol.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const execFileAsync = promisify(execFile);
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const demoGraphPath = fileURLToPath(
  new URL("../../../fixtures/code-graph/demo-app.graph.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_CODE_GRAPH_TEST_API_KEY";
const SENTINEL = "rmCodeGraphSentinel7f3a()";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface InitRun {
  code: number;
  events: Record<string, unknown>[];
  hits: number;
  snapshot: Map<string, string>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonl(text: string, label: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, lineNumber }) => {
      try {
        return asRecord(
          JSON.parse(line) as unknown,
          `${label} line ${lineNumber}`,
        );
      } catch (error) {
        throw new Error(
          `${label} line ${lineNumber} is invalid JSON: ${String(error)}. Line: ${line}`,
        );
      }
    });
}

function terminalResult(
  events: Record<string, unknown>[],
): Record<string, unknown> {
  const terminal = events.at(-1);
  if (terminal?.event !== "result") {
    throw new Error("JSONL stream must end with a result event");
  }
  return asRecord(terminal.result, "result event payload");
}

function expectedPipelineExit(result: Record<string, unknown>): 0 | 1 {
  if (typeof result.recommendationExists !== "boolean") {
    throw new Error("result.recommendationExists must be a boolean");
  }
  return result.recommendationExists ? 1 : 0;
}

async function cli(argv: readonly string[]): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  };
  const code = await executeCli(argv, io);
  return { code, stdout, stderr };
}

async function storeText(store: FsStore, key: string): Promise<string> {
  const entry = await store.get(key);
  if (entry === null) throw new Error(`Missing store key: ${key}`);
  return Buffer.from(entry.body).toString("utf8");
}

async function snapshot(store: FsStore): Promise<Map<string, string>> {
  const keys = await store.list("project/");
  return new Map(
    await Promise.all(
      keys.map(async (key) => [key, await storeText(store, key)] as const),
    ),
  );
}

function stages(events: Record<string, unknown>[], event: string): unknown[] {
  return events
    .filter((value) => value.event === event)
    .map(({ stage }) => stage);
}

function setupStages(
  snapshotValue: Map<string, string>,
): Record<string, unknown> {
  const state = JSON.parse(snapshotValue.get(setupStateKey("project"))!) as {
    stages: Record<string, unknown>;
  };
  const { report: _report, ...rest } = state.stages;
  return rest;
}

describe("Graphify code context never reaches evidence", () => {
  let root: string;
  let repo: string;
  let graphPath: string;
  let graphSha: string;
  let stub: StubProvider;
  let store: FsStore;
  let run1: InitRun;
  let run2: InitRun;
  let run3Events: Record<string, unknown>[];
  let run3Report: string;
  let graphReport: CliRun & { report: string };
  let missingReport: CliRun & { report: string };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rightmodeler-code-graph-guard-"));
    repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const module = (await import(stubModuleUrl)) as {
      startStubProvider(options: { port: number }): Promise<StubProvider>;
    };
    stub = await module.startStubProvider({ port: 0 });
    process.env[apiKeyEnv] = "code-graph-fixture-key";
    store = new FsStore(join(repo, ".rightmodeler"));
    const initArgs = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      "--output",
      "jsonl",
      "--repo",
      repo,
    ];
    const init = async (extra: readonly string[] = []): Promise<InitRun> => {
      const result = await cli([...initArgs, ...extra]);
      return {
        code: result.code,
        events: parseJsonl(result.stdout, "init"),
        hits: stub.getHitCount(),
        snapshot: await snapshot(store),
      };
    };
    const report = async (
      path: string,
    ): Promise<CliRun & { report: string }> => {
      const result = await cli([
        "report",
        "--code-graph",
        path,
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      return {
        ...result,
        report: await storeText(store, reportKey("project", "report.md")),
      };
    };

    run1 = await init();

    const graph = JSON.parse(await readFile(demoGraphPath, "utf8")) as {
      built_at_commit: string;
      nodes: Array<{ id: string; label: string }>;
    };
    graph.built_at_commit = (
      await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])
    ).stdout.trim();
    graph.nodes.find(({ id }) => id === "src_summarize_summarize")!.label =
      SENTINEL;
    graphPath = join(repo, "graphify-out", "graph.json");
    const bytes = JSON.stringify(graph, null, 2);
    await mkdir(join(repo, "graphify-out"));
    await writeFile(graphPath, bytes);
    graphSha = createHash("sha256").update(bytes).digest("hex");

    run2 = await init(["--code-graph", graphPath]);
    const run3 = await init();
    run3Events = run3.events;
    run3Report = run3.snapshot.get(reportKey("project", "report.md"))!;
    graphReport = await report(graphPath);
    missingReport = await report(join(root, "missing.json"));
  }, 240_000);

  afterAll(async () => {
    await stub?.close();
    delete process.env[apiKeyEnv];
    await rm(root, { recursive: true, force: true });
  });

  it("renders code context without re-running any evidence stage", () => {
    expect(run1.code).toBe(expectedPipelineExit(terminalResult(run1.events)));
    expect(stages(run2.events, "stage_skipped")).toEqual(
      PIPELINE_STAGES.slice(0, -1),
    );
    expect(stages(run2.events, "stage_started")).toEqual(["report"]);
    expect(run2.code).toBe(run1.code);
    expect(run2.hits).toBe(run1.hits);
    expect(setupStages(run2.snapshot)).toEqual(setupStages(run1.snapshot));
    const report = run2.snapshot.get(reportKey("project", "report.md"))!;
    expect(report).toContain("## Code context (Graphify)");
    expect(report).toContain(`\`src/summarize.ts:4\` in \`${SENTINEL}\``);
  });

  it("keeps graph data out of every store entry outside reports", () => {
    const changed: string[] = [];
    for (const [key, body] of run2.snapshot) {
      if (key.startsWith("project/reports/")) continue;
      expect(body, key).not.toContain(SENTINEL);
      expect(body, key).not.toContain(graphSha);
      if (run1.snapshot.get(key) !== body) changed.push(key);
    }
    const reportJson = run2.snapshot.get(reportKey("project", "report.json"))!;
    expect(reportJson).toContain(SENTINEL);
    expect(reportJson).toContain(graphSha);
    expect(changed).toHaveLength(2);
    expect(changed).toContain(setupStateKey("project"));
    expect(
      changed.filter((key) => key.startsWith(runsPrefix("project"))),
    ).toHaveLength(1);
  });

  it("hints at an existing graph and drops the section without the flag", () => {
    expect(run3Events).toContainEqual(
      expect.objectContaining({
        event: "warning",
        code: "code_graph_available",
        message: expect.stringContaining("--code-graph"),
      }),
    );
    expect(stages(run3Events, "stage_started")).toEqual(["report"]);
    expect(run3Report).not.toContain("## Code context");
  });

  it("degrades the report command instead of failing it", () => {
    expect(graphReport.code).toBe(run1.code);
    expect(graphReport.stderr).toBe("");
    expect(JSON.parse(graphReport.stdout)).toMatchObject({
      codeContext: { status: "ok" },
    });

    expect(missingReport.code).toBe(run1.code);
    const lines = missingReport.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      code: "code_graph_unreadable",
    });
    expect(JSON.parse(missingReport.stdout)).toMatchObject({
      codeContext: { status: "unavailable" },
    });
    expect(missingReport.report).toContain(
      "Not shown: Cannot read the code graph",
    );
  });
});
