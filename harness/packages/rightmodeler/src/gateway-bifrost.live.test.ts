import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertNoSecretIn,
  discoverLiveModels,
  ingestArtifact,
  liveGatewayGate,
  makeAcceptanceRepo,
  protocolLines,
  recordLeg,
  removeLeftoverContainers,
  runBuiltCli,
  runCapture,
  startPinnedContainer,
  type LiveContainer,
  type LiveModels,
} from "./test-utils/gateway-live.js";

const gate = liveGatewayGate("bifrost");
const namePrefix = "rm-gw-accept-bifrost";
const kit = fileURLToPath(
  new URL("../../../fixtures/gateway-acceptance/bifrost/", import.meta.url),
);
const replayTags = [
  "--header",
  "x-bf-cache-no-store: true",
  "--header",
  "x-bf-dim-rightmodeler: replay",
];
const clientEnv = { BIFROST_KEY: "unused" };
const execFileAsync = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  return (await execFileAsync("docker", args)).stdout.trim();
}

describe.skipIf(!gate.run)(
  `Bifrost transports/v2.2.1 live (${gate.reason})`,
  () => {
    let root: string;
    let models: LiveModels;
    let incumbents: readonly [string, string];
    let gateway: LiveContainer | undefined;
    let aliasGateway: LiveContainer | undefined;
    const volumes: string[] = [];
    let production: string;
    let policy: string;

    const startBifrost = async (config: string) => {
      const container = await startPinnedContainer({
        image: "maximhq/bifrost:v2.2.1",
        digest:
          "sha256:a8942692af7b4b89196cd8fc33653b7353488dfd58b24078fe793b8574a8084b",
        namePrefix,
        containerPort: 8080,
        runArgs: ["-e", "AI_GATEWAY_API_KEY", "-v", "/app/data"],
        files: [{ from: config, to: "/app/data/config.json" }],
        readyUrl: (port) => `http://127.0.0.1:${port}/v1/models`,
      });
      volumes.push(
        await docker([
          "inspect",
          "--format",
          "{{range .Mounts}}{{.Name}}{{end}}",
          container.name,
        ]),
      );
      return container;
    };

    const exportLogs = async (
      target: LiveContainer,
      minimum: number,
      out: string,
    ): Promise<number> => {
      const base = `http://127.0.0.1:${target.port}`;
      const deadline = Date.now() + 60_000;
      let previous = -1;
      for (;;) {
        const { logs } = (await (
          await fetch(
            `${base}/api/logs?objects=chat_completion,chat_completion_stream&limit=1000&offset=0`,
          )
        ).json()) as { logs: Array<{ status: string }> };
        if (
          logs.length >= minimum &&
          logs.length === previous &&
          logs.every(({ status }) => status !== "processing")
        ) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Bifrost logged ${logs.length} finished chat rows within 60 seconds, expected at least ${minimum}`,
          );
        }
        previous = logs.length;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const { stdout } = await execFileAsync(process.execPath, [
        join(kit, "export-logs.mjs"),
        base,
        out,
      ]);
      return (JSON.parse(stdout) as { exported: number }).exported;
    };

    const pipeline = (
      target: LiveContainer,
      repo: string,
      store: string,
      policyFile: string,
      cap: string,
    ) => [
      "init",
      "--through",
      "aggregate",
      "--traces",
      production,
      "--base-url",
      `http://127.0.0.1:${target.port}/v1`,
      "--api-key-env",
      "BIFROST_KEY",
      "--catalog-reference",
      "https://ai-gateway.vercel.sh/v1/models",
      ...replayTags,
      "--policy",
      policyFile,
      "--max-cost-usd",
      cap,
      "--output",
      "json",
      "--repo",
      repo,
      "--store",
      store,
    ];

    const ingest = async (name: string, traces: string) => {
      const repo = await makeAcceptanceRepo(join(root, name), incumbents);
      const store = join(root, `${name}-store`);
      const result = await runBuiltCli([
        "init",
        "--through",
        "ingest",
        "--traces",
        traces,
        "--output",
        "json",
        "--repo",
        repo,
        "--store",
        store,
      ]);
      expect(result.code, result.stderr).toBe(0);
      const artifact = await ingestArtifact(store);
      const warnings = protocolLines(result.stderr).filter(
        ({ code }) => code === "trace_steps_excluded",
      );
      console.info(
        `[bifrost live] ${name}: ${JSON.stringify({
          format: artifact.format,
          runs: artifact.runs.length,
          steps: artifact.runs.map(({ steps }) => steps.length),
          warnings: warnings.map(({ message }) => message),
        })}`,
      );
      return { artifact, warnings };
    };

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "rightmodeler-bifrost-live-"));
      models = await discoverLiveModels();
      incumbents = [
        `vercel/${models.incumbents[0]}`,
        `vercel/${models.incumbents[1]}`,
      ];
      gateway = await startBifrost(join(kit, "config.json"));
      const baseUrl = `http://127.0.0.1:${gateway.port}/v1`;
      const family = [
        "--family",
        "summarize",
        "--family-header",
        "x-bf-dim-rightmodeler-family",
      ];
      expect(
        await runCapture(
          [
            "--base-url",
            baseUrl,
            "--api-key-env",
            "BIFROST_KEY",
            "--models",
            incumbents.join(","),
            "--count",
            "64",
            ...family,
            "--session-header",
            "x-bf-session-id",
            "--session-size",
            "2",
          ],
          clientEnv,
        ),
      ).toEqual({ sent: 64, failed: 0 });
      await runCapture(
        [
          "--base-url",
          baseUrl,
          "--api-key-env",
          "BIFROST_KEY",
          "--models",
          "vercel/rm-missing-model",
          "--count",
          "1",
          ...family,
          "--extra-body",
          JSON.stringify({ fallbacks: [incumbents[0]] }),
          "--allow-failure",
        ],
        clientEnv,
      );
      production = join(root, "production.jsonl");
      expect(await exportLogs(gateway, 66, production)).toBe(66);
      policy = join(root, "policy.json");
      await writeFile(policy, JSON.stringify({ shortlistTop: 1 }));
    }, 240_000);

    afterAll(async () => {
      try {
        for (const container of [aliasGateway, gateway]) {
          await container?.stop();
        }
        await removeLeftoverContainers(namePrefix);
        expect(
          await docker([
            "ps",
            "-a",
            "--filter",
            `name=${namePrefix}`,
            "--format",
            "{{.Names}}",
          ]),
        ).toBe("");
        const remaining = (
          await docker(["volume", "ls", "--format", "{{.Name}}"])
        ).split("\n");
        expect(volumes.filter((volume) => remaining.includes(volume))).toEqual(
          [],
        );
        await assertNoSecretIn(root, [
          "AI_GATEWAY_API_KEY",
          "OPENROUTER_API_KEY",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);

    it("reads Bifrost's log export as one ordered run per session", async () => {
      const { artifact, warnings } = await ingest("ingest", production);

      expect(artifact.format).toBe("bifrost");
      expect(artifact.runs).toHaveLength(32);
      for (const { steps } of artifact.runs) {
        expect(steps).toHaveLength(2);
        for (const step of steps) {
          expect(incumbents).toContain(step.model);
          expect(step.family).toBe("summarize");
        }
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain("1 call_failed");
      expect(warnings[0]!.message).toContain("1 fallback_answer");
    }, 900_000);

    it("replays and judges through Bifrost inside a $0.25 cap with the billed cost from the upstream", async () => {
      const [cheaper, dearer] = incumbents;
      const repo = await makeAcceptanceRepo(join(root, "positive"), incumbents);
      const store = join(root, "positive-store");
      const result = await runBuiltCli(
        pipeline(gateway!, repo, store, policy, "0.25"),
        clientEnv,
      );
      const { ledger, spend } = await recordLeg("bifrost", "positive", {
        models,
        repo,
        store,
        result,
      });
      const codes = protocolLines(result.stderr).map(({ code }) => code);
      expect(
        result.code === 0 ||
          (result.code === 3 && codes.includes("budget_cap_refusal")),
        result.stderr,
      ).toBe(true);
      expect((await ingestArtifact(store)).format).toBe("bifrost");
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

      const reexport = join(root, "reexport.jsonl");
      const exported = await exportLogs(
        gateway!,
        66 + completed.length,
        reexport,
      );
      const { artifact, warnings } = await ingest("reingest", reexport);
      const sentExecutions = new Set(
        ledger.requestAttempts.map(({ executionId }) => executionId),
      ).size;
      console.info(
        `[bifrost live] re-export: ${JSON.stringify({ exported, sentExecutions })}`,
      );
      expect(artifact.runs.flatMap(({ steps }) => steps)).toHaveLength(64);
      expect(warnings).toHaveLength(1);
      const replayTraffic = Number(
        /(\d+) replay_traffic/.exec(warnings[0]!.message!)?.[1],
      );
      expect(replayTraffic).toBeGreaterThanOrEqual(sentExecutions);
    }, 900_000);

    it("leaves a candidate answered through a Bifrost key alias out of the evidence", async () => {
      const [cheaper, dearer] = incumbents;
      const candidate = models.candidates[0]!;
      const config = JSON.parse(
        await readFile(join(kit, "config.json"), "utf8"),
      ) as {
        providers: {
          vercel: { keys: Array<{ aliases?: Record<string, string> }> };
        };
      };
      config.providers.vercel.keys[0]!.aliases = {
        [candidate]: models.incumbents[1],
      };
      const aliasConfig = join(root, "config-alias.json");
      await writeFile(aliasConfig, JSON.stringify(config));
      aliasGateway = await startBifrost(aliasConfig);
      const aliasPolicy = join(root, "alias-policy.json");
      await writeFile(
        aliasPolicy,
        JSON.stringify({
          shortlistTop: 1,
          allowModels: [`vercel/${candidate}`],
        }),
      );
      const repo = await makeAcceptanceRepo(join(root, "alias"), incumbents);
      const store = join(root, "alias-store");
      const result = await runBuiltCli(
        pipeline(aliasGateway, repo, store, aliasPolicy, "0.10"),
        clientEnv,
      );
      const { ledger, spend } = await recordLeg("bifrost", "alias", {
        models,
        repo,
        store,
        result,
      });
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
          candidateId: `vercel/${candidate}`,
          attribution: "substituted",
        });
        const attempts = ledger.requestAttempts.filter(
          ({ executionId, streamOutcome }) =>
            executionId === execution.executionId &&
            streamOutcome === "completed",
        );
        expect(attempts.length).toBeGreaterThan(0);
        for (const { substitution } of attempts) {
          expect(substitution?.kind).toBe("model");
          expect(substitution?.evidence).toContain(models.incumbents[1]);
        }
      }
      expect(spend).toBeDefined();
      expect(spend!.totalCostUsd).toBeLessThanOrEqual(0.1);
    }, 900_000);
  },
);
