import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { narrowFixtureForApply } from "./test-utils/apply-fixture.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

interface Step {
  readonly id?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly run?: string;
}

interface Job {
  readonly if: string;
  readonly permissions?: Record<string, string>;
  readonly steps: readonly Step[];
}

interface Workflow {
  readonly permissions: Record<string, string>;
  readonly concurrency: Record<string, unknown>;
  readonly env: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

interface Scenario {
  readonly exit: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface StepOptions {
  readonly workspace?: string;
  readonly scenario?: Record<string, Scenario>;
  readonly cli?: string;
  readonly expressions?: Record<string, string>;
  readonly env?: Record<string, string>;
}

interface StepRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Record<string, string>;
  readonly summary: string;
  readonly invocations: readonly (readonly string[])[];
  readonly runnerTemp: string;
  readonly workspace: string;
}

interface ChildResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Server {
  readonly port: number;
  close(): Promise<void>;
}

interface GithubStub extends Server {
  getHits(): readonly {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }[];
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(packageRoot, "dist-bundle", "cli.js");
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const stubProviderUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const githubStubUrl = new URL(
  "../../../fixtures/github-stub/server.mjs",
  import.meta.url,
).href;
const execFileAsync = promisify(execFile);
const actionlintImage =
  "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667";

const doc = await readFile(join(packageRoot, "docs", "github-actions.md"), {
  encoding: "utf8",
});
const yamlBlocks = [...doc.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(
  (match) => match[1]!,
);
if (yamlBlocks.length !== 1) {
  throw new Error(
    `docs/github-actions.md must hold exactly one yaml block, found ${yamlBlocks.length}`,
  );
}
const workflowText = yamlBlocks[0]!;
const workflow = parse(workflowText) as Workflow;
const { version } = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
) as { version: string };
const spec = `rightmodeler@${version}`;

// Expressions the step environments may use. A new one fails the run until it is added here.
const defaultExpressions: Record<string, string> = {
  "vars.RIGHTMODELER_PROVIDER_BASE_URL": "https://provider.example.test/v1",
  "secrets.RIGHTMODELER_PROVIDER_API_KEY": "provider-key-placeholder",
  "secrets.GITHUB_TOKEN": "github-token-placeholder",
};

// Stands in for npx: records its arguments, then either answers from the scenario keyed by the
// command, or runs the built CLI with the arguments after `--yes <spec>`.
const fakeNpx = `
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
appendFileSync(process.env.RM_TEST_NPX_LOG, JSON.stringify(argv) + "\\n");
const args = argv.slice(2);
if (process.env.RM_TEST_CLI) {
  const child = spawnSync(process.execPath, [process.env.RM_TEST_CLI, ...args], { stdio: "inherit" });
  process.exit(child.status ?? 10);
}
const key = args[0] === "apply" && args.includes("--dry-run") ? "apply --dry-run" : args[0];
const scenario = JSON.parse(readFileSync(process.env.RM_TEST_SCENARIO, "utf8"))[key];
if (scenario === undefined) {
  process.stderr.write("no scenario for " + key + "\\n");
  process.exit(99);
}
process.stdout.write(scenario.stdout ?? "");
process.stderr.write(scenario.stderr ?? "");
process.exit(scenario.exit);
`;

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.once("close", (code) =>
      resolve({ code: code ?? 10, stdout, stderr }),
    );
    child.stdin.end(options.input ?? "");
  });
}

function step(jobId: string, stepId: string): Step {
  const found = workflow.jobs[jobId]?.steps.find(({ id }) => id === stepId);
  if (found === undefined) throw new Error(`No step ${jobId}.${stepId}`);
  return found;
}

function resolveExpressions(
  values: Record<string, string> | undefined,
  expressions: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([name, value]) => [
      name,
      String(value).replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression) => {
        const resolved = expressions[expression as string];
        if (resolved === undefined) {
          throw new Error(`Unmapped expression in ${name}: ${expression}`);
        }
        return resolved;
      }),
    ]),
  );
}

