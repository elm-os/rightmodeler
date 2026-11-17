import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FsStore,
  readLedger,
  reportKey,
  resolveCommand,
  setupStateKey,
  type JsonValue,
} from "@rightmodeler/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  evidenceQuestionIdentity,
  releasePolicy,
  resolveCheckpointedPipelineCorpus,
} from "./pipeline.js";
import { hermeticPath } from "./test-utils/fake-cli.js";
import {
  allFileText,
  execFileAsync,
  fixtureCopy,
  langgraphFixtureCopy,
  lastStderrEvent,
  narrowDemoFixtureForApply,
  readStageArtifact,
  type RecordingStubProvider,
  removeTemporaryDirectories,
  runCli,
  secret,
  startGithubStub,
  startRenamedCatalogStub,
  startStub,
  storeText,
  tracesPath,
  warningMessages,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

describe("built CLI through plan routes", () => {
  const fakeBin = fileURLToPath(
    new URL("../../../fixtures/plan-cli-stub/bin", import.meta.url),
  );
  const planPrices = fileURLToPath(
    new URL(
      "../../../fixtures/catalogs/plan-route-prices.json",
      import.meta.url,
    ),
  );
  const planPath = hermeticPath(fakeBin, dirname(process.execPath));
  const apiKeyEnv = "RIGHTMODELER_PLAN_E2E_API_KEY";
  const dummyAnthropicKey = "sk-ant-plan-e2e-dummy-must-stay-home";
  const judgeModels = new Set(["zeta/judge-1", "yotta/judge-2"]);
  const loginRemedy =
    "Run claude auth login, then rerun; finished calls are kept.";
  let routed:
    | {
        root: string;
        repo: string;
        baseUrl: string;
        prices: string;
        policy: string;
      }
    | undefined;

  interface StubRecord {
    event: "start" | "end";
    pid: number;
    argv?: string[];
    stdin?: string;
    envNames?: string[];
    outcome?: string;
  }

  beforeAll(() => {
    const root = join(tmpdir(), `rightmodeler-plan-fake-${process.pid}`);
    const record = `${root}.jsonl`;
    const env = { PATH: planPath, PLAN_STUB_RECORD: record };
    const claude = resolveCommand("claude", env);
    const version = spawnSync(claude.file, [...claude.args, "--version"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(version.stdout.trim()).toBe("2.1.282 (Claude Code)");
    const lines = readFileSync(record, "utf8").trim().split("\n");
    rmSync(record, { force: true });
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      "start",
      "end",
    ]);
  });

  async function writePlanPrices(
    root: string,
    incumbents: Record<string, { input: string; output: string }> = {
      "acme/large-1": { input: "0.00003", output: "0.00015" },
    },
  ): Promise<string> {
    const catalog = JSON.parse(await readFile(planPrices, "utf8")) as {
      object: string;
      data: unknown[];
    };
    const path = join(root, "plan-prices.json");
    await writeFile(
      path,
      JSON.stringify({
        ...catalog,
        data: [
          ...catalog.data,
          // Synthetic incumbents: the fixtures' recorded models are not on the public list.
          ...Object.entries(incumbents).map(([id, pricing]) => ({
            id,
            type: "language",
            context_window: 128_000,
            pricing,
          })),
        ],
      }),
    );
    return path;
  }

  // The price list's release dates age out of the default window; these tests check routes.
  function priceListArgs(prices: string): string[] {
    return ["--catalog-reference", prices, "--released-since", "2000-01-01"];
  }

  async function writePolicy(root: string, shortlistTop: number) {
    const path = join(root, `policy-${shortlistTop}.json`);
    await writeFile(path, JSON.stringify({ shortlistTop }));
    return path;
  }

  function planEnv(
    root: string,
    name: string,
    extra: NodeJS.ProcessEnv = {},
  ): NodeJS.ProcessEnv {
    return {
      PATH: planPath,
      PLAN_STUB_RECORD: join(root, `${name}.record.jsonl`),
      PLAN_STUB_STATE: join(root, `${name}-state`),
      PLAN_STUB_FAULT: undefined,
      CI: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      [apiKeyEnv]: secret,
      ...extra,
    };
  }

  async function stubRecords(root: string, name: string) {
    let text: string;
    try {
      text = await readFile(join(root, `${name}.record.jsonl`), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StubRecord);
  }

  function modelCalls(records: readonly StubRecord[]): StubRecord[] {
    return records.filter(
      ({ event, argv }) => event === "start" && argv?.includes("--model"),
    );
  }

  function chatModels(stub: RecordingStubProvider): string[] {
    return stub
      .getRequestHeaders()
      .filter(
        ({ method, path }) =>
          method === "POST" && path === "/v1/chat/completions",
      )
      .map(({ model }) => model ?? "");
  }

  function spendProviders(ledger: Awaited<ReturnType<typeof readLedger>>) {
    const providers = (actor: string) => [
      ...new Set(
        ledger.spendEvents
          .filter((event) => event.actor === actor)
          .map(({ provider }) => provider),
      ),
    ];
    return {
      candidates: providers("replay-driver"),
      judge: providers("judge"),
    };
  }

  async function planRouteRun(label: string) {
    const { root, repo } = await fixtureCopy(label);
    const stub = await startStub();
    const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
    const prices = await writePlanPrices(root);
    const policy = await writePolicy(root, 1);
    const args = (command: string, extra: readonly string[] = []) => [
      command,
      "--traces",
      tracesPath,
      "--route",
      "claude-login",
      "--judge-route",
      "api",
      "--base-url",
      baseUrl,
      "--api-key-env",
      apiKeyEnv,
      ...priceListArgs(prices),
      "--policy",
      policy,
      ...extra,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    return { root, repo, stub, baseUrl, prices, policy, args };
  }

  it("replays candidates through claude-login and judges through an API route", async () => {
    const run = await planRouteRun("plan-route");
    try {
      const result = await runCli(run.args("init"), {
        env: planEnv(run.root, "first", {
          ANTHROPIC_API_KEY: dummyAnthropicKey,
        }),
      });

      expect(result.code, result.stderr).toBe(0);
      expect(warningMessages(result.stderr, "plan_route_key_withheld")).toEqual(
        [
          "ANTHROPIC_API_KEY is set; rightmodeler keeps it away from claude so your plan is used, not a key.",
        ],
      );
      const records = await stubRecords(run.root, "first");
      expect(modelCalls(records).length).toBeGreaterThan(0);
      expect(records.filter(({ event }) => event === "end")).not.toContainEqual(
        expect.objectContaining({ outcome: "leaked-variable" }),
      );
      const chats = chatModels(run.stub);
      expect(chats.length).toBeGreaterThan(0);
      expect(chats.filter((model) => !judgeModels.has(model))).toEqual([]);
      const storeRoot = join(run.repo, ".rightmodeler");
      const store = new FsStore(storeRoot);
      expect(spendProviders(await readLedger(store, "project"))).toEqual({
        candidates: ["claude-login"],
        judge: ["configured-provider"],
      });
      const shortlist = (await readStageArtifact(storeRoot, "shortlist")) as {
        familyPlans: Array<{
          familyId: string;
          evidenceQuestionId: string;
          stepIds: string[];
        }>;
      };
      const { corpusVersionId } = await resolveCheckpointedPipelineCorpus({
        repo: run.repo,
        store,
        storeRoot,
        projectId: "project",
      });
      expect(shortlist.familyPlans.length).toBeGreaterThan(0);
      for (const family of shortlist.familyPlans) {
        const question = {
          corpusVersionId,
          gatePolicyVersion: releasePolicy({ shortlistTop: 1 }).gate
            .gatePolicyVersion,
          evaluatorPlan: {
            evaluatorKind: "judge",
            gateMetric: "replacement-quality",
          },
          family: family.familyId,
          stepIds: family.stepIds,
          reproofRequestIds: [],
        };
        expect(family.evidenceQuestionId).toBe(
          evidenceQuestionIdentity({
            ...question,
            candidateRoute: "claude-login",
          }),
        );
        expect(family.evidenceQuestionId).not.toBe(
          evidenceQuestionIdentity(question),
        );
      }
      const report = await storeText(store, reportKey("project", "report.md"));
      expect(report).toMatch(
        /\nThrough a plan you are signed in to \(list-price equivalent, not billed\): \$\d+\.\d{8}\. Billed through the API route: \$\d+\.\d{8}\.\n/u,
      );
      expect(report).toContain("\n## Model routes\n");
      expect(report).toMatch(
        /\| candidates \| claude-login \| \d+ \| \d+\.\d{8} \(list-price equivalent\) \|/u,
      );
      expect(report).toMatch(/\| judge \| api \| \d+ \| \d+\.\d{8} \|/u);
      for (const text of [
        result.stdout,
        result.stderr,
        await allFileText(storeRoot),
        await readFile(join(run.root, "first.record.jsonl"), "utf8"),
      ]) {
        expect(text).not.toContain(dummyAnthropicKey);
      }
      routed = run;
    } finally {
      await run.stub.close();
    }
  }, 180_000);

  it("keeps plan-route stages apart from API stages: an identical init --plan keeps them complete, --judge-route claude-login (without --base-url) makes replay stale, and --base-url alone makes shortlist stale", async () => {
    expect(routed).toBeDefined();
    const { root, repo, baseUrl, prices, policy } = routed!;
    const stages = async (extra: readonly string[]) => {
      const result = await runCli(
        [
          "init",
          "--plan",
          "--traces",
          tracesPath,
          ...extra,
          ...priceListArgs(prices),
          "--policy",
          policy,
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env: planEnv(root, "plan-only") },
      );
      expect(result.code, result.stderr).toBe(0);
      return Object.fromEntries(
        (
          JSON.parse(result.stdout) as {
            stages: Array<{ stage: string; state: string }>;
          }
        ).stages.map(({ stage, state }) => [stage, state]),
      );
    };

    const identical = await stages([
      "--route",
      "claude-login",
      "--judge-route",
      "api",
      "--base-url",
      baseUrl,
      "--api-key-env",
      apiKeyEnv,
    ]);
    const judgeOnPlan = await stages([
      "--route",
      "claude-login",
      "--judge-route",
      "claude-login",
    ]);
    const apiOnly = await stages([
      "--base-url",
      baseUrl,
      "--api-key-env",
      apiKeyEnv,
    ]);

    expect(new Set(Object.values(identical))).toEqual(new Set(["complete"]));
    expect(judgeOnPlan).toMatchObject({
      shortlist: "complete",
      replay: "stale",
    });
    expect(apiOnly).toMatchObject({ corpus: "complete", shortlist: "stale" });
    expect(await stubRecords(root, "plan-only")).toEqual([]);
  }, 180_000);

  it("drops candidates from the judge route's vendor with a warning and judges the rest through claude-login", async () => {
    const { root, repo } = await fixtureCopy("plan-judge-vendor");
    const stub = await startRenamedCatalogStub({
      "acme/lite-1": "anthropic/claude-haiku-4.5",
    });
    const apiArgs = [
      "--traces",
      tracesPath,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      ...priceListArgs(await writePlanPrices(root)),
      "--policy",
      await writePolicy(root, 2),
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      const result = await runCli(
        ["init", "--judge-route", "claude-login", ...apiArgs],
        { env: planEnv(root, "judge-vendor") },
      );

      expect(result.code, result.stderr).toBe(0);
      expect(
        warningMessages(result.stderr, "judge_vendor_candidates_dropped"),
      ).toEqual([
        "Candidates anthropic/claude-haiku-4.5 were left out: the judge runs through claude-login (anthropic), and it must come from another vendor than the candidate.",
      ]);
      const chats = chatModels(stub.upstream);
      expect(chats.length).toBeGreaterThan(0);
      expect(new Set(chats)).toEqual(new Set(["acme/small-1"]));
      expect(
        modelCalls(await stubRecords(root, "judge-vendor")).length,
      ).toBeGreaterThan(0);
      expect(
        spendProviders(
          await readLedger(new FsStore(join(repo, ".rightmodeler")), "project"),
        ),
      ).toEqual({
        candidates: ["configured-provider"],
        judge: ["claude-login"],
      });
      const estimated = await runCli(
        ["estimate", "--judge-route", "claude-login", ...apiArgs],
        { env: planEnv(root, "judge-vendor-estimate") },
      );
      expect(estimated.code, estimated.stderr).toBe(0);
      expect(
        warningMessages(estimated.stderr, "judge_vendor_candidates_dropped"),
      ).toEqual([
        "Candidates anthropic/claude-haiku-4.5 were left out: the judge runs through claude-login (anthropic), and it must come from another vendor than the candidate.",
      ]);
      expect(
        modelCalls(await stubRecords(root, "judge-vendor-estimate")),
      ).toEqual([]);
      const apiJudge = await runCli(["init", "--plan", ...apiArgs], {
        env: planEnv(root, "judge-vendor-plan"),
      });
      expect(apiJudge.code, apiJudge.stderr).toBe(0);
      expect(
        Object.fromEntries(
          (
            JSON.parse(apiJudge.stdout) as {
              stages: Array<{ stage: string; state: string }>;
            }
          ).stages.map(({ stage, state }) => [stage, state]),
        ),
      ).toMatchObject({ shortlist: "complete", replay: "stale" });
    } finally {
      await stub.close();
    }
  }, 180_000);

  it("stops before any model call when every candidate shares the judge route's vendor", async () => {
    const { root, repo } = await fixtureCopy("plan-same-vendor");
    const result = await runCli(
      [
        "init",
        "--traces",
        tracesPath,
        "--route",
        "claude-login",
        "--judge-route",
        "claude-login",
        ...priceListArgs(await writePlanPrices(root)),
        "--policy",
        await writePolicy(root, 1),
        "--output",
        "json",
        "--repo",
        repo,
      ],
      { env: planEnv(root, "same-vendor") },
    );

    expect(result.code, result.stderr).toBe(2);
    expect(lastStderrEvent(result)).toEqual({
      code: "no_neutral_judge",
      message:
        "Every shortlisted candidate is from anthropic, the vendor of the judge route claude-login, so no candidate can be judged neutrally.",
      remedy:
        "Use a --judge-route from another vendor, or an api --route whose catalog lists other vendors.",
    });
    expect(modelCalls(await stubRecords(root, "same-vendor"))).toEqual([]);
  }, 180_000);

  it("leaves multi-turn cases out of a plan route's sample with plan_route_cases_left_out", async () => {
    const run = await planRouteRun("plan-multi-turn");
    const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
      attributes: Record<string, unknown>;
    }>;
    for (const { attributes } of traces
      .filter(
        ({ attributes }) => attributes["rightmodeler.family"] === "summarize",
      )
      .slice(0, 5)) {
      attributes["gen_ai.input.messages"] = [
        ...(attributes["gen_ai.input.messages"] as JsonValue[]),
        {
          role: "assistant",
          parts: [{ type: "text", content: "An earlier answer." }],
        },
        { role: "user", parts: [{ type: "text", content: "And then?" }] },
      ];
    }
    const multiTurn = join(run.root, "multi-turn.json");
    await writeFile(multiTurn, JSON.stringify(traces));
    try {
      const args = run.args("init");
      args[args.indexOf(tracesPath)] = multiTurn;
      const result = await runCli(args, {
        env: planEnv(run.root, "multi-turn"),
      });

      expect(result.code, result.stderr).toBe(0);
      const warnings = warningMessages(
        result.stderr,
        "plan_route_cases_left_out",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /^Family summarize: 5 of \d+ recorded cases have an earlier assistant or tool turn or more than one user message, and the claude-login route sends one user turn, so they were left out of the replay sample\.$/u,
      );
      expect(
        warningMessages(result.stderr, "recorded_messages_not_replayable"),
      ).toEqual([]);
      const bindingLeftOut = Number(
        /^Family summarize: (\d+) of /u.exec(
          warningMessages(result.stderr, "family_cases_left_out").find(
            (message) => message.startsWith("Family summarize: "),
          ) ?? "",
        )?.[1] ?? 0,
      );
      const shortlist = (await readStageArtifact(
        join(run.repo, ".rightmodeler"),
        "shortlist",
      )) as { familyPlans: Array<{ familyId: string; leftOutCases?: number }> };
      expect(
        shortlist.familyPlans.find(({ familyId }) => familyId === "summarize")
          ?.leftOutCases,
      ).toBe(bindingLeftOut + 5);
      const calls = modelCalls(await stubRecords(run.root, "multi-turn"));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter(({ stdin }) => stdin === "And then?")).toEqual([]);
    } finally {
      await run.stub.close();
    }
  }, 180_000);

  it("stops at plan_usage_limit (exit 2) and resumes on rerun without repeating completed calls", async () => {
    const run = await planRouteRun("plan-usage-limit");
    try {
      const limited = await runCli(run.args("init"), {
        env: planEnv(run.root, "limited", {
          PLAN_STUB_FAULT: "usage-limit-after:6",
        }),
      });

      expect(limited.code, limited.stderr).toBe(2);
      expect(lastStderrEvent(limited)).toEqual({
        code: "plan_usage_limit",
        message: expect.stringContaining(
          "claude-login reached its plan's usage limit (resets 2026-",
        ),
        remedy:
          "Rerun the same command after the limit resets; completed replay and judge calls are kept and not repeated. To go on now, choose a route that does not use this plan with --route or --judge-route.",
      });
      const store = new FsStore(join(run.repo, ".rightmodeler"));
      const state = JSON.parse(
        await storeText(store, setupStateKey("project")),
      ) as { stages: Record<string, unknown> };
      expect(state.stages.shortlist).toBeDefined();
      expect(state.stages.replay).toBeUndefined();

      const resumed = await runCli(run.args("init"), {
        env: planEnv(run.root, "resumed"),
      });

      expect(resumed.code, resumed.stderr).toBe(0);
      const firstRecords = await stubRecords(run.root, "limited");
      const finished = new Set(
        firstRecords
          .filter(({ outcome }) => outcome === "ok")
          .map(({ pid }) => pid),
      );
      const pair = ({ argv, stdin }: StubRecord) =>
        JSON.stringify([argv![argv!.indexOf("--model") + 1], stdin]);
      const completed = new Set(
        modelCalls(firstRecords)
          .filter(({ pid }) => finished.has(pid))
          .map(pair),
      );
      expect(completed.size).toBeGreaterThanOrEqual(6);
      const repeated = modelCalls(await stubRecords(run.root, "resumed"))
        .map(pair)
        .filter((key) => completed.has(key));
      expect(repeated).toEqual([]);
    } finally {
      await run.stub.close();
    }
  }, 180_000);

  it("exits 2 plan_login_required and plan_cli_unavailable with their remedies, in estimate and init, and when CI is set", async () => {
    const run = await planRouteRun("plan-errors");
    const cases = [
      {
        command: "estimate",
        env: { PLAN_STUB_FAULT: "logged-out" },
        error: {
          code: "plan_login_required",
          message: "claude is not signed in on this machine.",
          remedy: loginRemedy,
        },
      },
      {
        command: "estimate",
        env: { PLAN_STUB_FAULT: "old-version" },
        error: {
          code: "plan_cli_unavailable",
          message:
            "claude 2.1.281 is older than 2.1.282, the version rightmodeler's isolation settings were verified on.",
          remedy: "Update with claude update, then rerun.",
        },
      },
      {
        command: "init",
        env: { PLAN_STUB_FAULT: "auth-failed" },
        error: {
          code: "plan_login_required",
          message:
            "claude stopped accepting its login during the run (authentication_failed).",
          remedy: loginRemedy,
        },
      },
      {
        command: "init",
        env: { CI: "true" },
        error: {
          code: "plan_cli_unavailable",
          message: "Plan routes run only on your own machine, and CI is set.",
          remedy:
            "In continuous integration, use an API route: --base-url <url> and --api-key-env <name>. If this is your own machine, unset CI and rerun.",
        },
      },
    ];
    try {
      for (const [index, { command, env, error }] of cases.entries()) {
        const result = await runCli(run.args(command), {
          env: planEnv(run.root, `error-${index}`, env),
        });

        expect(result.code, result.stderr).toBe(2);
        expect(lastStderrEvent(result)).toEqual(error);
      }
    } finally {
      await run.stub.close();
    }
  }, 180_000);

  it("estimate states list-price equivalents for a plan route without calling a model", async () => {
    const run = await planRouteRun("plan-estimate");
    try {
      const result = await runCli(run.args("estimate"), {
        env: planEnv(run.root, "estimate"),
      });

      expect(result.code, result.stderr).toBe(0);
      const estimate = JSON.parse(result.stdout) as {
        basis: string;
        candidateExecutions: number;
      };
      expect(estimate.basis).toBe(
        `List-price equivalents from the price list ${run.prices} for calls made through a plan you are signed in to (charged to that plan's usage allowance, not billed in dollars), and current provider catalog pricing for any API route. Worst-case candidate reservation from corpus token bounds; holdout uses the most expensive possible family winner. Judge calls are priced at two calls per replayed cell. A plan route sets no output cap, so actual use can exceed this figure.`,
      );
      expect(estimate.candidateExecutions).toBeGreaterThan(0);
      const records = await stubRecords(run.root, "estimate");
      expect(records.length).toBeGreaterThan(0);
      expect(modelCalls(records)).toEqual([]);
      expect(chatModels(run.stub)).toEqual([]);
    } finally {
      await run.stub.close();
    }
  }, 180_000);

  it("marks a confirmation-needing family blocked with the API-route blocker on a plan route", async () => {
    const { root, repo, traces } =
      await langgraphFixtureCopy("plan-unconfirmed");
    const stub = await startStub();
    const blocker =
      "Mode B confirmation runs only when candidates and the judge use the api route; measure this family with --base-url and pass --modeb-config to confirm it.";
    const common = [
      "--traces",
      traces,
      "--base-url",
      `http://127.0.0.1:${stub.port}/v1`,
      "--api-key-env",
      apiKeyEnv,
      ...priceListArgs(
        await writePlanPrices(root, {
          "acme/large-1": { input: "0.00003", output: "0.00015" },
          "acme/max-1": { input: "0.00006", output: "0.0003" },
        }),
      ),
      "--policy",
      await writePolicy(root, 1),
      "--output",
      "json",
      "--repo",
      repo,
    ];
    try {
      for (const [name, routes] of [
        ["unconfirmed", ["--route", "claude-login", "--judge-route", "api"]],
        ["unconfirmed-judge", ["--judge-route", "claude-login"]],
      ] as const) {
        const result = await runCli(["init", ...routes, ...common], {
          env: planEnv(root, name),
        });

        expect(result.code, result.stderr).toBe(0);
        expect(
          (JSON.parse(result.stdout) as { familyOutcomes: unknown[] })
            .familyOutcomes,
        ).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            decisionDisplay: "recommend (unconfirmed)",
            confirmation: expect.objectContaining({
              status: "blocked",
              blocker,
            }),
          }),
        );
        expect(
          modelCalls(await stubRecords(root, name)).length,
        ).toBeGreaterThan(0);
        expect(
          await storeText(
            new FsStore(join(repo, ".rightmodeler")),
            reportKey("project", "report.md"),
          ),
        ).toContain(blocker);
      }
    } finally {
      await stub.close();
    }
  }, 180_000);

  it("keeps API-only report and status output free of plan-route text", async () => {
    const { root, repo } = await fixtureCopy("api-only-report");
    const stub = await startStub();
    const target = ["--output", "json", "--repo", repo];
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          tracesPath,
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
          "--policy",
          await writePolicy(root, 1),
          ...target,
        ],
        { env: planEnv(root, "api-only") },
      );

      expect([0, 1], result.stderr).toContain(result.code);
      const store = new FsStore(join(repo, ".rightmodeler"));
      const markdown = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(markdown).toContain("\n## Spend\n");
      expect(markdown).not.toContain("## Model routes");
      expect(markdown).not.toContain("Through a plan you are signed in to");
      const report = JSON.parse(
        await storeText(store, reportKey("project", "report.json")),
      ) as { spend: Record<string, unknown> };
      expect(report.spend.events).toEqual(expect.any(Number));
      expect(report.spend).not.toHaveProperty("routes");
      const status = await runCli(["status", ...target], {
        env: planEnv(root, "api-only"),
      });
      expect(status.code, status.stderr).toBe(0);
      const { spend } = JSON.parse(status.stdout) as {
        spend: Record<string, unknown>;
      };
      expect(spend.events).toEqual(report.spend.events);
      expect(spend).not.toHaveProperty("routes");
      expect(await stubRecords(root, "api-only")).toEqual([]);
    } finally {
      await stub.close();
    }
  }, 180_000);

  it("labels the apply pull request body when the winner was measured through claude-login", async () => {
    const { root, repo } = await fixtureCopy("route-apply");
    const filteredTraces = await narrowDemoFixtureForApply(root, repo);
    const stub = await startStub();
    const githubToken = "github-plan-route-token";
    const github = await startGithubStub(githubToken);
    const githubBaseUrl = `http://127.0.0.1:${github.port}`;
    const head = (
      await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    try {
      const seeded = await fetch(`${githubBaseUrl}/__test/seed`, {
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
      expect(seeded.status).toBe(201);
      const env = planEnv(root, "apply", {
        RIGHTMODELER_PLAN_E2E_GITHUB_TOKEN: githubToken,
      });
      const initialized = await runCli(
        [
          "init",
          "--traces",
          filteredTraces,
          "--route",
          "claude-login",
          "--judge-route",
          "api",
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
          ...priceListArgs(
            await writePlanPrices(root, {
              "acme/large-1": { input: "0.00003", output: "0.00015" },
              "acme/max-1": { input: "0.00006", output: "0.0003" },
            }),
          ),
          "--policy",
          await writePolicy(root, 1),
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env },
      );
      expect(initialized.code, initialized.stderr).toBe(1);
      expect(
        (JSON.parse(initialized.stdout) as { recommendationExists: boolean })
          .recommendationExists,
      ).toBe(true);

      const dryRun = await runCli(
        [
          "apply",
          "--owner",
          "acme",
          "--github-repo",
          "demo-app",
          "--github-base-url",
          githubBaseUrl,
          "--github-token-env",
          "RIGHTMODELER_PLAN_E2E_GITHUB_TOKEN",
          "--dry-run",
          "--output",
          "json",
          "--repo",
          repo,
        ],
        { env },
      );

      expect(dryRun.code, dryRun.stderr).toBe(0);
      const preview = JSON.parse(dryRun.stdout) as {
        status: string;
        body: string;
      };
      expect(preview.status).toBe("dry_run");
      expect(preview.body).toContain(
        "\nCase IDs are SHA-256 digests of the replayed case, not file paths.\nMeasured through the claude CLI signed in to a Claude plan, not the Anthropic API: the CLI added its own instructions to each call and could not set temperature or an output limit. Run `rightmodeler docs model-routes` for details.\n",
      );
    } finally {
      await github.close();
      await stub.close();
    }
  }, 180_000);

  type CodexRecord = StubRecord & { command?: string; cwd?: string };
  const dummyCodexKey = "sk-codex-plan-e2e-dummy-must-stay-home";
  const codexSentence =
    "Codex does not report which model answered: the requested model is recorded, and a call Codex reports as rerouted is left out of the evidence. Codex keeps a code tool and a patch tool that cannot be turned off, so a call can include a tool step its output does not show; a call where Codex reports a tool step is left out of the evidence. Rightmodeler turns off Codex's code execution for these calls. Codex also adds your global instructions file, when you have one, to every call, and runs each model at its default reasoning effort. Codex reports no latency, so the p50 latency of a Codex answer reads n/a.";
  const claudeLatencySentence =
    " Their latency is the API time the CLI reports.";

  async function codexEnv(
    root: string,
    name: string,
    extra: NodeJS.ProcessEnv = {},
  ): Promise<NodeJS.ProcessEnv> {
    const codexHome = join(root, `${name}-codex-home`);
    await mkdir(codexHome, { recursive: true });
    return planEnv(root, name, {
      CODEX_HOME: codexHome,
      PLAN_STUB_CODEX_FAULT: undefined,
      CODEX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_FEDERATION_RULE_ID: undefined,
      OPENAI_IDENTITY_TOKEN_FILE: undefined,
      ...extra,
    });
  }

  async function codexExecs(root: string, name: string) {
    return ((await stubRecords(root, name)) as CodexRecord[]).filter(
      ({ event, command, argv }) =>
        event === "start" && command === "codex" && argv?.[0] === "exec",
    );
  }

  async function codexRouteRun(label: string, route: string, judge: string) {
    const { root, repo } = await fixtureCopy(label);
    const prices = await writePlanPrices(root);
    const policy = await writePolicy(root, 1);
    const args = (command: string, extra: readonly string[] = []) => [
      command,
      "--traces",
      tracesPath,
      "--route",
      route,
      "--judge-route",
      judge,
      ...priceListArgs(prices),
      "--policy",
      policy,
      ...extra,
      "--output",
      "json",
      "--repo",
      repo,
    ];
    return { root, repo, prices, args };
  }

  it("exits 2 before any codex call when both roles are codex-login", async () => {
    const run = await codexRouteRun(
      "codex-same-vendor",
      "codex-login",
      "codex-login",
    );

    const result = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "codex-same-vendor"),
    });

    expect(result.code, result.stderr).toBe(2);
    expect(lastStderrEvent(result)).toEqual({
      code: "no_neutral_judge",
      message:
        "Every shortlisted candidate is from openai, the vendor of the judge route codex-login, so no candidate can be judged neutrally.",
      remedy:
        "Use a --judge-route from another vendor, or an api --route whose catalog lists other vendors.",
    });
    expect(await codexExecs(run.root, "codex-same-vendor")).toEqual([]);
  }, 180_000);

  it("replays candidates through codex-login and judges through claude-login", async () => {
    const run = await codexRouteRun(
      "codex-candidates",
      "codex-login",
      "claude-login",
    );

    const result = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "codex-candidates", {
        ANTHROPIC_API_KEY: dummyAnthropicKey,
        CODEX_API_KEY: dummyCodexKey,
      }),
    });

    expect(result.code, result.stderr).toBe(0);
    expect(
      warningMessages(result.stderr, "plan_route_key_withheld").sort(),
    ).toEqual([
      "ANTHROPIC_API_KEY is set; rightmodeler keeps it away from claude so your plan is used, not a key.",
      "CODEX_API_KEY is set; rightmodeler keeps it away from codex so your plan is used, not a key.",
    ]);
    const records = (await stubRecords(
      run.root,
      "codex-candidates",
    )) as CodexRecord[];
    const execs = await codexExecs(run.root, "codex-candidates");
    expect(execs.length).toBeGreaterThan(0);
    expect(modelCalls(records).length).toBeGreaterThan(0);
    for (const { cwd } of execs) expect(existsSync(cwd!)).toBe(false);
    expect(records.filter(({ event }) => event === "end")).not.toContainEqual(
      expect.objectContaining({ outcome: "leaked-variable" }),
    );
    const storeRoot = join(run.repo, ".rightmodeler");
    const store = new FsStore(storeRoot);
    expect(spendProviders(await readLedger(store, "project"))).toEqual({
      candidates: ["codex-login"],
      judge: ["claude-login"],
    });
    const report = await storeText(store, reportKey("project", "report.md"));
    expect(report).toMatch(
      /\| candidates \| codex-login \| \d+ \| \d+\.\d{8} \(list-price equivalent\) \|/u,
    );
    expect(report).toMatch(
      /\| judge \| claude-login \| \d+ \| \d+\.\d{8} \(list-price equivalent\) \|/u,
    );
    expect(report).toContain(`\n\n${codexSentence}\n`);
    for (const text of [
      result.stdout,
      result.stderr,
      await allFileText(storeRoot),
      await readFile(join(run.root, "codex-candidates.record.jsonl"), "utf8"),
    ]) {
      expect(text).not.toContain(dummyAnthropicKey);
      expect(text).not.toContain(dummyCodexKey);
    }
  }, 180_000);

  type SchemaRecord = CodexRecord & { outputSchema?: unknown };
  const verdictSchema = {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["equivalent", "minor_drift", "divergent"],
      },
      score: { type: "number", minimum: 0, maximum: 1 },
      justification: { type: "string" },
    },
    required: ["verdict", "score", "justification"],
    additionalProperties: false,
  };

  function judgeFailureKinds(ledger: Awaited<ReturnType<typeof readLedger>>) {
    return ledger.spendEvents.flatMap(({ actor, reconcilableTo }) => {
      const kind = (reconcilableTo as Record<string, unknown> | null)
        ?.judgeFailureKind;
      return actor === "judge" && kind !== undefined ? [kind] : [];
    });
  }

  it("judges through claude-login with the verdict schema, replays codex candidates without one, and parses a justification that quotes the reference", async () => {
    const run = await codexRouteRun(
      "claude-schema-judge",
      "codex-login",
      "claude-login",
    );

    const result = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "claude-schema-judge", {
        PLAN_STUB_FAULT: "quoted-justification",
      }),
    });

    expect(result.code, result.stderr).toBe(0);
    const ledger = await readLedger(
      new FsStore(join(run.repo, ".rightmodeler")),
      "project",
    );
    expect(judgeFailureKinds(ledger)).toEqual([]);
    expect(ledger.executions.length).toBeGreaterThan(0);
    expect(ledger.assessments).toHaveLength(ledger.executions.length);
    for (const { artifactRef } of ledger.assessments) {
      expect((artifactRef as Record<string, unknown>).justification).toContain(
        'paraphrasing "prior to its debut performance"',
      );
    }
    const judgeCalls = modelCalls(
      await stubRecords(run.root, "claude-schema-judge"),
    );
    expect(judgeCalls.length).toBeGreaterThan(0);
    for (const { argv } of judgeCalls) {
      expect(argv!.at(-2)).toBe("--json-schema");
      expect(JSON.parse(argv!.at(-1)!)).toEqual(verdictSchema);
      expect(argv![argv!.indexOf("--max-turns") + 1]).toBe("3");
    }
    const execs = (await codexExecs(
      run.root,
      "claude-schema-judge",
    )) as SchemaRecord[];
    expect(execs.length).toBeGreaterThan(0);
    for (const exec of execs) {
      expect(exec.argv).not.toContain("--output-schema");
      expect(exec).not.toHaveProperty("outputSchema");
    }
  }, 180_000);

  it("judges through codex-login with the verdict schema file and replays claude candidates without one", async () => {
    const run = await codexRouteRun(
      "codex-schema-judge",
      "claude-login",
      "codex-login",
    );

    const result = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "codex-schema-judge"),
    });

    expect(result.code, result.stderr).toBe(0);
    const ledger = await readLedger(
      new FsStore(join(run.repo, ".rightmodeler")),
      "project",
    );
    expect(judgeFailureKinds(ledger)).toEqual([]);
    expect(ledger.executions.length).toBeGreaterThan(0);
    expect(ledger.assessments).toHaveLength(ledger.executions.length);
    const execs = (await codexExecs(
      run.root,
      "codex-schema-judge",
    )) as SchemaRecord[];
    expect(execs.length).toBeGreaterThan(0);
    for (const { argv, outputSchema } of execs) {
      const at = argv!.indexOf("--output-schema");
      expect(argv!.slice(at, at + 3)).toEqual([
        "--output-schema",
        join(argv![argv!.indexOf("-C") + 1]!, "output-schema.json"),
        "-o",
      ]);
      expect(outputSchema).toEqual(verdictSchema);
    }
    const candidateCalls = modelCalls(
      await stubRecords(run.root, "codex-schema-judge"),
    );
    expect(candidateCalls.length).toBeGreaterThan(0);
    for (const { argv } of candidateCalls) {
      expect(argv).not.toContain("--json-schema");
      expect(argv![argv!.indexOf("--max-turns") + 1]).toBe("1");
    }
  }, 180_000);

  it("books a claude judge verdict that fails the schema as response_malformed", async () => {
    const run = await codexRouteRun(
      "claude-schema-mismatch",
      "codex-login",
      "claude-login",
    );

    const result = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "claude-schema-mismatch", {
        PLAN_STUB_FAULT: "schema-mismatch",
      }),
    });

    const ledger = await readLedger(
      new FsStore(join(run.repo, ".rightmodeler")),
      "project",
    );
    const kinds = judgeFailureKinds(ledger);
    expect(kinds.length, result.stderr).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(["response_malformed"]));
    expect(ledger.assessments).toEqual([]);
  }, 180_000);

  it("judges API candidates through claude-login with the verdict schema", async () => {
    const { root, repo } = await fixtureCopy("plan-api-schema-judge");
    const stub = await startStub();
    try {
      const result = await runCli(
        [
          "init",
          "--traces",
          tracesPath,
          "--judge-route",
          "claude-login",
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
          ...priceListArgs(await writePlanPrices(root)),
          "--policy",
          await writePolicy(root, 1),
          "--output",
          "json",
          "--repo",
          repo,
        ],
        {
          env: planEnv(root, "api-schema-judge", {
            PLAN_STUB_FAULT: "quoted-justification",
          }),
        },
      );

      expect(result.code, result.stderr).toBe(0);
      const ledger = await readLedger(
        new FsStore(join(repo, ".rightmodeler")),
        "project",
      );
      expect(spendProviders(ledger)).toEqual({
        candidates: ["configured-provider"],
        judge: ["claude-login"],
      });
      expect(judgeFailureKinds(ledger)).toEqual([]);
      expect(ledger.executions.length).toBeGreaterThan(0);
      expect(ledger.assessments).toHaveLength(ledger.executions.length);
      const judgeCalls = modelCalls(
        await stubRecords(root, "api-schema-judge"),
      );
      expect(judgeCalls.length).toBeGreaterThan(0);
      for (const { argv } of judgeCalls) {
        expect(argv!.at(-2)).toBe("--json-schema");
        expect(JSON.parse(argv!.at(-1)!)).toEqual(verdictSchema);
      }
    } finally {
      await stub.close();
    }
  }, 180_000);

  it("states the latency sentence only with a claude-login route and the Codex sentences only with a codex-login route", async () => {
    expect(routed).toBeDefined();
    const claudeReport = await storeText(
      new FsStore(join(routed!.repo, ".rightmodeler")),
      reportKey("project", "report.md"),
    );
    const run = await codexRouteRun("codex-api-judge", "codex-login", "api");
    const stub = await startStub();
    try {
      const result = await runCli(
        run.args("init", [
          "--base-url",
          `http://127.0.0.1:${stub.port}/v1`,
          "--api-key-env",
          apiKeyEnv,
        ]),
        { env: await codexEnv(run.root, "codex-api-judge") },
      );

      expect(result.code, result.stderr).toBe(0);
      const chats = chatModels(stub);
      expect(chats.length).toBeGreaterThan(0);
      expect(chats.filter((model) => !judgeModels.has(model))).toEqual([]);
      const store = new FsStore(join(run.repo, ".rightmodeler"));
      expect(spendProviders(await readLedger(store, "project"))).toEqual({
        candidates: ["codex-login"],
        judge: ["configured-provider"],
      });
      const codexReport = await storeText(
        store,
        reportKey("project", "report.md"),
      );
      expect(codexReport).toContain(`\n\n${codexSentence}\n`);
      expect(codexReport).not.toContain(claudeLatencySentence);
      expect(claudeReport).toContain(claudeLatencySentence);
      expect(claudeReport).not.toContain("Codex");
    } finally {
      await stub.close();
    }
  }, 180_000);

  it("leaves multi-turn cases out of a codex-login sample with the plan route's own reason", async () => {
    const run = await codexRouteRun(
      "codex-multi-turn",
      "codex-login",
      "claude-login",
    );
    const traces = JSON.parse(await readFile(tracesPath, "utf8")) as Array<{
      attributes: Record<string, unknown>;
    }>;
    for (const { attributes } of traces
      .filter(
        ({ attributes }) => attributes["rightmodeler.family"] === "summarize",
      )
      .slice(0, 5)) {
      attributes["gen_ai.input.messages"] = [
        ...(attributes["gen_ai.input.messages"] as JsonValue[]),
        {
          role: "assistant",
          parts: [{ type: "text", content: "An earlier answer." }],
        },
        { role: "user", parts: [{ type: "text", content: "And then?" }] },
      ];
    }
    const multiTurn = join(run.root, "multi-turn.json");
    await writeFile(multiTurn, JSON.stringify(traces));
    const args = run.args("init");
    args[args.indexOf(tracesPath)] = multiTurn;

    const result = await runCli(args, {
      env: await codexEnv(run.root, "codex-multi-turn"),
    });

    expect(result.code, result.stderr).toBe(0);
    const warnings = warningMessages(
      result.stderr,
      "plan_route_cases_left_out",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^Family summarize: 5 of \d+ recorded cases have an earlier assistant or tool turn or more than one user message, and the codex-login route sends one user turn, so they were left out of the replay sample\.$/u,
    );
    const execs = await codexExecs(run.root, "codex-multi-turn");
    expect(execs.length).toBeGreaterThan(0);
    expect(execs.filter(({ stdin }) => stdin === "And then?")).toEqual([]);
  }, 180_000);

  it("judges claude-login candidates through codex-login, stops at plan_usage_limit (exit 2) quoting Codex's reset time, and resumes on rerun without repeating completed calls", async () => {
    const run = await codexRouteRun(
      "codex-usage-limit",
      "claude-login",
      "codex-login",
    );

    const limited = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "codex-limited", {
        PLAN_STUB_CODEX_FAULT: "usage-limit-after:2",
      }),
    });

    expect(limited.code, limited.stderr).toBe(2);
    expect(lastStderrEvent(limited)).toEqual({
      code: "plan_usage_limit",
      message: expect.stringContaining(
        "codex-login reached its plan's usage limit (resets 3:45 PM): You've hit your usage limit. Try again at 3:45 PM.",
      ),
      remedy:
        "Rerun the same command after the limit resets; completed replay and judge calls are kept and not repeated. To go on now, choose a route that does not use this plan with --route or --judge-route.",
    });
    const store = new FsStore(join(run.repo, ".rightmodeler"));
    const state = JSON.parse(
      await storeText(store, setupStateKey("project")),
    ) as { stages: Record<string, unknown> };
    expect(state.stages.shortlist).toBeDefined();
    expect(state.stages.replay).toBeUndefined();

    const resumed = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "codex-resumed"),
    });

    expect(resumed.code, resumed.stderr).toBe(0);
    const firstRecords = await stubRecords(run.root, "codex-limited");
    const finished = new Set(
      firstRecords
        .filter(({ outcome }) => outcome === "ok")
        .map(({ pid }) => pid),
    );
    const pair = ({ argv, stdin }: StubRecord) =>
      JSON.stringify([argv![argv!.indexOf("--model") + 1], stdin]);
    const completed = new Set(
      modelCalls(firstRecords)
        .filter(({ pid }) => finished.has(pid))
        .map(pair),
    );
    expect(completed.size).toBeGreaterThan(0);
    const repeated = modelCalls(await stubRecords(run.root, "codex-resumed"))
      .map(pair)
      .filter((key) => completed.has(key));
    expect(repeated).toEqual([]);
    expect(spendProviders(await readLedger(store, "project")).judge).toEqual([
      "codex-login",
    ]);
  }, 180_000);

  it("moves the codex judge to its next model on a limit for one model", async () => {
    const run = await codexRouteRun(
      "codex-model-limit",
      "claude-login",
      "codex-login",
    );

    const result = await runCli(run.args("init"), {
      env: await codexEnv(run.root, "codex-model-limit", {
        PLAN_STUB_CODEX_FAULT: "model-limit:first",
      }),
    });

    expect(result.code, result.stderr).toBe(0);
    const unusable = warningMessages(result.stderr, "judge_unusable");
    expect(unusable).toHaveLength(1);
    const [, first, next] =
      /^Judge (openai\/[\w.-]+) is unusable after three consecutive terminal failures; switching to (openai\/[\w.-]+)\.$/u.exec(
        unusable[0]!,
      ) ?? [];
    expect(first).toBeDefined();
    expect(next).not.toBe(first);
    const execs = await codexExecs(run.root, "codex-model-limit");
    const model = ({ argv }: StubRecord) =>
      `openai/${argv![argv!.indexOf("-m") + 1]}`;
    expect(model(execs[0]!)).toBe(first);
    expect(execs.map(model)).toContain(next);
  }, 180_000);

  it("estimates a codex-login run without a model call", async () => {
    const run = await codexRouteRun(
      "codex-estimate",
      "codex-login",
      "claude-login",
    );

    const result = await runCli(run.args("estimate"), {
      env: await codexEnv(run.root, "codex-estimate"),
    });

    expect(result.code, result.stderr).toBe(0);
    const estimate = JSON.parse(result.stdout) as {
      basis: string;
      candidateExecutions: number;
    };
    expect(estimate.basis).toBe(
      `List-price equivalents from the price list ${run.prices} for calls made through a plan you are signed in to (charged to that plan's usage allowance, not billed in dollars), and current provider catalog pricing for any API route. Worst-case candidate reservation from corpus token bounds; holdout uses the most expensive possible family winner. Judge calls are priced at two calls per replayed cell. A plan route sets no output cap, so actual use can exceed this figure.`,
    );
    expect(estimate.candidateExecutions).toBeGreaterThan(0);
    const records = (await stubRecords(
      run.root,
      "codex-estimate",
    )) as CodexRecord[];
    expect(
      records.filter(({ command }) => command === "codex").length,
    ).toBeGreaterThan(0);
    expect(await codexExecs(run.root, "codex-estimate")).toEqual([]);
    expect(modelCalls(records)).toEqual([]);
  }, 180_000);

  it("keeps the run's --api-key-env variable and the gateway key variables away from every claude and codex process", async () => {
    const stub = await startStub();
    const baseUrl = `http://127.0.0.1:${stub.port}/v1`;
    const gatewayKeys = {
      AI_GATEWAY_API_KEY: "rm-gateway-dummy-key",
      OPENROUTER_API_KEY: "rm-openrouter-dummy-key",
    };
    const keyNames = [apiKeyEnv, ...Object.keys(gatewayKeys)];
    try {
      const judged = await fixtureCopy("plan-key-env-judge");
      const judgedResult = await runCli(
        [
          "init",
          "--judge-route",
          "claude-login",
          "--traces",
          tracesPath,
          "--base-url",
          baseUrl,
          "--api-key-env",
          apiKeyEnv,
          ...priceListArgs(await writePlanPrices(judged.root)),
          "--policy",
          await writePolicy(judged.root, 1),
          "--output",
          "json",
          "--repo",
          judged.repo,
        ],
        { env: planEnv(judged.root, "key-env-judge", gatewayKeys) },
      );
      const replayed = await codexRouteRun(
        "codex-key-env",
        "codex-login",
        "api",
      );
      const replayedResult = await runCli(
        replayed.args("init", [
          "--base-url",
          baseUrl,
          "--api-key-env",
          apiKeyEnv,
        ]),
        { env: await codexEnv(replayed.root, "codex-key-env", gatewayKeys) },
      );

      expect(judgedResult.code, judgedResult.stderr).toBe(0);
      expect(replayedResult.code, replayedResult.stderr).toBe(0);
      const judgeRecords = await stubRecords(judged.root, "key-env-judge");
      expect(modelCalls(judgeRecords).length).toBeGreaterThan(0);
      expect(
        (await codexExecs(replayed.root, "codex-key-env")).length,
      ).toBeGreaterThan(0);
      expect(
        [
          ...judgeRecords,
          ...(await stubRecords(replayed.root, "codex-key-env")),
        ]
          .filter(({ event }) => event === "start")
          .flatMap(({ argv, envNames }) =>
            envNames!
              .filter((name) => keyNames.includes(name))
              .map((name) => `${name} reached ${argv!.slice(0, 2).join(" ")}`),
          )
          .filter((line, index, lines) => lines.indexOf(line) === index),
      ).toEqual([]);
    } finally {
      await stub.close();
    }
  }, 180_000);
});
