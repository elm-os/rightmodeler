import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsStore, reportKey, verdictsPrefix } from "@rightmodeler/core";
import { afterAll, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const temporaryDirectories: string[] = [];
const secret = "phase-a-api-key-must-not-persist";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixtureCopy(
  label: string,
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-${label}-`));
  temporaryDirectories.push(root);
  const repo = join(root, "demo-app");
  await cp(demoAppPath, repo, { recursive: true });
  return { root, repo };
}

function runCli(
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 10, stdout, stderr });
    });
  });
}

function jsonOutput(result: ChildResult): Record<string, unknown> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function startStub(): Promise<StubProvider> {
  const module = (await import(stubModuleUrl)) as StubProviderModule;
  return module.startStubProvider({ port: 0 });
}

async function storeText(store: FsStore, key: string): Promise<string> {
  const entry = await store.get(key);
  if (entry === null) throw new Error(`Missing store key: ${key}`);
  return Buffer.from(entry.body).toString("utf8");
}

async function allFileText(root: string): Promise<string> {
  const texts: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) texts.push(await readFile(path, "utf8"));
    }
  }
  await visit(root);
  return texts.join("\n");
}

describe("built CLI pipeline", () => {
  it("plans from anywhere and proves checkpointed free stages", async () => {
    const { root, repo } = await fixtureCopy("plan");
    const unrelatedCwd = join(root, "unrelated-cwd");
    await cp(demoAppPath, unrelatedCwd, { recursive: true });

    const help = await runCli(["--help"], { cwd: unrelatedCwd });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("rightmodeler");

    const initialPlan = await runCli(
      ["init", "--plan", "--output", "json", "--repo", repo],
      { cwd: unrelatedCwd },
    );
    expect(initialPlan.code).toBe(0);
    expect(jsonOutput(initialPlan).stages).toEqual(
      expect.arrayContaining([
        { stage: "scan", state: "pending" },
        { stage: "report", state: "pending" },
      ]),
    );
    expect(
      (jsonOutput(initialPlan).stages as Array<{ state: string }>).every(
        ({ state }) => state === "pending",
      ),
    ).toBe(true);

    const throughCorpus = [
      "init",
      "--through",
      "corpus",
      "--traces",
      tracesPath,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    const first = await runCli(throughCorpus, { cwd: unrelatedCwd });
    expect(first.code).toBe(0);
    expect(jsonOutput(first).executedStages).toEqual([
      "scan",
      "ingest",
      "reconcile",
      "scrub",
      "corpus",
    ]);

    const second = await runCli(throughCorpus, { cwd: unrelatedCwd });
    expect(second.code).toBe(0);
    expect(jsonOutput(second).executedStages).toEqual([]);
    expect(
      (jsonOutput(second).stages as Array<{ state: string }>).every(
        ({ state }) => state === "complete",
      ),
    ).toBe(true);
  });

  it("runs end to end, reports both families, resumes replay, and never persists the key", async () => {
    const { repo } = await fixtureCopy("full");
    const stub = await startStub();
    const args = [
      "init",
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      "RIGHTMODELER_E2E_API_KEY",
      "--output",
      "json",
      "--repo",
      repo,
    ];

    try {
      const first = await runCli(args, {
        env: { RIGHTMODELER_E2E_API_KEY: secret },
      });
      expect([0, 1]).toContain(first.code);
      const firstOutput = jsonOutput(first);
      const verdicts = firstOutput.verdicts as Array<{
        familyId: string;
        decision: string;
        abstainReason?: string;
      }>;
      expect(verdicts.map(({ familyId }) => familyId).sort()).toEqual([
        "summarize",
        "support",
      ]);
      expect(
        verdicts.filter(
          ({ decision }) => decision === "recommend" || decision === "reject",
        ),
      ).toEqual([expect.objectContaining({ familyId: "summarize" })]);
      expect(verdicts).toContainEqual(
        expect.objectContaining({
          familyId: "support",
          decision: "abstain",
          abstainReason: "insufficient_review_trials",
        }),
      );

      const storeRoot = join(repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      const reportJson = JSON.parse(
        await storeText(store, reportKey("project", "report.json")),
      ) as { verdicts: unknown[] };
      const reportMarkdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(reportMarkdown).toContain("insufficient_review_trials");
      expect(reportMarkdown).toContain("## Caps");
      const storedVerdicts = await Promise.all(
        (await store.list(verdictsPrefix("project"))).map(async (key) =>
          JSON.parse(await storeText(store, key)),
        ),
      );
      expect(reportJson.verdicts).toEqual(storedVerdicts);

      const hitsAfterFirstRun = stub.getHitCount();
      expect(hitsAfterFirstRun).toBeGreaterThan(0);
      const resumed = await runCli(args, {
        env: { RIGHTMODELER_E2E_API_KEY: secret },
      });
      expect([0, 1]).toContain(resumed.code);
      expect(jsonOutput(resumed).executedStages).toEqual([]);
      expect(stub.getHitCount()).toBe(hitsAfterFirstRun);

      const reportCommand = await runCli([
        "report",
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(reportCommand.code).toBe(1);
      expect(jsonOutput(reportCommand)).toMatchObject({
        verdicts: reportJson.verdicts,
      });
      const statusCommand = await runCli([
        "status",
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(statusCommand.code).toBe(0);
      expect(jsonOutput(statusCommand)).toMatchObject({
        corpusVersion: expect.any(String),
        factCounts: {
          Execution: 17,
          Assessment: 17,
        },
      });

      expect(await allFileText(storeRoot)).not.toContain(secret);
      expect(reportMarkdown).not.toContain(secret);
      expect(JSON.stringify(reportJson)).not.toContain(secret);
    } finally {
      await stub.close();
    }
  }, 60_000);

  it("returns a machine-readable needs-input error when replay has no provider", async () => {
    const { repo } = await fixtureCopy("no-provider");
    const result = await runCli([
      "init",
      "--traces",
      tracesPath,
      "--output",
      "json",
      "--repo",
      repo,
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      code: "missing_provider_configuration",
      message: "Provider configuration is required when replay is reached.",
      remedy:
        "Pass --base-url <url> and, if needed, --api-key-env <environment-variable-name>.",
    });
  });

  it("surfaces missing traces and budget refusals at resumable boundaries", async () => {
    const missing = await fixtureCopy("missing-traces");
    const missingResult = await runCli([
      "init",
      "--through",
      "ingest",
      "--output",
      "json",
      "--repo",
      missing.repo,
    ]);
    expect(missingResult.code).toBe(2);
    expect(JSON.parse(missingResult.stderr)).toMatchObject({
      code: "missing_traces_path",
      remedy: expect.stringContaining("--traces"),
    });

    const capped = await fixtureCopy("budget-cap");
    const stub = await startStub();
    try {
      const cappedResult = await runCli(
        [
          "init",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          "RIGHTMODELER_E2E_API_KEY",
          "--max-cost-usd",
          "0",
          "--output",
          "json",
          "--repo",
          capped.repo,
        ],
        { env: { RIGHTMODELER_E2E_API_KEY: secret } },
      );
      expect(cappedResult.code).toBe(3);
      expect(JSON.parse(cappedResult.stderr)).toMatchObject({
        code: "budget_cap_refusal",
        message: expect.stringContaining("raise it to at least"),
        remedy: expect.stringContaining("--max-cost-usd"),
      });
    } finally {
      await stub.close();
    }
  });
});