// Runs one `run` step the way a GitHub-hosted runner does: bash with -eo pipefail, the workflow
// and step environments, the runner files, and npx replaced by the fake above.
async function runStep(
  jobId: string,
  stepId: string,
  options: StepOptions = {},
): Promise<StepRun> {
  const { run: script, env: stepEnv } = step(jobId, stepId);
  if (script === undefined) throw new Error(`${jobId}.${stepId} has no run`);
  const root = await temporaryDirectory("rightmodeler-actions-step-");
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner-temp");
  const workspace = options.workspace ?? join(root, "workspace");
  await Promise.all([
    mkdir(bin),
    mkdir(runnerTemp),
    mkdir(workspace, { recursive: true }),
  ]);
  const files = {
    output: join(root, "github-output"),
    summary: join(root, "step-summary"),
    log: join(root, "npx.log"),
    scenario: join(root, "scenario.json"),
    script: join(root, "step.sh"),
  };
  await Promise.all([
    writeFile(files.output, ""),
    writeFile(files.summary, ""),
    writeFile(files.log, ""),
    writeFile(
      files.scenario,
      JSON.stringify({
        "--version": { exit: 0, stdout: `${version}\n` },
        ...options.scenario,
      }),
    ),
    writeFile(files.script, script),
    writeFile(join(bin, "npx"), `#!${process.execPath}\n${fakeNpx}`),
    symlink(process.execPath, join(bin, "node")),
  ]);
  await chmod(join(bin, "npx"), 0o755);
  const expressions = { ...defaultExpressions, ...options.expressions };
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(GITHUB_|RUNNER_|RIGHTMODELER_|RM_|CI$|FORCE_COLOR$|NO_COLOR$)/.test(
          name,
        ),
    ),
  );
  const result = await run(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", files.script],
    {
      cwd: workspace,
      env: {
        ...inherited,
        ...resolveExpressions(workflow.env, expressions),
        ...resolveExpressions(stepEnv, expressions),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: files.output,
        GITHUB_STEP_SUMMARY: files.summary,
        RUNNER_TEMP: runnerTemp,
        GITHUB_WORKSPACE: workspace,
        GITHUB_REPOSITORY: "acme/demo-app",
        GITHUB_REPOSITORY_OWNER: "acme",
        GITHUB_API_URL: "https://api.github.example.test",
        RM_TEST_NPX_LOG: files.log,
        RM_TEST_SCENARIO: files.scenario,
        ...(options.cli === undefined ? {} : { RM_TEST_CLI: options.cli }),
        ...options.env,
      },
    },
  );
  const lines = (text: string) => text.split("\n").filter((line) => line);
  return {
    ...result,
    outputs: Object.fromEntries(
      lines(await readFile(files.output, "utf8")).map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
    ),
    summary: await readFile(files.summary, "utf8"),
    invocations: lines(await readFile(files.log, "utf8")).map(
      (line) => JSON.parse(line) as string[],
    ),
    runnerTemp,
    workspace,
  };
}

