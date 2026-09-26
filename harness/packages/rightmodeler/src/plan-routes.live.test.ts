import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { FsStore, readLedger } from "@rightmodeler/core";
import { pickJudges } from "@rightmodeler/kernel";
import {
  createClaudeLoginProvider,
  createCodexLoginProvider,
} from "@rightmodeler/replay";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeCli } from "./cli.js";
import { DEFAULT_PLAN_PRICE_LIST } from "./routes.js";
import {
  assertNoSecretIn,
  protocolLines,
  recordLeg,
  runBuiltCli,
} from "./test-utils/gateway-live.js";
import {
  DUMMY_KEYS,
  legFacts,
  livePlanGate,
  planCliEnv,
  planHygiene,
  planPolicy,
  preparePlanLeg,
  type PlanLeg,
} from "./test-utils/plan-live.js";
import { promptAnswers } from "./test-utils/prompt-answers.js";

const gate = livePlanGate();
const legs = {
  a: {
    name: "A",
    flags: ["--route", "codex-login", "--judge-route", "claude-login"],
    routes: { candidates: "codex-login", judge: "claude-login" },
    judgeVendor: "anthropic",
    cap: undefined,
  },
  b: {
    name: "B",
    flags: ["--route", "claude-login", "--judge-route", "codex-login"],
    routes: { candidates: "claude-login", judge: "codex-login" },
    judgeVendor: "openai",
    cap: undefined,
  },
  c: {
    name: "C",
    flags: [
      "--base-url",
      "https://ai-gateway.vercel.sh/v1",
      "--api-key-env",
      "AI_GATEWAY_API_KEY",
      "--judge-route",
      "claude-login",
    ],
    routes: { candidates: "configured-provider", judge: "claude-login" },
    judgeVendor: "anthropic",
    cap: 0.1,
  },
} as const;

function vendorOf(id: string): string {
  return id.split("/")[0]!;
}

function hasCodexGlobalInstructions(): boolean {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return (
    existsSync(join(home, "AGENTS.md")) ||
    existsSync(join(home, "AGENTS.override.md"))
  );
}

function spendSection(report: string): string {
  return report.slice(
    report.indexOf("\n## Spend\n"),
    report.indexOf("\n## Model routes\n"),
  );
}

