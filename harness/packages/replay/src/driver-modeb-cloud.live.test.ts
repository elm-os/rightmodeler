import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  factSchema,
  factsPrefix,
  FsStore,
  requestAttemptSchema,
} from "@rightmodeler/core";
import {
  createCloudExecutor,
  detectCloudAvailability,
} from "@rightmodeler/executor/cloud-sandbox";
import { afterAll, describe, expect, it } from "vitest";
import { createBudget } from "./budget.js";
import {
  replayModeB,
  type ModeBCase,
  type ModeBExecutor,
} from "./driver-modeb.js";
import { createProvider } from "./provider.js";
import type { ReplayStep } from "./shortlist.js";

const liveRequested = process.env.RIGHTMODELER_LIVE_CLOUD === "1";
const availability = liveRequested
  ? await detectCloudAvailability()
  : ({
      available: false,
      reason: "not-requested",
      message: "set RIGHTMODELER_LIVE_CLOUD=1 to run live cloud tests",
    } as const);
const liveReason = !availability.available
  ? `${availability.reason}: ${availability.message}`
  : process.env.AI_GATEWAY_API_KEY
    ? "available"
    : "gateway-key-unavailable: set AI_GATEWAY_API_KEY";
if (liveReason !== "available") {
  console.warn(`[cloud Mode B live] SKIPPED: ${liveReason}`);
}

const fixtureApp = fileURLToPath(
  new URL("../../../fixtures/cloud-smoke-app", import.meta.url),
);
const projectId = "modeb-cloud-live";
const runTagKey = "com.rightmodeler.run";
const temporaryDirectories: string[] = [];

interface SandboxLister {
  list(params: { tags: Record<string, string> }): Promise<{
    readonly sandboxes: ReadonlyArray<{ name: string; status: string }>;
  }>;
}

/**
 * The replay package does not depend on the sandbox SDK, so the cleanup check loads the
 * executor's own copy, the same package the cloud backend launches with.
 */
