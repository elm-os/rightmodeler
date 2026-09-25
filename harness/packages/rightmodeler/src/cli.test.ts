import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProgram,
  executeCli,
  pipelineArgv,
  type PipelineCommandOptions,
} from "./cli.js";
import type { CliIo } from "./protocol.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const temporaryDirectories: string[] = [];
const validTracePath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const emptyCodexSession = [
  JSON.stringify({
    type: "session_meta",
    payload: {
      id: "session-1",
      cwd: "/unused",
      cli_version: "0.1.0",
      model_provider: "openai",
    },
  }),
  JSON.stringify({
    type: "turn_context",
    payload: { turn_id: "turn-1", model: "acme/large-1" },
  }),
].join("\n");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  repo: string;
  homeDir: string;
  newest: string;
  older: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-cli-guidance-"));
  temporaryDirectories.push(root);
  const repo = await makeGitFixture(root);
  const homeDir = join(root, "home");
  const newest = join(repo, "newest.jsonl");
  const older = join(repo, "older.json");
  await Promise.all([
    writeFile(newest, `${emptyCodexSession}\n`),
    copyFile(validTracePath, older),
  ]);
  await Promise.all([
    utimes(newest, new Date(2_000), new Date(2_000)),
    utimes(older, new Date(1_000), new Date(1_000)),
  ]);
  return { root, repo, homeDir, newest, older };
}

function captureIo(): { io: CliIo; stdout(): string; stderr(): string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function runtime(
  homeDir: string,
  answer: string,
  isTTY: true | undefined,
): {
  runtime: Parameters<typeof executeCli>[2];
  runtimeOutput(): string;
} {
  let runtimeOutput = "";
  const stdin = Object.assign(Readable.from([answer]), { isTTY });
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        runtimeOutput += String(chunk);
        callback();
      },
    }),
    { isTTY },
  );
  return {
    runtime: {
      stdin,
      stdout,
      env: {},
      homeDir,
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    },
    runtimeOutput: () => runtimeOutput,
  };
}

describe("pipelineArgv", () => {
  it("serializes every pipeline option in command order", () => {
    const approvedRun = "a".repeat(64);
    const options: PipelineCommandOptions = {
      traces: "./traces.json",
      matchers: "./matchers.json",
      modebConfig: "./modeb.json",
      baseUrl: "https://provider.example/v1",
      apiKeyEnv: "PROVIDER_API_KEY",
      maxCostUsd: "1.25",
      maxConcurrency: "3",
      pricingFile: "./pricing.json",
      header: ["x-portkey-provider: openai", "x-bf-cache-no-store: true"],
      catalogReference: "https://ai-gateway.vercel.sh/v1/models",
      policy: "./policy.json",
      includeFree: true,
      approvedRun,
      evaluator: "promptfoo",
      evaluatorBaseUrl: "https://evaluator.example",
      evaluatorApiKeyEnv: "EVALUATOR_API_KEY",
      evaluatorPublicKeyEnv: "EVALUATOR_PUBLIC_KEY",
      evaluatorProjectId: "project-1",
      evaluatorCommand: "./bin/promptfoo",
      evaluatorConfig: "./promptfoo.yaml",
      evaluatorScorer: ["quality", "safety"],
      evaluatorGateMetric: "quality",
      evaluatorGateThreshold: "0.8",
    };

    expect(pipelineArgv(options)).toEqual([
      "--traces",
      resolve("./traces.json"),
      "--matchers",
      resolve("./matchers.json"),
      "--modeb-config",
      resolve("./modeb.json"),
      "--base-url",
      "https://provider.example/v1",
      "--api-key-env",
      "PROVIDER_API_KEY",
      "--max-cost-usd",
      "1.25",
      "--max-concurrency",
      "3",
      "--pricing-file",
      resolve("./pricing.json"),
      "--header",
      "x-portkey-provider: openai",
      "--header",
      "x-bf-cache-no-store: true",
      "--catalog-reference",
      "https://ai-gateway.vercel.sh/v1/models",
      "--policy",
      resolve("./policy.json"),
      "--include-free",
      "--approved-run",
      approvedRun,
      "--evaluator",
      "promptfoo",
      "--evaluator-base-url",
      "https://evaluator.example",
      "--evaluator-api-key-env",
      "EVALUATOR_API_KEY",
      "--evaluator-public-key-env",
      "EVALUATOR_PUBLIC_KEY",
      "--evaluator-project-id",
      "project-1",
      "--evaluator-command",
      resolve("./bin/promptfoo"),
      "--evaluator-config",
      resolve("./promptfoo.yaml"),
      "--evaluator-scorer",
      "quality",
      "--evaluator-scorer",
      "safety",
      "--evaluator-gate-metric",
      "quality",
      "--evaluator-gate-threshold",
      "0.8",
    ]);
  });

  it("serializes empty options to an empty array", () => {
    expect(pipelineArgv({})).toEqual([]);
  });

  it("resolves a catalog reference path for the detached worker", () => {
    expect(pipelineArgv({ catalogReference: "./catalog.json" })).toEqual([
      "--catalog-reference",
      resolve("./catalog.json"),
    ]);
  });
});