function terminal(answers: readonly string[]) {
  const answering = promptAnswers(answers);
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (value: string) => {
        stdout += value;
        answering.observe(value);
      },
      stderr: (value: string) => {
        stderr += value;
      },
    },
    runtime: {
      stdin: Object.assign(answering.input, { isTTY: true }),
      stdout: Object.assign(
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        { isTTY: true },
      ),
      env: process.env,
      homeDir: homedir(),
      now: () => new Date(),
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe.skipIf(!gate.run)(`plan routes live (${gate.reason})`, () => {
  const policy = join(gate.dir, "policy.json");

  function legArgs(
    command: "init" | "estimate",
    leg: PlanLeg,
    prepared: { readonly repo: string; readonly traces: string },
    store: string,
  ): string[] {
    const { cap, flags } = legs[leg];
    return [
      command,
      ...(command === "init" ? ["--through", "aggregate"] : []),
      ...flags,
      "--traces",
      prepared.traces,
      "--policy",
      policy,
      ...(cap === undefined ? [] : ["--max-cost-usd", String(cap)]),
      "--output",
      "json",
      "--repo",
      prepared.repo,
      "--store",
      store,
    ];
  }

  async function runLeg(leg: PlanLeg) {
    const config = legs[leg];
    const prepared = await preparePlanLeg(gate.dir, leg);
    const store = join(gate.dir, leg, "store");
    const hygiene = await planHygiene();
    const result = await runBuiltCli(
      legArgs("init", leg, prepared, store),
      DUMMY_KEYS,
    );
    const ledger = await readLedger(new FsStore(store), "project");
    const facts = legFacts(ledger, result.stderr, config.routes);
    const totalUsd = ledger.spendEvents.reduce(
      (total, { costUsd }) => total + costUsd,
      0,
    );
    const checked = await hygiene.check();
    const { spend } = await recordLeg("plan-routes", config.name, {
      models: prepared.models,
      repo: prepared.repo,
      store,
      result,
      extra: {
        ...facts,
        overshootUsd:
          config.cap === undefined ? null : Math.max(0, totalUsd - config.cap),
        hygiene: checked,
      },
    });
    let report: string | undefined;
    if (result.code === 0) {
      const written = await runBuiltCli(
        [
          "report",
          "--output",
          "json",
          "--repo",
          prepared.repo,
          "--store",
          store,
        ],
        DUMMY_KEYS,
      );
      expect([0, 1], written.stderr).toContain(written.code);
      report = await readFile(
        (JSON.parse(written.stdout) as { reportPath: string }).reportPath,
        "utf8",
      );
    }
    const codes = protocolLines(result.stderr).map(({ code }) => code);
    expect(facts.violations).toEqual([]);
    expect(checked.violations).toEqual([]);
    expect(ledger.assessments.length).toBeGreaterThanOrEqual(2);
    expect(facts.providers).toEqual({
      candidate: [config.routes.candidates],
      judge: [config.routes.judge],
    });
    if (facts.judgeAttempts >= 20) {
      expect(facts.malformed / facts.judgeAttempts).toBeLessThanOrEqual(0.05);
    }
    const completed = ledger.requestAttempts.filter(
      ({ streamOutcome }) => streamOutcome === "completed",
    );
    expect(completed.length).toBeGreaterThan(0);
    return { result, ledger, facts, spend, codes, completed, report };
  }

  beforeAll(async () => {
    await writeFile(policy, JSON.stringify(planPolicy));
  });

  afterAll(async () => {
    await assertNoSecretIn(gate.dir, [
      "AI_GATEWAY_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });

  it("captures each leg's traces once and estimates every leg without a model call", async () => {
    const hygiene = await planHygiene();
    for (const leg of ["a", "b", "c"] as const) {
      const config = legs[leg];
      const prepared = await preparePlanLeg(gate.dir, leg);
      const store = join(gate.dir, leg, "estimate-store");
      await rm(store, { recursive: true, force: true });
      const result = await runBuiltCli(
        legArgs("estimate", leg, prepared, store),
        DUMMY_KEYS,
      );

      expect(result.code, result.stderr).toBe(0);
      const estimate = JSON.parse(result.stdout) as {
        candidateExecutions: number;
        judgeCalls: number;
        projectedCostUsd: number;
        basis: string;
        shortlist: Array<{ stepId: string; candidateIds: string[] }>;
      };
      expect(estimate.candidateExecutions).toBeGreaterThan(0);
      expect(estimate.judgeCalls).toBeGreaterThan(0);
      if (leg !== "c") expect(estimate.basis).toMatch(/list-price/iu);
      const candidateIds = estimate.shortlist.flatMap(
        ({ candidateIds }) => candidateIds,
      );
      expect(candidateIds.length).toBeGreaterThan(0);
      for (const id of candidateIds) {
        expect(vendorOf(id), id).not.toBe(config.judgeVendor);
        if (leg === "a") expect(vendorOf(id), id).toBe("openai");
        if (leg === "b") expect(vendorOf(id), id).toBe("anthropic");
      }
      for (const id of prepared.models.incumbents) {
        expect(vendorOf(id), id).not.toBe(config.judgeVendor);
      }
      const judgeRoute =
        config.routes.judge === "codex-login"
          ? createCodexLoginProvider
          : createClaudeLoginProvider;
      const judgeList = await judgeRoute({
        priceList: DEFAULT_PLAN_PRICE_LIST,
        env: planCliEnv(),
      }).listModels();
      const pairs = new Set(
        candidateIds.flatMap((candidate) =>
          prepared.models.incumbents.map((incumbent) =>
            JSON.stringify([vendorOf(candidate), vendorOf(incumbent)]),
          ),
        ),
      );
      const judges = [
        ...new Set(
          [...pairs].flatMap((pair) => {
            const [candidateFamily, referenceFamily] = JSON.parse(pair) as [
              string,
              string,
            ];
            return pickJudges(judgeList, {
              candidateFamily,
              referenceFamily,
            }).slice(0, 3);
          }),
        ),
      ];
      const ledger = await readLedger(new FsStore(store), "project");
      expect(ledger.spendEvents).toEqual([]);
      expect(ledger.requestAttempts).toEqual([]);
      expect(ledger.executions).toEqual([]);
      console.info(
        `[plan-routes live] rehearsal ${leg}: ${JSON.stringify({
          incumbents: prepared.models.incumbents,
          candidates: estimate.shortlist,
          judges: judges.map((id) => {
            const pricing = judgeList.find(
              (entry) => entry.id === id,
            )!.pricing!;
            return {
              id,
              inputPerMillionUsd: pricing.input * 1e6,
              outputPerMillionUsd: pricing.output * 1e6,
            };
          }),
          projectedCostUsd: estimate.projectedCostUsd,
          judgeCalls: estimate.judgeCalls,
          candidateExecutions: estimate.candidateExecutions,
        })}`,
      );
    }
    expect((await hygiene.check()).violations).toEqual([]);
  }, 600_000);

  it("replays codex candidates, judges them through claude, attributes spend to each route and labels the report", async () => {
    const leg = await runLeg("a");

    expect(leg.result.code, leg.result.stderr).toBe(0);
    expect(leg.codes).not.toContain("budget_cap_refusal");
    expect(leg.facts.withheld).toEqual(
      expect.arrayContaining(Object.keys(DUMMY_KEYS)),
    );
    expect(
      leg.codes.filter((code) => code === "codex_global_instructions"),
    ).toHaveLength(hasCodexGlobalInstructions() ? 1 : 0);
    for (const attempt of leg.completed) {
      expect(attempt.costIsEstimate).toBe(true);
      expect(attempt.servedModel).toBeUndefined();
    }
    expect(leg.facts.candidateInputTokens!.max).toBeLessThan(3_000);
    expect(leg.report).toContain("\n## Model routes\n");
    expect(leg.report).toMatch(/\n\| candidates \| codex-login \| \d+ \|/u);
    expect(leg.report).toMatch(/\n\| judge \| claude-login \| \d+ \|/u);
    expect(leg.report).toContain("Codex does not report which model answered");
    expect(spendSection(leg.report!)).toContain("list-price equivalent");
  }, 2_400_000);

  it("replays claude candidates and judges them through codex with every route's spend attributed", async () => {
    const leg = await runLeg("b");

    expect(leg.result.code, leg.result.stderr).toBe(0);
    expect(leg.codes).not.toContain("budget_cap_refusal");
    expect(leg.facts.withheld).toEqual(
      expect.arrayContaining(Object.keys(DUMMY_KEYS)),
    );
    expect(
      leg.codes.filter((code) => code === "codex_global_instructions"),
    ).toHaveLength(hasCodexGlobalInstructions() ? 1 : 0);
    for (const attempt of leg.completed) {
      expect(attempt.costIsEstimate).toBe(true);
      expect(attempt.servedModel).toEqual(expect.any(String));
    }
    expect(leg.facts.candidateInputTokens!.max).toBeLessThan(1_500);
    expect(leg.facts.usage.length).toBeLessThanOrEqual(1);
    if (leg.codes.includes("judge_unusable")) {
      for (const retired of leg.facts.retirements) {
        const failures = leg.facts.judgeFailures.filter(
          ({ judgeModel }) => judgeModel === retired.judgeModel,
        );
        if (
          failures.length > 0 &&
          failures.every(({ message }) =>
            /limit|capacity|demand/iu.test(message),
          )
        ) {
          expect(retired).toMatchObject({
            note: "rate_limited",
            runId: expect.any(String),
          });
        }
      }
    }
    expect(leg.report).toContain("\n## Model routes\n");
    expect(leg.report).toMatch(/\n\| candidates \| claude-login \| \d+ \|/u);
    expect(leg.report).toMatch(/\n\| judge \| codex-login \| \d+ \|/u);
    expect(spendSection(leg.report!)).toContain("list-price equivalent");
  }, 2_400_000);

  it("replays Vercel API candidates and judges them through claude, leaving Anthropic candidates out", async () => {
    const leg = await runLeg("c");

    expect(
      leg.result.code === 0 ||
        (leg.result.code === 3 && leg.codes.includes("budget_cap_refusal")),
      leg.result.stderr,
    ).toBe(true);
    expect(leg.facts.withheld).toContain("ANTHROPIC_API_KEY");
    expect(leg.facts.withheld).not.toContain("CODEX_API_KEY");
    expect(leg.facts.withheld).not.toContain("OPENAI_API_KEY");
    for (const attempt of leg.completed) {
      expect(attempt.costIsEstimate).toBe(false);
      expect(attempt.servedModel).toEqual(expect.any(String));
      expect(attempt.substitution).toBeUndefined();
    }
    const apiUsd = leg.ledger.spendEvents
      .filter(({ provider }) => provider === "configured-provider")
      .reduce((total, { costUsd }) => total + costUsd, 0);
    expect(apiUsd).toBeLessThanOrEqual(legs.c.cap + 1e-9);
    expect(leg.spend).toBeDefined();
    expect(leg.spend!.totalCostUsd).toBeLessThanOrEqual(
      legs.c.cap + 4 * leg.facts.largestCallUsd + 1e-9,
    );
    for (const { candidateId } of leg.ledger.executions) {
      expect(vendorOf(candidateId), candidateId).not.toBe("anthropic");
    }
    for (const line of protocolLines(leg.result.stderr)) {
      if (line.code !== "judge_vendor_candidates_dropped") continue;
      const ids = /^Candidates (.+?)(?: and \d+ more)? were left out:/u
        .exec(line.message ?? "")?.[1]
        ?.split(", ");
      expect(ids, line.message).toBeDefined();
      for (const id of ids!) expect(vendorOf(id), id).toBe("anthropic");
    }
    if (leg.result.code === 0) {
      expect(leg.report).toContain("\n## Model routes\n");
      expect(leg.report).toMatch(/\n\| candidates \| api \| \d+ \|/u);
      expect(leg.report).toMatch(/\n\| judge \| claude-login \| \d+ \|/u);
      expect(spendSection(leg.report!)).toMatch(
        /list-price equivalent, not billed\): \$\d+\.\d{8}\. Billed through the API route: \$\d+\.\d{8}\./u,
      );
    }
  }, 2_400_000);

  it("asks how to call models at the first run and estimates both answers without a model call", async () => {
    const hygiene = await planHygiene();
    for (const branch of [
      {
        leg: "a",
        store: "picker-plan-store",
        answers: ["1", "1", "1", "y"],
        flags: "--route codex-login --judge-route claude-login",
      },
      {
        leg: "c",
        store: "picker-api-store",
        answers: ["2", "2", ""],
        flags:
          "--base-url https://ai-gateway.vercel.sh/v1 --api-key-env AI_GATEWAY_API_KEY",
      },
    ] as const) {
      const prepared = await preparePlanLeg(gate.dir, branch.leg);
      const store = join(gate.dir, branch.store);
      await rm(store, { recursive: true, force: true });
      const run = terminal(branch.answers);

      const code = await executeCli(
        [
          "estimate",
          "--repo",
          prepared.repo,
          "--store",
          store,
          "--traces",
          prepared.traces,
        ],
        run.io,
        run.runtime,
      );

      expect(code, run.stderr()).toBe(0);
      if (branch.leg === "a") {
        for (const cli of ["codex", "claude"]) {
          expect(run.stdout()).toMatch(
            new RegExp(
              `^ {2}${cli} \\d+\\.\\d+\\.\\d+: signed in with your plan$`,
              "mu",
            ),
          );
        }
      }
      const printed = /Next time, skip these questions with:\n {2}(.+)\n/u.exec(
        run.stdout(),
      )?.[1];
      expect(printed).toBe(branch.flags);
      const estimated = await runBuiltCli(
        [
          "estimate",
          ...printed!.split(" "),
          "--traces",
          prepared.traces,
          "--output",
          "json",
          "--repo",
          prepared.repo,
          "--store",
          store,
        ],
        DUMMY_KEYS,
      );
      expect(estimated.code, estimated.stderr).toBe(0);
      expect(
        (JSON.parse(estimated.stdout) as { candidateExecutions: number })
          .candidateExecutions,
      ).toBeGreaterThan(0);
      expect(
        await new FsStore(store).get("project/setup/model-route.json"),
      ).not.toBeNull();
      await assertNoSecretIn(store, [
        "AI_GATEWAY_API_KEY",
        "OPENROUTER_API_KEY",
      ]);
      const ledger = await readLedger(new FsStore(store), "project");
      expect(ledger.spendEvents).toEqual([]);
      expect(ledger.requestAttempts).toEqual([]);
      expect(ledger.executions).toEqual([]);
    }
    expect((await hygiene.check()).violations).toEqual([]);
  }, 300_000);
});
