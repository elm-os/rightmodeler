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
});