function diagnostic(result: ChildResult): string {
  return `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const runScripts = Object.values(workflow.jobs).flatMap(({ steps }) =>
  steps.flatMap(({ run: script }) => (script === undefined ? [] : [script])),
);

describe("workflow structure", () => {
  it("opens pull requests only when a person dispatches apply", () => {
    expect(workflow.jobs.apply?.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.command == 'apply'",
    );
  });

  it("never merges", () => {
    for (const script of runScripts) {
      expect(script).not.toMatch(
        /\bgh\s+pr\s+merge\b|\/merge\b|--auto\b|auto-?merge/i,
      );
    }
    for (const { steps } of Object.values(workflow.jobs)) {
      for (const { uses } of steps) {
        expect(uses ?? "").not.toMatch(/merge/i);
      }
    }
  });

  it("pins the CLI version this package publishes", () => {
    expect(workflow.env.RIGHTMODELER_VERSION).toBe(version);
  });

  it("checks out full history so reviewer fallback can blame", () => {
    for (const [jobId, { steps }] of Object.entries(workflow.jobs)) {
      const checkouts = steps.filter(({ uses }) =>
        uses?.startsWith("actions/checkout@"),
      );
      expect(checkouts, jobId).toHaveLength(1);
      expect(checkouts[0]?.with?.["fetch-depth"], jobId).toBe(0);
    }
  });

  it("restores the newest store and always saves it under a run-unique key", () => {
    for (const [jobId, { steps }] of Object.entries(workflow.jobs)) {
      const restore = steps.find(({ uses }) =>
        uses?.startsWith("actions/cache/restore@"),
      );
      const save = steps.find(({ uses }) =>
        uses?.startsWith("actions/cache/save@"),
      );
      expect(restore?.with, jobId).toMatchObject({
        path: ".rightmodeler",
        "restore-keys": "rightmodeler-store-",
      });
      expect(save?.if, jobId).toBe("always()");
      expect(save?.with, jobId).toEqual({
        path: ".rightmodeler",
        key: restore?.with?.key,
      });
      expect(restore?.with?.key, jobId).toBe(
        "rightmodeler-store-${{ github.run_id }}-${{ github.run_attempt }}",
      );
    }
  });

  it("queues runs on one store without cancelling a running one", () => {
    expect(workflow.concurrency).toEqual({
      group: "rightmodeler-store",
      "cancel-in-progress": false,
    });
  });

  it("keeps expressions out of run scripts", () => {
    for (const script of runScripts) expect(script).not.toContain("${{");
  });

  it("gives apply and watch the job's GITHUB_TOKEN with the permissions their commands use", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.apply?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(workflow.jobs.watch?.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      checks: "read",
      statuses: "read",
    });
    for (const jobId of ["apply", "watch"]) {
      expect(step(jobId, jobId).env).toEqual({
        RIGHTMODELER_GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      });
    }
  });
});

describe("exit mapping", () => {
  const warning = (code: string, message: string) =>
    jsonLine({ event: "warning", code, message });
  const error = (code: string) =>
    jsonLine({
      code,
      message: `${code} happened.`,
      remedy: `Fix ${code}.`,
    });

  it("init 0 reports no recommendation", async () => {
    const result = await runStep("init", "init", {
      scenario: { init: { exit: 0 } },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.outputs).toEqual({ recommendation: "false" });
  });

  it("init 1 reports the recommendation and escapes warning text", async () => {
    const result = await runStep("init", "init", {
      scenario: {
        init: {
          exit: 1,
          stdout:
            jsonLine({ event: "stage_started", stage: "scan" }) +
            warning(
              "external_evaluator_unreachable",
              "50% of cases\nwere not graded",
            ) +
            jsonLine({
              event: "result",
              result: { recommendationExists: true },
            }),
        },
      },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.outputs).toEqual({ recommendation: "true" });
    expect(result.stdout).toContain(
      "::notice title=rightmodeler::A proven swap is ready.",
    );
    expect(result.stdout).toContain(
      "::warning title=rightmodeler external_evaluator_unreachable::50%25 of cases%0Awere not graded\n",
    );
    const workspace = result.workspace;
    expect(result.invocations).toEqual([
      ["--yes", spec, "--version"],
      [
        "--yes",
        spec,
        "init",
        "--traces",
        "traces",
        "--base-url",
        defaultExpressions["vars.RIGHTMODELER_PROVIDER_BASE_URL"],
        "--api-key-env",
        "RIGHTMODELER_PROVIDER_API_KEY",
        "--max-cost-usd",
        "5",
        "--output",
        "jsonl",
        "--repo",
        workspace,
      ],
    ]);
  });

  it("init 2 fails and annotates the error with its remedy", async () => {
    const result = await runStep("init", "init", {
      scenario: {
        init: { exit: 2, stderr: error("missing_traces_path") },
      },
    });
    expect(result.code, diagnostic(result)).toBe(1);
    expect(result.stdout).toContain(
      "::error title=rightmodeler missing_traces_path::missing_traces_path happened. Remedy: Fix missing_traces_path.\n",
    );
  });

  it("init 3 fails and annotates the budget refusal", async () => {
    const result = await runStep("init", "init", {
      scenario: { init: { exit: 3, stderr: error("budget_cap_refusal") } },
    });
    expect(result.code, diagnostic(result)).toBe(1);
    expect(result.stdout).toContain(
      "::error title=rightmodeler budget_cap_refusal::",
    );
  });

  it("init 10 fails", async () => {
    const result = await runStep("init", "init", {
      scenario: { init: { exit: 10, stderr: error("runtime_error") } },
    });
    expect(result.code, diagnostic(result)).toBe(1);
    expect(result.stdout).toContain(
      "::error title=rightmodeler::init exited 10",
    );
  });

  it("apply opens the draft after a clean dry run", async () => {
    const result = await runStep("apply", "apply", {
      scenario: {
        "apply --dry-run": {
          exit: 0,
          stdout: jsonLine({ status: "dry_run" }),
        },
        apply: {
          exit: 0,
          stdout: jsonLine({ status: "applied", prNumber: 7 }),
        },
      },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.outputs).toEqual({ "pr-number": "7" });
    expect(result.summary).toContain(
      "Draft pull request #7 is open for review. rightmodeler never merges it.",
    );
    const common = [
      "--owner",
      "acme",
      "--github-repo",
      "demo-app",
      "--github-base-url",
      "https://api.github.example.test",
      "--github-token-env",
      "RIGHTMODELER_GITHUB_TOKEN",
      "--output",
      "json",
      "--repo",
      result.workspace,
    ];
    expect(result.invocations).toEqual([
      ["--yes", spec, "--version"],
      ["--yes", spec, "apply", "--dry-run", ...common],
      ["--yes", spec, "apply", ...common],
    ]);
  });

  it("apply stops at a refused dry run with one error per reason", async () => {
    const result = await runStep("apply", "apply", {
      scenario: {
        "apply --dry-run": {
          exit: 1,
          stdout: jsonLine({
            status: "refused",
            reasons: [
              { code: "stale_evidence", message: "Main moved.", detail: {} },
              {
                code: "release_gate_failed",
                message: "A gate is red.",
                detail: {},
              },
            ],
          }),
        },
      },
    });
    expect(result.code, diagnostic(result)).toBe(1);
    expect(
      result.stdout.split("\n").filter((line) => line.startsWith("::error")),
    ).toEqual([
      "::error title=rightmodeler stale_evidence::Main moved.",
      "::error title=rightmodeler release_gate_failed::A gate is red.",
      "::error title=rightmodeler::apply (dry-run) exited 1; the annotations above name the cause and the fix.",
    ]);
    expect(result.invocations.map((argv) => argv.slice(2, 4))).toEqual([
      ["--version"],
      ["apply", "--dry-run"],
    ]);
  });

  const statusWith = (...prNumbers: number[]) =>
    jsonLine({
      pullRequests: prNumbers.map((prNumber) => ({ prNumber, phase: "open" })),
    });

  it("watch 0 is quiet", async () => {
    const result = await runStep("watch", "watch", {
      scenario: {
        status: { exit: 0, stdout: statusWith(7) },
        watch: { exit: 0, stdout: jsonLine({ status: "quiet" }) },
      },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.invocations.map((argv) => argv.slice(0, 5))).toEqual([
      ["--yes", spec, "--version"],
      ["--yes", spec, "status", "--output", "json"],
      ["--yes", spec, "watch", "--pr", "7"],
    ]);
  });

  it("watch 1 notes the action", async () => {
    const result = await runStep("watch", "watch", {
      scenario: {
        status: { exit: 0, stdout: statusWith(7) },
        watch: { exit: 1, stdout: jsonLine({ status: "acted" }) },
      },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.stdout).toContain(
      "::notice title=rightmodeler::watch acted on pull request #7",
    );
  });

  it("watch 0 with unreadable check runs warns and succeeds", async () => {
    const result = await runStep("watch", "watch", {
      scenario: {
        status: { exit: 0, stdout: statusWith(7) },
        watch: {
          exit: 0,
          stdout: jsonLine({ status: "quiet" }),
          stderr: warning(
            "github_checks_unavailable",
            "GitHub refused to list check runs.",
          ),
        },
      },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.stdout).toContain(
      "::warning title=rightmodeler github_checks_unavailable::GitHub refused to list check runs.",
    );
  });

  it("watch 2 with a held lock warns and succeeds", async () => {
    const result = await runStep("watch", "watch", {
      scenario: {
        status: { exit: 0, stdout: statusWith(7) },
        watch: { exit: 2, stdout: jsonLine({ status: "lock_held" }) },
      },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.stdout).toContain(
      "::warning title=rightmodeler::another watcher holds the lock for pull request #7",
    );
  });

  it("watch 2 without a completed run fails and annotates the error", async () => {
    const result = await runStep("watch", "watch", {
      scenario: {
        status: { exit: 0, stdout: statusWith(7) },
        watch: { exit: 2, stderr: error("stage_not_completed") },
      },
    });
    expect(result.code, diagnostic(result)).toBe(1);
    expect(result.stdout).toContain(
      "::error title=rightmodeler stage_not_completed::stage_not_completed happened. Remedy: Fix stage_not_completed.",
    );
  });

  it("watch 10 fails", async () => {
    const result = await runStep("watch", "watch", {
      scenario: {
        status: { exit: 0, stdout: statusWith(7) },
        watch: { exit: 10, stderr: error("runtime_error") },
      },
    });
    expect(result.code, diagnostic(result)).toBe(1);
  });

  it("watch runs nothing when status lists no pull requests", async () => {
    const result = await runStep("watch", "watch", {
      scenario: { status: { exit: 0, stdout: statusWith() } },
    });
    expect(result.code, diagnostic(result)).toBe(0);
    expect(result.invocations.map((argv) => argv[2])).toEqual([
      "--version",
      "status",
    ]);
  });

  // npx exits 1 when npm cannot install the package, the same code as init's recommendation.
  it.each(["init", "apply", "watch"])(
    "%s stops with npm's error when npx cannot install the pinned CLI",
    async (jobId) => {
      const npmError = {
        exit: 1,
        stderr: `npm error notarget No matching version found for ${spec}.\n`,
      };
      const result = await runStep(jobId, jobId, {
        scenario: Object.fromEntries(
          [
            "--version",
            "init",
            "apply --dry-run",
            "apply",
            "status",
            "watch",
          ].map((key) => [key, npmError]),
        ),
      });
      expect(result.code, diagnostic(result)).toBe(1);
      expect(result.stderr).toContain("npm error notarget");
      expect(result.outputs).toEqual({});
      expect(result.invocations).toEqual([["--yes", spec, "--version"]]);
    },
  );
});

describe("against the real CLI", () => {
  it("watches nothing, proves a swap, opens one draft, then watches it quietly", async () => {
    const root = await temporaryDirectory("rightmodeler-actions-cli-");
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    await narrowFixtureForApply(
      repo,
      join(repo, "traces", "summarize-otel.json"),
    );
    const { startStubProvider } = (await import(stubProviderUrl)) as {
      startStubProvider(options: { port: number }): Promise<Server>;
    };
    const { startGithubStub } = (await import(githubStubUrl)) as {
      startGithubStub(options: {
        port: number;
        token: string;
        tokenKind: "installation";
      }): Promise<GithubStub>;
    };
    // GITHUB_TOKEN is an installation token, so the stub answers as GitHub does for one.
    const githubToken = "actions-github-token";
    const provider = await startStubProvider({ port: 0 });
    const github = await startGithubStub({
      port: 0,
      token: githubToken,
      tokenKind: "installation",
    });
    try {
      const githubUrl = `http://127.0.0.1:${github.port}`;
      const head = (
        await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
          encoding: "utf8",
        })
      ).stdout.trim();
      const seeded = await fetch(`${githubUrl}/__test/seed`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${githubToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          owner: "acme",
          repo: "demo-app",
          defaultBranch: "main",
          sha: head,
          tree: {
            src: Object.fromEntries(
              await Promise.all(
                ["extract.ts", "summarize.ts"].map(async (file) => [
                  file,
                  await readFile(join(repo, "src", file), "utf8"),
                ]),
              ),
            ),
          },
        }),
      });
      expect(seeded.status).toBe(201);
      const options: StepOptions = {
        workspace: repo,
        cli: cliPath,
        expressions: {
          "vars.RIGHTMODELER_PROVIDER_BASE_URL": `http://127.0.0.1:${provider.port}/v1`,
          "secrets.GITHUB_TOKEN": githubToken,
        },
        env: { GITHUB_API_URL: githubUrl },
      };

      const fresh = await runStep("watch", "watch", options);
      expect(fresh.code, diagnostic(fresh)).toBe(0);
      expect(fresh.invocations.map((argv) => argv[2])).toEqual([
        "--version",
        "status",
      ]);

      const init = await runStep("init", "init", options);
      expect(init.code, diagnostic(init)).toBe(0);
      expect(init.outputs).toEqual({ recommendation: "true" });
      expect(init.summary).toBe(
        await readFile(
          join(repo, ".rightmodeler", "project", "reports", "report.md"),
          "utf8",
        ),
      );
      expect(init.summary).toContain("summarize");

      const apply = await runStep("apply", "apply", options);
      expect(apply.code, diagnostic(apply)).toBe(0);
      expect(apply.outputs).toEqual({ "pr-number": "1" });
      const opened = github
        .getHits()
        .filter(
          ({ method, path }) =>
            method === "POST" && path === "/repos/acme/demo-app/pulls",
        );
      expect(opened).toHaveLength(1);
      expect(opened[0]?.body).toMatchObject({ draft: true });

      const watch = await runStep("watch", "watch", options);
      expect(watch.code, diagnostic(watch)).toBe(0);
      expect(
        JSON.parse(
          await readFile(
            join(watch.runnerTemp, "rightmodeler", "status.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ pullRequests: [{ prNumber: 1, phase: "open" }] });
      expect(
        JSON.parse(
          await readFile(
            join(watch.runnerTemp, "rightmodeler", "watch-1.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ status: "quiet" });
      for (const result of [fresh, init, apply, watch]) {
        for (const argv of result.invocations) {
          expect(argv.slice(0, 2)).toEqual(["--yes", spec]);
        }
      }
    } finally {
      await Promise.all([provider.close(), github.close()]);
    }
  }, 180_000);
});

// actionlint runs in Docker. Locally a missing Docker or image skips it; with CI=true it fails.
async function actionlintUnavailable(): Promise<string | undefined> {
  if ((await run("docker", ["version"]).catch(() => undefined))?.code !== 0) {
    return "Docker is not available";
  }
  if ((await run("docker", ["image", "inspect", actionlintImage])).code === 0) {
    return undefined;
  }
  return (await run("docker", ["pull", actionlintImage])).code === 0
    ? undefined
    : `the ${actionlintImage} image could not be pulled`;
}

const actionlintSkipReason = await actionlintUnavailable();
const skipActionlint =
  actionlintSkipReason !== undefined && process.env.CI !== "true";
if (skipActionlint) {
  console.warn(
    `[github-actions doc] actionlint SKIPPED: ${actionlintSkipReason} (required when CI=true)`,
  );
}

describe.skipIf(skipActionlint)("actionlint", () => {
  it("accepts the workflow with no findings", async () => {
    expect(actionlintSkipReason).toBeUndefined();
    const result = await run(
      "docker",
      ["run", "--rm", "-i", actionlintImage, "-"],
      { input: workflowText },
    );
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  }, 120_000);
});
