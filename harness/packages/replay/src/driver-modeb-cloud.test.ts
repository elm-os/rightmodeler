import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore } from "@rightmodeler/core";
import type { DockerLaunchSpec } from "@rightmodeler/executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBudget } from "./budget.js";
import {
  replayModeB,
  type ModeBCase,
  type ModeBExecutor,
  type ReplayModeBInput,
} from "./driver-modeb.js";
import type { ModelCatalogEntry } from "./provider.js";
import type { ReplayStep } from "./shortlist.js";

const dockerProbe = vi.hoisted(() =>
  vi.fn(async () => ({ available: true as const })),
);
vi.mock("@rightmodeler/executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rightmodeler/executor")>()),
  detectDockerAvailability: dockerProbe,
}));

const catalog: ModelCatalogEntry[] = [
  {
    id: "acme/small-1",
    family: "acme",
    contextLength: 128_000,
    pricing: { input: 0.0000002, output: 0.0000008 },
    supportsTools: true,
    supportsStructuredOutput: false,
  },
  {
    id: "acme/max-1",
    family: "acme",
    contextLength: 128_000,
    pricing: { input: 0.0000002, output: 0.0000008 },
    supportsTools: true,
    supportsStructuredOutput: false,
  },
  ...Array.from({ length: 300 }, (_, index): ModelCatalogEntry => ({
    id: `filler/model-${index}`,
    family: "filler",
    contextLength: 128_000,
    pricing: { input: 0.000001, output: 0.000002 },
    supportsTools: true,
    supportsStructuredOutput: false,
  })),
];

const stepRecords: ReplayStep[] = [
  {
    stepId: "lookup",
    evidenceQuestionId: "question-lookup",
    currentModel: "acme/max-1",
    needsTools: false,
    needsStructuredOutput: false,
    observedContextTokens: 64,
    corpusSplit: "holdout",
    selectionStage: "confirm",
  },
];

const cases: ModeBCase[] = [
  {
    caseId: "case-1",
    stepId: "lookup",
    trajectoryId: "trace-1",
    corpusSplit: "holdout",
    task: "Answer.",
    messages: [{ role: "user", content: "hello" }],
    contextTokens: 64,
    maxOutputTokens: 64,
    referenceOutput: "hi",
    input: "hello",
  },
];

describe("cloud Mode B launch contract", () => {
  const launches: DockerLaunchSpec[] = [];
  let root: string;
  let result: Awaited<ReturnType<typeof replayModeB>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rightmodeler-modeb-cloud-"));
    const storeRoot = join(root, "store");
    await mkdir(storeRoot);
    const store = new FsStore(storeRoot);
    const executor: ModeBExecutor = {
      async launch(spec: DockerLaunchSpec) {
        launches.push(spec);
        throw new Error("cloud launch refused");
      },
      async status() {
        throw new Error("status should not be called");
      },
      async collect() {
        throw new Error("collect should not be called");
      },
      async destroy() {
        throw new Error("destroy should not be called");
      },
    };
    const input: ReplayModeBInput = {
      stepRecords,
      cases,
      swapPolicy: { lookup: "acme/small-1" },
      executor,
      egress: {
        providerId: "stub",
        providerBaseUrl: "https://provider.example",
        apiKeyEnv: "REPLAY_MODEB_CLOUD_TEST_API_KEY",
        catalog,
      },
      store,
      budget: createBudget({
        store,
        projectId: "modeb-cloud-test",
        runId: randomUUID(),
        authorizedTotalUsd: 1,
      }),
      image: "vercel/sandbox/universal:latest",
      appSpec: {
        mountPath: join(root, "app"),
        command: (caseFile) => ["node", "app.mjs", caseFile],
        timeoutMs: 5_000,
      },
      concurrency: 1,
    };

    result = await replayModeB({ ...input, backend: "cloud" });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sends the cloud backend straight at the provider with no host port", () => {
    expect(result.blocked).toEqual([
      expect.objectContaining({ reason: "launch-failed" }),
    ]);
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.env.RM_EGRESS_URL).toBe("https://provider.example");
    expect(launch.hostPorts).toBeUndefined();
    expect(launch.env.RM_RUN_ID).toMatch(/.+/);
    expect(launch.env.RM_CASE_ID).toMatch(/.+/);
    expect(launch.env.RM_EXECUTION_ID).toMatch(/.+/);
  });

  it("keeps the in-container metering proxy in the path and never probes Docker", () => {
    const launch = launches[0]!;
    expect(launch.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8787/v1");
    expect(launch.env.RM_PROXY_HOST).toBe("127.0.0.1");
    expect(launch.env.RM_PROXY_PORT).toBe("8787");
    expect(JSON.parse(launch.env.RM_BUDGET_LEASE)).toMatchObject({
      maxUsd: expect.any(Number),
    });
    expect(dockerProbe).not.toHaveBeenCalled();
  });

  it("sends the sandbox only the prices of the models its steps can call", () => {
    const launch = launches[0]!;
    expect(JSON.parse(launch.env.RM_PRICING_TABLE)).toEqual({
      "acme/small-1": { input: 0.0000002, output: 0.0000008 },
    });
    expect(Buffer.byteLength(JSON.stringify(launch.env))).toBeLessThan(4096);
  });
});

describe("Mode B concurrency warning", () => {
  it("counts the cases a cap admits without float drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-modeb-warning-"));
    try {
      const store = new FsStore(join(root, "store"));
      const warnings: Array<[string, string]> = [];
      const refusingExecutor: ModeBExecutor = {
        async launch() {
          throw new Error("launch refused");
        },
        async status() {
          throw new Error("status should not be called");
        },
        async collect() {
          throw new Error("collect should not be called");
        },
        async destroy() {
          throw new Error("destroy should not be called");
        },
      };

      await replayModeB({
        stepRecords,
        cases: Array.from({ length: 4 }, (_, index) => ({
          ...cases[0]!,
          caseId: `case-${index + 1}`,
          trajectoryId: `trace-${index + 1}`,
          maxOutputTokens: 10_000,
        })),
        swapPolicy: { lookup: "acme/small-1" },
        executor: refusingExecutor,
        egress: {
          providerId: "stub",
          providerBaseUrl: "https://provider.example",
          apiKeyEnv: "REPLAY_MODEB_CLOUD_TEST_API_KEY",
          catalog: [
            {
              ...catalog[0]!,
              pricing: { input: 0, output: 0.00001 },
            },
          ],
        },
        store,
        budget: createBudget({
          store,
          projectId: "modeb-warning-test",
          runId: randomUUID(),
          authorizedTotalUsd: 0.3,
        }),
        image: "vercel/sandbox/universal:latest",
        appSpec: {
          mountPath: join(root, "app"),
          command: (caseFile) => ["node", "app.mjs", caseFile],
          timeoutMs: 5_000,
        },
        concurrency: 4,
        backend: "cloud",
        warning: (code, message) => warnings.push([code, message]),
      });

      expect(warnings).toEqual([
        [
          "modeb_concurrency_capped",
          expect.stringContaining(
            "admits 3 concurrent Mode B case(s) of up to $0.1000 each",
          ),
        ],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
