import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FsStore, setupStateKey } from "@rightmodeler/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertNoSecretIn,
  discoverLiveModels,
  ledgerOf,
  liveGatewayGate,
  makeAcceptanceRepo,
  removeLeftoverContainers,
  runBuiltCli,
  runCapture,
  startPinnedContainer,
  type LiveContainer,
  type LiveModels,
} from "./test-utils/gateway-live.js";

const gate = liveGatewayGate("portkey");
const namePrefix = "rm-gw-accept-portkey";
const route = [
  "--header",
  "x-portkey-provider: openai",
  "--header",
  "x-portkey-custom-host: https://ai-gateway.vercel.sh/v1",
];

interface ProtocolLine {
  readonly code?: string;
  readonly message?: string;
}

function protocolLines(stderr: string): ProtocolLine[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as ProtocolLine);
}

async function ingestFormat(storeRoot: string): Promise<unknown> {
  const store = new FsStore(storeRoot);
  const text = async (key: string) =>
    Buffer.from((await store.get(key))!.body).toString("utf8");
  const state = JSON.parse(await text(setupStateKey("project"))) as {
    stages: Record<string, { outputKey: string }>;
  };
  return (
    JSON.parse(await text(state.stages.ingest!.outputKey)) as {
      format: unknown;
    }
  ).format;
}