function sandboxLister(): SandboxLister {
  const executorRequire = createRequire(
    createRequire(import.meta.url).resolve(
      "@rightmodeler/executor/cloud-sandbox",
    ),
  );
  return (executorRequire("@vercel/sandbox") as { Sandbox: SandboxLister })
    .Sandbox;
}

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(liveReason !== "available")(
  `cloud Mode B live (${liveReason})`,
  () => {
    it("replays three cases in real sandboxes through the AI Gateway", async () => {
      const apiKey = process.env.AI_GATEWAY_API_KEY!;
      const catalog = await createProvider({
        providerId: "ai-gateway",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        apiKeyEnv: "AI_GATEWAY_API_KEY",
      }).listModels();
      const ranked = catalog
        .filter(
          (model) =>
            model.pricing !== null &&
            model.pricing.input > 0 &&
            model.pricing.output > 0 &&
            model.requiresReasoning !== true &&
            (model.outputModalities === undefined ||
              model.outputModalities.length === 0 ||
              model.outputModalities.includes("text")),
        )
        .sort(
          (left, right) =>
            left.pricing!.input +
            left.pricing!.output -
            (right.pricing!.input + right.pricing!.output),
        );
      const [candidate, incumbent] = ranked;
      expect(incumbent).toBeDefined();
      console.log(
        `[cloud Mode B live] candidate ${candidate!.id}, incumbent ${incumbent!.id}`,
      );

      const root = await mkdtemp(join(tmpdir(), "rightmodeler-modeb-live-"));
      temporaryDirectories.push(root);
      const app = join(root, "app");
      await cp(fixtureApp, app, { recursive: true });
      await mkdir(join(root, "store"));
      const store = new FsStore(join(root, "store"));
      const runId = randomUUID();
      const budget = createBudget({
        store,
        projectId,
        runId,
        authorizedTotalUsd: 0.25,
      });
      const stepRecords: ReplayStep[] = [
        {
          stepId: "smoke",
          evidenceQuestionId: "question-smoke",
          currentModel: incumbent!.id,
          needsTools: false,
          needsStructuredOutput: false,
          observedContextTokens: 64,
          corpusSplit: "holdout",
          selectionStage: "confirm",
        },
      ];
      const cases: ModeBCase[] = ["ok", "ok", "oversize"].map(
        (mode, index) => ({
          caseId: `smoke-${index + 1}`,
          stepId: "smoke",
          trajectoryId: `trace-smoke-${index + 1}`,
          corpusSplit: "holdout",
          task: "Reply with ok.",
          messages: [
            { role: "user", content: "Reply with the single word ok." },
          ],
          contextTokens: 64,
          maxOutputTokens: 16,
          referenceOutput: "ok",
          input: { mode, step: "smoke", model: incumbent!.id },
        }),
      );

      // Built exactly as the pipeline builds it for `"backend": "cloud"`.
      const executor = createCloudExecutor({
        maxBytesPerNamespace: 16 * 1024 * 1024,
        modelCredential: {
          host: "ai-gateway.vercel.sh",
          headerName: "authorization",
          value: `Bearer ${apiKey}`,
        },
      });
      const timings = new Map<
        string,
        { caseId: string; startedAt: number; launchMs: number }
      >();
      const timedExecutor: ModeBExecutor = {
        async launch(spec) {
          const startedAt = performance.now();
          const handle = await executor.launch(spec);
          timings.set(handle, {
            caseId: spec.labels["com.rightmodeler.case"] ?? "unknown",
            startedAt,
            launchMs: performance.now() - startedAt,
          });
          return handle;
        },
        status: (handle) => executor.status(handle),
        collect: (handle, request) => executor.collect(handle, request),
        async destroy(handle) {
          await executor.destroy(handle);
          const timing = timings.get(handle);
          if (timing !== undefined) {
            console.log(
              `[cloud Mode B live] case ${timing.caseId}: launch and upload ${Math.round(timing.launchMs)} ms, total ${Math.round(performance.now() - timing.startedAt)} ms`,
            );
          }
        },
      };

      const result = await replayModeB({
        stepRecords,
        cases,
        swapPolicy: { smoke: candidate!.id },
        executor: timedExecutor,
        backend: "cloud",
        egress: {
          providerId: "ai-gateway",
          providerBaseUrl: "https://ai-gateway.vercel.sh",
          apiKeyEnv: "AI_GATEWAY_API_KEY",
          catalog,
        },
        store,
        budget,
        image: "vercel/sandbox/node:24",
        appSpec: {
          mountPath: app,
          command: (caseFile) => [
            "node",
            "/rightmodeler/app/app.mjs",
            caseFile,
          ],
        },
        concurrency: 3,
      });

      const state = await budget.state();
      console.log(
        `[cloud Mode B live] spent $${state.spentUsd.toFixed(6)}; rejected rows ${result.rejectedRows}; blocked ${JSON.stringify(result.blocked)}`,
      );
      expect(result.blocked).toEqual([]);
      expect(result.executions).toHaveLength(3);
      for (const execution of result.executions) {
        expect(execution).toMatchObject({
          terminalOutcome: "success",
          attribution: "ok",
        });
      }
      const attempts = (
        await Promise.all(
          (await store.list(factsPrefix(projectId))).map(async (key) => {
            const entry = await store.get(key);
            return factSchema.parse(
              JSON.parse(Buffer.from(entry!.body).toString("utf8")),
            );
          }),
        )
      ).flatMap((fact) => {
        const parsed = requestAttemptSchema.safeParse(fact);
        return parsed.success ? [parsed.data] : [];
      });
      for (const execution of result.executions) {
        const own = attempts.filter(
          ({ executionId }) => executionId === execution.executionId,
        );
        expect(own).toHaveLength(1);
        expect(own[0]!.costUsd).toBeGreaterThan(0);
      }
      // Only the 17 MiB file is skipped, and skipping it does not fail its case.
      expect(result.rejectedRows).toBe(1);
      expect(state.spentUsd).toBeLessThanOrEqual(0.25);

      const Sandbox = sandboxLister();
      const deadline = Date.now() + 30_000;
      let active: string[];
      for (;;) {
        const listing = await Sandbox.list({ tags: { [runTagKey]: runId } });
        active = listing.sandboxes
          .filter(({ status }) => status === "pending" || status === "running")
          .map(({ name }) => name);
        if (active.length === 0 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(active).toEqual([]);
    }, 300_000);
  },
);
