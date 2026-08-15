import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(
  new URL("../dist-bundle/cli.js", import.meta.url),
);
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
const githubStubModuleUrl = new URL(
  "../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
const execFileAsync = promisify(execFile);

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

interface GithubStubHit {
  readonly method: string;
  readonly path: string;
}

interface GithubStub {
  readonly port: number;
  getHits(): readonly GithubStubHit[];
  close(): Promise<void>;
}

interface GithubStubModule {
  startGithubStub(options: {
    port: number;
    token: string;
  }): Promise<GithubStub>;
}

async function fixtureCopy(root: string, label: string): Promise<string> {
  const repo = join(root, label);
  await cp(demoAppPath, repo, { recursive: true });
  await execFileAsync("git", ["-C", repo, "init", "--initial-branch", "main"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "fixture@example.com",
  ]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  await execFileAsync("git", ["-C", repo, "add", "."]);
  await execFileAsync("git", [
    "-C",
    repo,
    "commit",
    "--message",
    "Seed fixture",
  ]);
  return repo;
}

async function startStub(): Promise<StubProvider> {
  const module = (await import(stubModuleUrl)) as StubProviderModule;
  return module.startStubProvider({ port: 0 });
}

async function startGithubStub(token: string): Promise<GithubStub> {
  const module = (await import(githubStubModuleUrl)) as GithubStubModule;
  return module.startGithubStub({ port: 0, token });
}

async function narrowFixtureForApply(
  root: string,
  repo: string,
): Promise<string> {
  await Promise.all([
    rm(join(repo, "config"), { recursive: true, force: true }),
    rm(join(repo, "requirements.txt"), { force: true }),
    rm(join(repo, "src", "model-notes.ts"), { force: true }),
    rm(join(repo, "src", "support.py"), { force: true }),
    rm(join(repo, "src", "triage.py"), { force: true }),
  ]);
  await writeFile(
    join(repo, "src", "extract.ts"),
    [
      'import { generateText } from "ai";',
      "",
      "export async function extractContact(message: string) {",
      "  return generateText({",
      '    model: "acme/max-1",',
      "    prompt: `Extract the contact request: ${message}`,",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ dependencies: { ai: "*" } }, null, 2)}\n`,
  );
  const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
    attributes?: Record<string, unknown>;
  }>;
  const filteredTraces = join(root, "summarize-otel.json");
  const summarizeTraces = traces
    .filter(
      ({ attributes }) => attributes?.["rightmodeler.family"] === "summarize",
    )
    .map((trace, index) =>
      index % 2 === 0
        ? trace
        : {
            ...trace,
            attributes: {
              ...trace.attributes,
              "gen_ai.request.model": "acme/max-1",
              "gen_ai.response.model": "acme/max-1",
            },
          },
    );
  await writeFile(filteredTraces, JSON.stringify(summarizeTraces));
  await execFileAsync("git", ["-C", repo, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    repo,
    "commit",
    "--message",
    "Narrow apply fixture",
  ]);
  return filteredTraces;
}

function runCli(
  args: readonly string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    let timedOut = false;
    const child = spawn(process.execPath, [cliPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(`CLI timed out. stdout: ${stdout}\nstderr: ${stderr}`),
        );
        return;
      }
      resolve({ code: code ?? 10, stdout, stderr });
    });
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text) as unknown, label);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${String(error)}`);
  }
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