describe.skipIf(!gate.run)(`Portkey 1.15.2 live (${gate.reason})`, () => {
  let root: string;
  let models: LiveModels;
  let container: LiveContainer | undefined;
  let traces: string;
  let policy: string;

  const pipeline = (repo: string, store: string, cap: string) => [
    "init",
    "--through",
    "aggregate",
    "--traces",
    traces,
    "--base-url",
    `http://127.0.0.1:${container!.port}/v1`,
    "--api-key-env",
    "AI_GATEWAY_API_KEY",
    ...route,
    "--policy",
    policy,
    "--max-cost-usd",
    cap,
    "--output",
    "json",
    "--repo",
    repo,
    "--store",
    store,
  ];

  const record = async (
    leg: string,
    repo: string,
    store: string,
    result: { readonly code: number; readonly stderr: string },
  ) => {
    const ledger = await ledgerOf(store);
    const status = await runBuiltCli([
      "status",
      "--output",
      "json",
      "--repo",
      repo,
      "--store",
      store,
    ]);
    const spend =
      status.code === 0
        ? (
            JSON.parse(status.stdout) as {
              spend: {
                totalCostUsd: number;
                byActor: Record<string, { events: number; costUsd: number }>;
              };
            }
          ).spend
        : undefined;
    console.info(
      `[portkey live] ${leg} leg: ${JSON.stringify({
        models,
        exitCode: result.code,
        stderr: protocolLines(result.stderr).map(
          ({ code, message }) => `${code}: ${message}`,
        ),
        candidates: [
          ...new Set(ledger.executions.map(({ candidateId }) => candidateId)),
        ],
        judgesTried: [
          ...new Set(
            ledger.spendEvents
              .filter(({ actor }) => actor === "judge")
              .map(
                ({ reconcilableTo }) =>
                  (reconcilableTo as { judgeModel?: unknown }).judgeModel,
              ),
          ),
        ],
        judges: [
          ...new Set(ledger.assessments.map(({ evaluatorId }) => evaluatorId)),
        ],
        executions: ledger.executions.length,
        requestAttempts: ledger.requestAttempts.length,
        assessments: ledger.assessments.length,
        spend: spend ?? status.stderr,
      })}`,
    );
    return { ledger, spend };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rightmodeler-portkey-live-"));
    models = await discoverLiveModels();
    container = await startPinnedContainer({
      image: "portkeyai/gateway:1.15.2",
      digest:
        "sha256:97f094d9c8a764cbfaa2a7138c0017b247ca923bb06db1b4c13b7f8a33b5200d",
      namePrefix,
      containerPort: 8787,
      readyUrl: (port) => `http://127.0.0.1:${port}/`,
    });
    traces = join(root, "traces.jsonl");
    expect(
      await runCapture([
        "--base-url",
        `http://127.0.0.1:${container.port}/v1`,
        "--api-key-env",
        "AI_GATEWAY_API_KEY",
        "--models",
        models.incumbents.join(","),
        "--count",
        "64",
        "--family",
        "summarize",
        ...route,
        "--out",
        traces,
      ]),
    ).toEqual({ sent: 64, failed: 0 });
    policy = join(root, "policy.json");
    await writeFile(policy, JSON.stringify({ shortlistTop: 1 }));
  }, 240_000);

  afterAll(async () => {
    try {
      await container?.stop();
      await removeLeftoverContainers(namePrefix);
      const { stdout } = await promisify(execFile)("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${namePrefix}`,
        "--format",
        "{{.Names}}",
      ]);
      expect(stdout.trim()).toBe("");
      await assertNoSecretIn(root, [
        "AI_GATEWAY_API_KEY",
        "OPENROUTER_API_KEY",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays and judges through Portkey inside a $0.25 cap with every response verified", async () => {
    const [cheaper, dearer] = models.incumbents;
    const repo = await makeAcceptanceRepo(
      join(root, "positive"),
      models.incumbents,
    );
    const store = join(root, "positive-store");
    const result = await runBuiltCli(pipeline(repo, store, "0.25"));
    const { ledger, spend } = await record("positive", repo, store, result);
    const codes = protocolLines(result.stderr).map(({ code }) => code);
    expect(
      result.code === 0 ||
        (result.code === 3 && codes.includes("budget_cap_refusal")),
      result.stderr,
    ).toBe(true);
    expect(await ingestFormat(store)).toBe("openai-jsonl");
    expect(codes).not.toContain("catalog_pricing_unavailable");
    expect(codes).not.toContain("replay_responses_substituted");

    const candidates = ledger.executions.filter(
      ({ candidateId }) => candidateId !== cheaper && candidateId !== dearer,
    );
    expect(candidates.length).toBeGreaterThan(0);
    const completed = ledger.requestAttempts.filter(
      ({ streamOutcome }) => streamOutcome === "completed",
    );
    expect(completed.length).toBeGreaterThan(0);
    for (const attempt of completed) {
      expect(attempt.servedModel).toEqual(expect.any(String));
      expect(attempt.substitution).toBeUndefined();
      expect(attempt.costIsEstimate).toBe(false);
    }
    expect(ledger.assessments.length).toBeGreaterThan(0);
    expect(spend).toBeDefined();
    expect(spend!.totalCostUsd).toBeLessThanOrEqual(0.25);
  }, 900_000);

  it("leaves every candidate answer forced to another model by a Portkey config out of the evidence", async () => {
    const [cheaper, dearer] = models.incumbents;
    const repo = await makeAcceptanceRepo(
      join(root, "negative"),
      models.incumbents,
    );
    const store = join(root, "negative-store");
    const result = await runBuiltCli([
      ...pipeline(repo, store, "0.10"),
      "--header",
      `x-portkey-config: ${JSON.stringify({
        override_params: { model: dearer },
        request_timeout: 120000,
      })}`,
    ]);
    const { ledger, spend } = await record("negative", repo, store, result);
    expect(result.code, result.stderr).toBe(0);
    expect(
      protocolLines(result.stderr).filter(
        ({ code }) => code === "replay_responses_substituted",
      ),
    ).toHaveLength(1);

    const substituted = ledger.executions.filter(
      ({ candidateId }) => candidateId !== cheaper && candidateId !== dearer,
    );
    expect(substituted.length).toBeGreaterThan(0);
    for (const execution of substituted) {
      expect(execution).toMatchObject({
        attribution: "substituted",
        terminalOutcome: "abstain",
      });
      const attempts = ledger.requestAttempts.filter(
        ({ executionId, streamOutcome }) =>
          executionId === execution.executionId &&
          streamOutcome === "completed",
      );
      expect(attempts.length).toBeGreaterThan(0);
      for (const { substitution } of attempts) {
        expect(substitution?.kind).toBe("model");
        expect(substitution?.evidence).toContain(dearer);
      }
    }
    const verdicts = (
      JSON.parse(result.stdout) as {
        verdicts: Array<{
          familyId: string;
          assessmentAbsentReasons: Array<{ reason: string }>;
        }>;
      }
    ).verdicts;
    expect(
      verdicts
        .filter(({ familyId }) => familyId === "summarize")
        .flatMap(({ assessmentAbsentReasons }) =>
          assessmentAbsentReasons.map(({ reason }) => reason),
        ),
    ).toContain("attribution_substituted");
    const substitutedIds = new Set(
      substituted.map(({ executionId }) => executionId),
    );
    expect(
      ledger.assessments.some(({ executionId }) =>
        substitutedIds.has(executionId),
      ),
    ).toBe(false);
    expect(spend).toBeDefined();
    expect(spend!.totalCostUsd).toBeLessThanOrEqual(0.1);
  }, 900_000);
});