describe("CLI trace guidance wiring", () => {
  it("reports an invalid release policy before trace guidance", async () => {
    const { repo, homeDir } = await fixture();
    const policyRoot = await mkdtemp(join(tmpdir(), "rightmodeler-policy-"));
    temporaryDirectories.push(policyRoot);
    const policyPath = join(policyRoot, "policy.json");
    await writeFile(policyPath, JSON.stringify({ qualityFloor: 0.5 }));
    const captured = captureIo();

    expect(
      await executeCli(
        ["estimate", "--policy", policyPath, "--repo", repo],
        captured.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(2);
    expect(captured.stderr()).toContain("Invalid --policy field qualityFloor");
  });

  it("prompts through injected IO in a TTY and uses the selected candidate", async () => {
    const { repo, homeDir, older } = await fixture();
    const captured = captureIo();
    const terminal = runtime(homeDir, "2\n", true);

    const code = await executeCli(
      ["init", "--through", "ingest", "--repo", repo],
      captured.io,
      terminal.runtime,
    );

    expect(captured.stderr()).toBe("");
    expect(code).toBe(0);
    expect(captured.stdout()).toContain("Choose a trace file");
    expect(captured.stdout()).toContain("./older.json");
    expect(terminal.runtimeOutput()).toBe("");
  });

  it("does not prompt when isTTY is undefined", async () => {
    const { repo, homeDir } = await fixture();
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "2\n", undefined);

    const code = await executeCli(
      ["init", "--through", "ingest", "--repo", repo],
      captured.io,
      nonTerminal.runtime,
    );

    expect(code).toBe(2);
    expect(captured.stdout()).not.toContain("Choose a trace file");
    expect(captured.stderr()).toContain("A trace input path is required");
  });

  it("names the trace adopted by --yes in human output", async () => {
    const { repo, homeDir, newest } = await fixture();
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "", undefined);

    const code = await executeCli(
      ["init", "--yes", "--through", "ingest", "--repo", repo],
      captured.io,
      nonTerminal.runtime,
    );

    expect(code).toBe(2);
    expect(captured.stdout()).toContain(`Using trace file: ${newest}`);
    expect(captured.stderr()).toContain(
      "Rerun the command and choose a different trace file.",
    );
  });

  it("caps the non-interactive candidate remedy at the newest three paths", async () => {
    const { repo, homeDir, newest, older } = await fixture();
    const extras = await Promise.all(
      ["third.json", "fourth.json", "fifth.json"].map(async (name, index) => {
        const path = join(repo, name);
        await copyFile(validTracePath, path);
        await utimes(
          path,
          new Date(5_000 - index * 1_000),
          new Date(5_000 - index * 1_000),
        );
        return path;
      }),
    );
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "", undefined);

    expect(
      await executeCli(
        ["init", "--through", "ingest", "--repo", repo],
        captured.io,
        nonTerminal.runtime,
      ),
    ).toBe(2);
    expect(captured.stderr()).toContain(
      `Found 5 candidate trace files: ${extras.join(", ")}, and 2 more.`,
    );
    expect(captured.stderr()).not.toContain(newest);
    expect(captured.stderr()).not.toContain(older);
  });

  it("registers --yes on estimate", async () => {
    const captured = captureIo();

    expect(await executeCli(["estimate", "--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("--yes");
  });

  it("registers --policy on init", async () => {
    const captured = captureIo();

    expect(await executeCli(["init", "--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("--policy <path>");
  });

  it("registers --code-graph on init and report", async () => {
    for (const command of ["init", "report"]) {
      const captured = captureIo();

      expect(await executeCli([command, "--help"], captured.io)).toBe(0);
      expect(captured.stdout()).toContain("--code-graph <path>");
    }
  });

  it("registers --code-graph on apply", async () => {
    const captured = captureIo();

    expect(await executeCli(["apply", "--help"], captured.io)).toBe(0);
    expect(captured.stdout()).toContain("--code-graph <path>");
  });

  it("rejects --code-graph without a path as a usage error", async () => {
    const captured = captureIo();

    expect(
      await executeCli(
        ["--output", "json", "report", "--code-graph"],
        captured.io,
      ),
    ).toBe(10);
    expect(captured.stdout()).toBe("");
    const lines = captured.stderr().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      code: "usage_error",
      message: expect.stringContaining("--code-graph"),
    });
  });

  it("resumes the ingested trace before discovery", async () => {
    const { repo, homeDir, older } = await fixture();
    const first = captureIo();

    expect(
      await executeCli(
        ["init", "--through", "ingest", "--traces", older, "--repo", repo],
        first.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(0);

    const resumed = captureIo();
    expect(
      await executeCli(
        ["init", "--yes", "--through", "ingest", "--repo", repo],
        resumed.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(0);
    expect(resumed.stdout()).toContain(`Resuming the ingested trace: ${older}`);
    expect(resumed.stdout()).not.toContain("Using trace file:");
  });
});

describe("CLI exit codes", () => {
  it("exits 0 for --version and help <command>", async () => {
    const versionOutput = captureIo();

    expect(await executeCli(["--version"], versionOutput.io)).toBe(0);
    expect(versionOutput.stdout()).toMatch(/^\d+\.\d+\.\d+/u);
    expect(versionOutput.stderr()).toBe("");

    const helpOutput = captureIo();

    expect(await executeCli(["help", "init"], helpOutput.io)).toBe(0);
    expect(helpOutput.stdout()).toContain("Usage: rightmodeler init");
    expect(helpOutput.stderr()).toBe("");
  });

  it("reports usage errors in the selected output mode", async () => {
    const humanOutput = captureIo();

    expect(await executeCli(["init", "--bogus"], humanOutput.io)).toBe(10);
    expect(humanOutput.stdout()).toBe("");
    expect(humanOutput.stderr()).toContain("unknown option '--bogus'");

    for (const mode of ["json", "jsonl"] as const) {
      const machineOutput = captureIo();

      expect(
        await executeCli(
          ["--output", mode, "init", "--through", "nope"],
          machineOutput.io,
        ),
      ).toBe(10);
      expect(machineOutput.stdout()).toBe("");
      const lines = machineOutput.stderr().trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        code: "usage_error",
        message: expect.stringContaining("'nope' is invalid"),
        remedy: expect.stringContaining("--help"),
      });
    }
  });

  it("prints packaged documentation and rejects unknown names", async () => {
    const list = captureIo();
    expect(await executeCli(["docs"], list.io)).toBe(0);
    expect(list.stdout()).toContain("getting-started");

    const document = captureIo();
    expect(await executeCli(["docs", "exit-codes"], document.io)).toBe(0);
    expect(document.stdout()).toContain("# Exit codes");

    const unknown = captureIo();
    expect(await executeCli(["docs", "nope"], unknown.io)).toBe(10);
    expect(unknown.stderr()).toContain("Allowed choices are");
  });
});

describe("CLI GitHub options", () => {
  it("defaults the GitHub API base URL and the watched repository", () => {
    const { program } = createProgram();
    const option = (command: string, flag: string) => {
      const found = program.commands
        .find((candidate) => candidate.name() === command)
        ?.options.find(({ long }) => long === flag);
      if (found === undefined) throw new Error(`${command} has no ${flag}`);
      return found;
    };

    for (const command of ["apply", "rollback", "watch"]) {
      expect(option(command, "--github-base-url")).toMatchObject({
        mandatory: false,
        defaultValue: "https://api.github.com",
      });
    }
    expect(option("watch", "--github-repo").mandatory).toBe(false);
  });
});

describe("CLI needs-input errors", () => {
  it("rejects a non-positive provider concurrency", async () => {
    const captured = captureIo();

    expect(
      await executeCli(
        ["--output", "json", "init", "--max-concurrency", "0"],
        captured.io,
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stderr())).toMatchObject({
      code: "invalid_option",
      message: "--max-concurrency must be a positive integer",
    });
  });

  it("rejects malformed, reserved and repeated --header values", async () => {
    const cases: Array<[string[], string]> = [
      [["no-colon"], "--header must be 'name: value'; got no-colon"],
      [[": empty"], "--header must be 'name: value'; got : empty"],
      [
        ["bad name: x"],
        "--header name bad name is not a valid HTTP header name",
      ],
      [
        ["Authorization: Bearer x"],
        "--header cannot set authorization; pass the key's environment variable with --api-key-env",
      ],
      [
        ["content-type: text/plain"],
        "--header cannot set content-type; rightmodeler sets it on every request",
      ],
      [
        ["keep-alive: timeout=5"],
        "--header cannot set keep-alive; hop-by-hop headers do not reach the provider",
      ],
      [["x-a: 1", "X-A: 2"], "--header x-a is given more than once"],
      [
        ["x-note: €uro"],
        "--header x-note has a value HTTP cannot carry; remove line breaks, control characters and characters outside Latin-1",
      ],
    ];
    for (const [values, message] of cases) {
      const captured = captureIo();

      expect(
        await executeCli(
          [
            "--output",
            "json",
            "estimate",
            ...values.flatMap((value) => ["--header", value]),
          ],
          captured.io,
        ),
      ).toBe(2);
      expect(JSON.parse(captured.stderr())).toMatchObject({
        code: "invalid_option",
        message,
      });
    }
  });

  it("accepts valid declarative matchers", async () => {
    const { repo, homeDir, root } = await fixture();
    const matchers = join(root, "matchers.json");
    await writeFile(
      matchers,
      JSON.stringify([
        {
          slug: "custom-model-call",
          description: "Custom model call",
          noiseTier: "normal",
          filePatterns: ["**/*.ts"],
          patterns: [
            {
              regex: { source: "customCall\\s*\\(", flags: "i" },
              label: "custom call",
            },
          ],
          examples: ["customCall(input)"],
          closesSurfaceIds: ["custom-framework"],
        },
      ]),
    );
    const captured = captureIo();

    expect(
      await executeCli(
        [
          "--output",
          "json",
          "init",
          "--through",
          "scan",
          "--matchers",
          matchers,
          "--repo",
          repo,
        ],
        captured.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout()).executedStages).toContain("scan");
  });

  it("rejects invalid declarative matcher flags", async () => {
    const { repo, homeDir, root } = await fixture();
    const matchers = join(root, "matchers.json");
    await writeFile(
      matchers,
      JSON.stringify([
        {
          slug: "custom-model-call",
          description: "Custom model call",
          noiseTier: "normal",
          filePatterns: ["**/*.ts"],
          patterns: [
            {
              regex: { source: "customCall\\s*\\(", flags: "g" },
              label: "custom call",
            },
          ],
          examples: ["customCall(input)"],
          closesSurfaceIds: ["custom-framework"],
        },
      ]),
    );
    const captured = captureIo();

    expect(
      await executeCli(
        [
          "--output",
          "json",
          "init",
          "--through",
          "scan",
          "--matchers",
          matchers,
          "--repo",
          repo,
        ],
        captured.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stderr())).toMatchObject({
      code: "invalid_matchers_file",
      message: expect.stringContaining("INVALID_FLAGS"),
    });
  });

  it("rejects a directory containing mixed trace formats", async () => {
    const { repo, homeDir, root } = await fixture();
    const traces = join(root, "mixed-traces");
    await mkdir(traces);
    await Promise.all([
      copyFile(validTracePath, join(traces, "a.json")),
      writeFile(join(traces, "b.jsonl"), `${emptyCodexSession}\n`),
    ]);
    const captured = captureIo();

    expect(
      await executeCli(
        [
          "--output",
          "json",
          "init",
          "--through",
          "ingest",
          "--traces",
          traces,
          "--repo",
          repo,
        ],
        captured.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stderr())).toMatchObject({
      code: "mixed_trace_formats",
    });
  });

  it("rejects an empty trace directory", async () => {
    const { repo, homeDir, root } = await fixture();
    const traces = join(root, "empty-traces");
    await mkdir(traces);
    const captured = captureIo();

    expect(
      await executeCli(
        [
          "--output",
          "json",
          "init",
          "--through",
          "ingest",
          "--traces",
          traces,
          "--repo",
          repo,
        ],
        captured.io,
        runtime(homeDir, "", undefined).runtime,
      ),
    ).toBe(2);
    expect(JSON.parse(captured.stderr())).toMatchObject({
      code: "empty_traces_directory",
    });
  });

  it("reports missing drift traces as a needs-input error", async () => {
    const { repo, homeDir } = await fixture();
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "", undefined).runtime;

    expect(
      await executeCli(
        ["--output", "json", "drift", "--repo", repo],
        captured.io,
        nonTerminal,
      ),
    ).toBe(2);
    expect(captured.stdout()).toBe("");
    expect(JSON.parse(captured.stderr())).toMatchObject({
      code: "missing_traces_path",
      message: "--traces is required",
    });
  });

  it("reports invalid evaluator options as a needs-input error", async () => {
    const { repo, homeDir } = await fixture();
    const captured = captureIo();
    const nonTerminal = runtime(homeDir, "", undefined).runtime;

    expect(
      await executeCli(
        ["--output", "json", "init", "--evaluator-scorer", "x", "--repo", repo],
        captured.io,
        nonTerminal,
      ),
    ).toBe(2);
    expect(captured.stdout()).toBe("");
    expect(JSON.parse(captured.stderr())).toMatchObject({
      code: "invalid_option",
      message: "Evaluator options require --evaluator <provider>",
    });
  });
});

describe("CLI model routes", () => {
  it("refuses route combinations that cannot run, and accepts --evaluator with --judge-route", async () => {
    const { repo, homeDir, root } = await fixture();
    const missingTraces = join(root, "no-such-traces.json");
    const api = ["--base-url", "http://127.0.0.1:9/v1"];
    const bothPlan = [
      "--route",
      "claude-login",
      "--judge-route",
      "claude-login",
    ];
    const planCandidates = ["--route", "claude-login", "--judge-route", "api"];
    const apiOnlyMessage =
      "--base-url, --api-key-env and --header configure the api route, which neither --route nor --judge-route uses";
    const modeBMessage =
      "--modeb-config runs Mode B confirmation, which calls models only through the api route; remove it, or use --base-url without a plan route";
    const detachMessage =
      "--detach runs only on the api route; plan routes run in the foreground";
    const refused: Array<[string[], string]> = [
      [
        ["init", "--route", "claude-login"],
        "--route claude-login needs --judge-route: a plan route serves one vendor's models, and the judge must come from another vendor",
      ],
      [
        ["init", "--judge-route", "api"],
        "--judge-route needs --route or --base-url to say where candidates replay",
      ],
      [
        ["init", "--judge-route", "claude-login"],
        "--judge-route needs --route or --base-url to say where candidates replay",
      ],
      [["init", ...bothPlan, ...api], apiOnlyMessage],
      [["init", ...bothPlan, "--api-key-env", "PROVIDER_KEY"], apiOnlyMessage],
      [["estimate", ...bothPlan, "--header", "x-a: 1"], apiOnlyMessage],
      [["replay", "--detach", ...planCandidates, ...api], detachMessage],
      [
        ["replay", "--detach", ...api, "--judge-route", "claude-login"],
        detachMessage,
      ],
      [
        ["init", "--modeb-config", "modeb.json", ...planCandidates, ...api],
        modeBMessage,
      ],
      [
        [
          "confirm",
          "--modeb-config",
          "modeb.json",
          ...api,
          "--judge-route",
          "claude-login",
        ],
        modeBMessage,
      ],
    ];
    for (const [args, message] of refused) {
      const captured = captureIo();

      expect(
        await executeCli(
          ["--output", "json", ...args, "--repo", repo],
          captured.io,
          runtime(homeDir, "", undefined).runtime,
        ),
        args.join(" "),
      ).toBe(2);
      expect(JSON.parse(captured.stderr())).toMatchObject({
        code: "invalid_option",
        message,
      });
    }

    const accepted = [
      [
        ...planCandidates,
        ...api,
        "--evaluator",
        "braintrust",
        "--evaluator-project-id",
        "project-1",
        "--evaluator-scorer",
        "quality",
      ],
      bothPlan,
      ["--route", "api"],
      ["--route", "claude-login", "--judge-route", "api"],
      ["--api-key-env", "PROVIDER_KEY"],
      ["--header", "x-a: 1"],
    ];
    for (const args of accepted) {
      const captured = captureIo();

      expect(
        await executeCli(
          [
            "--output",
            "json",
            "init",
            ...args,
            "--through",
            "ingest",
            "--traces",
            missingTraces,
            "--repo",
            repo,
          ],
          captured.io,
          runtime(homeDir, "", undefined).runtime,
        ),
        args.join(" "),
      ).toBe(2);
      expect(JSON.parse(captured.stderr()), args.join(" ")).toMatchObject({
        code: "missing_traces_path",
      });
    }
  });
});
