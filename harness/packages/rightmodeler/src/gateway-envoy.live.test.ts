import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const gate = liveGatewayGate("envoy");
const namePrefix = "rm-gw-accept-envoy";
const kit = fileURLToPath(
  new URL("../../../fixtures/gateway-acceptance/envoy/", import.meta.url),
);
const headerAttributes =
  "agent-session-id:session.id,x-rightmodeler-family:rightmodeler.family,x-rightmodeler-replay:rightmodeler.replay";
const replayTag = ["--header", "x-rightmodeler-replay: 1"];
const execFileAsync = promisify(execFile);

async function docker(args: readonly string[]): Promise<string> {
  return (await execFileAsync("docker", args)).stdout.trim();
}

describe.skipIf(!gate.run)(
  `Envoy AI Gateway v1.1.0 live (${gate.reason})`,
  () => {
    let root: string;
    let models: LiveModels;
    let network: string | undefined;
    let collector: LiveContainer | undefined;
    let gateway: LiveContainer | undefined;
    let fallbackGateway: LiveContainer | undefined;
    let mock: Server | undefined;
    let production: string;
    let policy: string;

    const startCollector = () =>
      startPinnedContainer({
        image: "otel/opentelemetry-collector-contrib:0.161.0",
        digest:
          "sha256:fd328de2552466ad78385e1b1289c3f2402b1c45f265b252aab1955b42845ac1",
        namePrefix: `${namePrefix}-otel`,
        containerPort: 4318,
        runArgs: [
          "--network",
          network!,
          "--network-alias",
          "rm-otel",
          "--user",
          "0:0",
          "-v",
          "/out",
        ],
        files: [
          {
            from: join(kit, "collector.yaml"),
            to: "/etc/otelcol-contrib/config.yaml",
          },
        ],
        readyUrl: (port) => `http://127.0.0.1:${port}/`,
      });

    const startGateway = async (
      name: string,
      config: Record<string, unknown>,
      runArgs: readonly string[] = [],
    ) => {
      const { aigwConfig } = (await import(
        pathToFileURL(join(kit, "aigw-config.mjs")).href
      )) as { aigwConfig(options: Record<string, unknown>): string };
      const file = join(root, `${name}.yaml`);
      await writeFile(file, aigwConfig(config));
      return startPinnedContainer({
        image: "envoyproxy/ai-gateway-cli:v1.1.0",
        digest:
          "sha256:df69760bb46b6dcb8e9c6cc3cbf040d02e1b970dab05568c478fdcc418d144b6",
        namePrefix: `${namePrefix}-gw`,
        containerPort: 1975,
        runArgs: [
          "--network",
          network!,
          "-e",
          "AI_GATEWAY_API_KEY",
          "-e",
          "OTEL_EXPORTER_OTLP_ENDPOINT=http://rm-otel:4318",
          "-e",
          "OTEL_BSP_SCHEDULE_DELAY=200",
          "-e",
          `OTEL_AIGW_SPAN_REQUEST_HEADER_ATTRIBUTES=${headerAttributes}`,
          ...runArgs,
        ],
        files: [{ from: file, to: "/config.yaml" }],
        commandArgs: ["run", "/config.yaml"],
        readyUrl: (port) => `http://127.0.0.1:${port}/v1/models`,
      });
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
      "AIGW_CLIENT_KEY",
      "--catalog-reference",
      "https://ai-gateway.vercel.sh/v1/models",
      ...replayTag,
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

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "rightmodeler-envoy-live-"));
      models = await discoverLiveModels();
      network = `${namePrefix}-${randomBytes(4).toString("hex")}`;
      await docker(["network", "create", network]);
      collector = await startCollector();
      gateway = await startGateway("aigw", {
        models: [...models.incumbents, ...models.candidates, ...models.judges],
      });
      production = join(root, "production.jsonl");
      expect(
        await runCapture([
          "--base-url",
          `http://127.0.0.1:${gateway.port}/v1`,
          "--api-key-env",
          "AI_GATEWAY_API_KEY",
          "--models",
          models.incumbents.join(","),
          "--count",
          "64",
          "--family",
          "summarize",
          "--family-header",
          "x-rightmodeler-family",
          "--session-header",
          "agent-session-id",
          "--session-size",
          "2",
        ]),
      ).toEqual({ sent: 64, failed: 0 });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await collector.copyOut("/out/spans.jsonl", production);
      await collector.stop();
      collector = await startCollector();
      policy = join(root, "policy.json");
      await writeFile(policy, JSON.stringify({ shortlistTop: 1 }));
    }, 240_000);

    afterAll(async () => {
      try {
        await new Promise<void>((resolve) =>
          mock === undefined ? resolve() : mock.close(() => resolve()),
        );
        for (const container of [fallbackGateway, gateway, collector]) {
          await container?.stop();
        }
        await removeLeftoverContainers(namePrefix);
        if (network !== undefined) {
          await docker(["network", "rm", network]).catch((error: unknown) => {
            if (
              !String((error as { stderr?: unknown }).stderr).includes(
                "not found",
              )
            ) {
              throw error;
            }
          });
        }
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
        expect(
          await docker([
            "network",
            "ls",
            "--filter",
            `name=${namePrefix}`,
            "--format",
            "{{.Name}}",
          ]),
        ).toBe("");
        await assertNoSecretIn(root, [
          "AI_GATEWAY_API_KEY",
          "OPENROUTER_API_KEY",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);

    it("reads Envoy's spans as one ordered run per session with the requested models", async () => {
      const repo = await makeAcceptanceRepo(
        join(root, "ingest"),
        models.incumbents,
      );
      const store = join(root, "ingest-store");
      const result = await runBuiltCli([
        "init",
        "--through",
        "ingest",
        "--traces",
        production,
        "--output",
        "json",
        "--repo",
        repo,
        "--store",
        store,
      ]);
      expect(result.code, result.stderr).toBe(0);
      const ingest = await ingestArtifact(store);
      console.info(
        `[envoy live] ingest leg: ${JSON.stringify({
          format: ingest.format,
          runs: ingest.runs.length,
          steps: ingest.runs.map(({ steps }) => steps.length),
        })}`,
      );
      expect(ingest.format).toBe("openinference");
      expect(ingest.runs).toHaveLength(32);
      for (const { steps } of ingest.runs) {
        expect(steps).toHaveLength(2);
        for (const step of steps) {
          expect(models.incumbents).toContain(step.model);
          expect(step.family).toBe("summarize");
        }
      }
    }, 900_000);

    it("replays and judges through Envoy inside a $0.25 cap with every response verified", async () => {
      const [cheaper, dearer] = models.incumbents;
      const repo = await makeAcceptanceRepo(
        join(root, "positive"),
        models.incumbents,
      );
      const store = join(root, "positive-store");
      const result = await runBuiltCli(
        pipeline(gateway!, repo, store, policy, "0.25"),
        { AIGW_CLIENT_KEY: "unused" },
      );
      const { ledger, spend } = await recordLeg("envoy", "positive", {
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
      expect((await ingestArtifact(store)).format).toBe("openinference");
      expect(codes).not.toContain("catalog_pricing_unavailable");
      expect(codes).not.toContain("catalog_reference_unmatched");
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

      const replayRun = join(root, "replay-run");
      await mkdir(replayRun);
      await collector!.copyOut(
        "/out/spans.jsonl",
        join(replayRun, "spans.jsonl"),
      );
      const traces = join(root, "reingest-traces");
      await mkdir(traces);
      await copyFile(production, join(traces, "a-production.jsonl"));
      await copyFile(
        join(replayRun, "spans.jsonl"),
        join(traces, "b-replay-run.jsonl"),
      );
      const reingestRepo = await makeAcceptanceRepo(
        join(root, "reingest"),
        models.incumbents,
      );
      const reingestStore = join(root, "reingest-store");
      const reingest = await runBuiltCli([
        "init",
        "--through",
        "ingest",
        "--traces",
        traces,
        "--output",
        "json",
        "--repo",
        reingestRepo,
        "--store",
        reingestStore,
      ]);
      const sentExecutions = new Set(
        ledger.requestAttempts.map(({ executionId }) => executionId),
      ).size;
      const warnings = protocolLines(reingest.stderr).filter(
        ({ code }) => code === "trace_steps_excluded",
      );
      const ingested = (await ingestArtifact(reingestStore)).runs.flatMap(
        ({ steps }) => steps,
      ).length;
      console.info(
        `[envoy live] re-ingest: ${JSON.stringify({
          exitCode: reingest.code,
          warnings: warnings.map(({ message }) => message),
          ingested,
          sentExecutions,
        })}`,
      );
      expect(reingest.code, reingest.stderr).toBe(0);
      expect(ingested).toBe(64);
      expect(warnings).toHaveLength(1);
      const replayTraffic = Number(
        /(\d+) replay_traffic/.exec(warnings[0]!.message!)?.[1],
      );
      expect(replayTraffic).toBeGreaterThanOrEqual(sentExecutions);
    }, 900_000);

    it("leaves a candidate answered through Envoy's priority fallback out of the evidence", async () => {
      const [cheaper, dearer] = models.incumbents;
      const candidate = models.candidates[0]!;
      let mockHits = 0;
      mock = createServer((request, response) => {
        mockHits += 1;
        request.resume();
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":{"message":"mock failure"}}');
      });
      await new Promise<void>((resolve) =>
        mock!.listen(0, "0.0.0.0", () => resolve()),
      );
      fallbackGateway = await startGateway(
        "aigw-fallback",
        {
          models: [...models.incumbents, ...models.judges],
          fallbacks: [{ id: candidate, overrideModel: dearer }],
          mockPort: (mock.address() as { port: number }).port,
        },
        ["--add-host=host.docker.internal:host-gateway"],
      );
      const fallbackPolicy = join(root, "fallback-policy.json");
      await writeFile(
        fallbackPolicy,
        JSON.stringify({ shortlistTop: 1, allowModels: [candidate] }),
      );
      const repo = await makeAcceptanceRepo(
        join(root, "fallback"),
        models.incumbents,
      );
      const store = join(root, "fallback-store");
      const result = await runBuiltCli(
        pipeline(fallbackGateway, repo, store, fallbackPolicy, "0.10"),
        { AIGW_CLIENT_KEY: "unused" },
      );
      const { ledger, spend } = await recordLeg("envoy", "fallback", {
        models,
        repo,
        store,
        result,
        extra: { mockHits },
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
          candidateId: candidate,
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
          expect(substitution?.evidence).toContain(dearer);
        }
      }
      expect(mockHits).toBeGreaterThan(0);
      expect(spend).toBeDefined();
      expect(spend!.totalCostUsd).toBeLessThanOrEqual(0.1);
    }, 900_000);
  },
);