function diagnostic(result: ChildResult): string {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

describe("TypeScript CLI runbook", () => {
  it("runs unattended through apply and watch, resumes, and stops for missing provider input", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-runbook-"));
    let provider: StubProvider | undefined;
    let github: GithubStub | undefined;
    try {
      const repo = await fixtureCopy(root, "demo-app");
      const runbookTraces = await narrowFixtureForApply(root, repo);
      const plan = await runCli([
        "init",
        "--plan",
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(plan.code, diagnostic(plan)).toBe(0);
      expect(plan.stderr).toBe("");
      const planResult = parseJsonObject(plan.stdout, "plan output");
      expect(planResult.executedStages).toEqual([]);
      expect(planResult.stages).toEqual(
        expect.arrayContaining([
          { stage: "scan", state: "pending" },
          { stage: "report", state: "pending" },
        ]),
      );

      provider = await startStub();
      const apiKeyEnv = "RIGHTMODELER_RUNBOOK_API_KEY";
      const fullArgs = [
        "init",
        "--yes",
        "--through",
        "report",
        "--traces",
        runbookTraces,
        "--base-url",
        `http://127.0.0.1:${provider.port}/v1`,
        "--api-key-env",
        apiKeyEnv,
        "--max-cost-usd",
        "25",
        "--output",
        "jsonl",
        "--repo",
        repo,
      ];
      const env = { [apiKeyEnv]: "fixture-api-key" };
      const full = await runCli(fullArgs, env);
      expect([0, 1], diagnostic(full)).toContain(full.code);
      expect(full.stderr).toBe("");
      const fullEvents = parseJsonl(full.stdout, "full run output");
      const fullResult = terminalResult(fullEvents);
      expect(full.code, diagnostic(full)).toBe(
        expectedPipelineExit(fullResult),
      );
      expect(fullEvents).toEqual(
        expect.arrayContaining([
          { event: "stage_started", stage: "scan" },
          { event: "stage_completed", stage: "report" },
        ]),
      );

      const familyOutcomes = fullResult.familyOutcomes;
      if (!Array.isArray(familyOutcomes)) {
        throw new Error("result.familyOutcomes must be an array");
      }
      expect(
        familyOutcomes
          .map((family, index) => asRecord(family, `familyOutcomes[${index}]`))
          .map(({ familyId }) => familyId)
          .sort(),
      ).toEqual(["summarize"]);

      if (typeof fullResult.reportPath !== "string") {
        throw new Error("result.reportPath must be a string");
      }
      expect(fullResult.reportPath).toBe(
        join(repo, ".rightmodeler", "project", "reports", "report.md"),
      );
      const report = await readFile(fullResult.reportPath, "utf8");
      expect(report).toContain("summarize");

      const providerHits = provider.getHitCount();
      const resumed = await runCli(fullArgs, env);
      expect([0, 1], diagnostic(resumed)).toContain(resumed.code);
      expect(resumed.stderr).toBe("");
      const resumedEvents = parseJsonl(resumed.stdout, "resumed run output");
      const resumedResult = terminalResult(resumedEvents);
      expect(resumed.code, diagnostic(resumed)).toBe(
        expectedPipelineExit(resumedResult),
      );
      expect(
        resumedEvents.filter(({ event }) => event === "stage_started"),
      ).toEqual([]);
      expect(
        resumedEvents.filter(({ event }) => event === "stage_skipped"),
      ).toHaveLength(11);
      expect(provider.getHitCount()).toBe(providerHits);
      await expect(readFile(fullResult.reportPath, "utf8")).resolves.toBe(
        report,
      );

      const worksheetPath = join(root, "reference-audit.json");
      await writeFile(
        worksheetPath,
        JSON.stringify({
          seed: 42,
          populationSize: 10,
          cases: Array.from({ length: 10 }, (_, index) => ({
            caseId: `audit-case-${index}`,
            family: "summarize",
            messages: [],
            acceptedOutput: "Accepted summary",
            verdict: index < 8 ? "correct" : "incorrect",
            note: "",
          })),
        }),
      );
      const audit = await runCli([
        "audit",
        "tabulate",
        "--worksheet",
        worksheetPath,
        "--output",
        "json",
        "--repo",
        repo,
      ]);
      expect(audit.code, diagnostic(audit)).toBe(0);
      expect(parseJsonObject(audit.stdout, "audit output")).toMatchObject({
        perFamily: {
          summarize: { referenceAgreementPoint: 0.8 },
        },
      });
      const reaudited = await runCli(fullArgs, env);
      expect([0, 1], diagnostic(reaudited)).toContain(reaudited.code);
      const reauditedEvents = parseJsonl(
        reaudited.stdout,
        "reaudited run output",
      );
      expect(reauditedEvents).toEqual(
        expect.arrayContaining([
          { event: "stage_started", stage: "aggregate" },
          { event: "stage_completed", stage: "report" },
        ]),
      );
      await expect(readFile(fullResult.reportPath, "utf8")).resolves.toContain(
        "audit base 80.0%",
      );

      const githubToken = "runbook-github-token";
      const githubTokenEnv = "RIGHTMODELER_RUNBOOK_GITHUB_TOKEN";
      const githubOwner = "acme";
      const githubRepo = "demo-app";
      github = await startGithubStub(githubToken);
      const githubBaseUrl = `http://127.0.0.1:${github.port}`;
      const head = (
        await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
          encoding: "utf8",
        })
      ).stdout.trim();
      const seed = await fetch(`${githubBaseUrl}/__test/seed`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${githubToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          owner: githubOwner,
          repo: githubRepo,
          defaultBranch: "main",
          sha: head,
          tree: {
            src: {
              "extract.ts": await readFile(
                join(repo, "src", "extract.ts"),
                "utf8",
              ),
              "summarize.ts": await readFile(
                join(repo, "src", "summarize.ts"),
                "utf8",
              ),
            },
          },
        }),
      });
      expect(seed.status).toBe(201);
      const githubEnv = { ...env, [githubTokenEnv]: githubToken };
      const applyArgs = [
        "apply",
        "--owner",
        githubOwner,
        "--github-base-url",
        githubBaseUrl,
        "--github-token-env",
        githubTokenEnv,
        "--output",
        "jsonl",
        "--repo",
        repo,
      ];
      const dryRun = await runCli([...applyArgs, "--dry-run"], githubEnv);
      expect(dryRun.code, diagnostic(dryRun)).toBe(0);
      expect(
        terminalResult(parseJsonl(dryRun.stdout, "apply dry-run output")),
      ).toMatchObject({ status: "dry_run" });

      const applied = await runCli(applyArgs, githubEnv);
      expect(applied.code, diagnostic(applied)).toBe(0);
      expect(
        terminalResult(parseJsonl(applied.stdout, "apply output")),
      ).toMatchObject({ status: "applied", prNumber: 1 });

      const watched = await runCli(
        [
          "watch",
          "--owner",
          githubOwner,
          "--github-repo",
          githubRepo,
          "--pr",
          "1",
          "--github-base-url",
          githubBaseUrl,
          "--github-token-env",
          githubTokenEnv,
          "--output",
          "jsonl",
          "--repo",
          repo,
        ],
        githubEnv,
      );
      expect(watched.code, diagnostic(watched)).toBe(0);
      expect(
        terminalResult(parseJsonl(watched.stdout, "watch output")),
      ).toMatchObject({ status: "quiet" });
      expect(github.getHits()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: "GET",
            path: "/repos/acme/demo-app/pulls/1",
          }),
        ]),
      );

      const noProviderRepo = await fixtureCopy(root, "no-provider");
      const needsProvider = await runCli([
        "init",
        "--yes",
        "--through",
        "replay",
        "--traces",
        tracesPath,
        "--output",
        "jsonl",
        "--repo",
        noProviderRepo,
      ]);
      expect(needsProvider.code, diagnostic(needsProvider)).toBe(2);
      const partialEvents = parseJsonl(
        needsProvider.stdout,
        "needs-provider output",
      );
      expect(partialEvents).toContainEqual({
        event: "stage_completed",
        stage: "shortlist",
      });
      expect(partialEvents.some(({ event }) => event === "result")).toBe(false);
      const errorLines = needsProvider.stderr
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "");
      expect(errorLines).toHaveLength(1);
      const error = parseJsonObject(errorLines[0]!, "needs-provider error");
      expect(error).toMatchObject({
        code: "missing_provider_configuration",
        message: "Provider configuration is required when replay is reached.",
      });
      expect(error.remedy).toEqual(expect.stringContaining("--base-url"));
      expect(error.remedy).toEqual(expect.stringContaining("--api-key-env"));
    } finally {
      await provider?.close();
      await github?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
