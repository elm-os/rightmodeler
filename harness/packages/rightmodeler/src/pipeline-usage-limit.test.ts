import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsStore, readLedger } from "@rightmodeler/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runPipeline } from "./pipeline.js";
import { Reporter } from "./protocol.js";
import { readSetupState } from "./state.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const limit = vi.hoisted(() => ({ remainingChats: Number.POSITIVE_INFINITY }));

vi.mock("@rightmodeler/replay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rightmodeler/replay")>();
  return {
    ...actual,
    createProvider: (
      options: Parameters<typeof actual.createProvider>[0],
    ): ReturnType<typeof actual.createProvider> => {
      const client = actual.createProvider(options);
      return {
        ...client,
        chat: async (request) => {
          if (limit.remainingChats <= 0) {
            throw new actual.BlockedError({
              kind: "usage-limit",
              providerId: options.providerId,
              resetsAt: "2026-09-25T20:00:00.000Z",
              detail: "fixture plan limit",
            });
          }
          limit.remainingChats -= 1;
          return client.chat(request);
        },
      };
    },
  };
});

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getRequests(): Array<Record<string, unknown>>;
  getRequestHeaders(): Array<{ method: string; path: string }>;
}

const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);
const stubModuleUrl = new URL(
  "../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const apiKeyEnv = "RIGHTMODELER_USAGE_LIMIT_TEST_API_KEY";
const judgeModels = new Set(["zeta/judge-1", "yotta/judge-2"]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env[apiKeyEnv];
  limit.remainingChats = Number.POSITIVE_INFINITY;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("plan usage limit", () => {
  it("stops replay at a plan usage limit with exit 2 plan_usage_limit and resumes on rerun without repeating finished calls", async () => {
    const { startStubProvider } = (await import(stubModuleUrl)) as {
      startStubProvider(options: { port: number }): Promise<StubProvider>;
    };
    const stub = await startStubProvider({ port: 0 });
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-usage-limit-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const storeRoot = join(root, "store");
    process.env[apiKeyEnv] = "fixture-key";
    const options = {
      repo,
      store: storeRoot,
      traces: tracesPath,
      baseUrl: `http://127.0.0.1:${stub.port}/v1`,
      apiKeyEnv,
      through: "replay" as const,
      reporter: new Reporter("json", {
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    };
    const catalogRequests = () =>
      stub
        .getRequestHeaders()
        .filter(({ method, path }) => method === "GET" && path === "/v1/models")
        .length;
    const candidateRequests = () =>
      stub.getRequests().filter(({ model }) => !judgeModels.has(String(model)))
        .length;
    const store = new FsStore(storeRoot);
    try {
      limit.remainingChats = 3;
      await expect(runPipeline(options)).rejects.toMatchObject({
        exitCode: 2,
        code: "plan_usage_limit",
        message: expect.stringContaining("(resets 2026-09-25T20:00:00.000Z)"),
      });
      expect(
        (await readSetupState(store, "project")).stages.replay,
      ).toBeUndefined();
      expect(catalogRequests()).toBe(1);
      const stopped = await readLedger(store, "project");
      expect(stopped.executions.length).toBeGreaterThan(0);

      limit.remainingChats = Number.POSITIVE_INFINITY;
      await runPipeline(options);

      expect(
        (await readSetupState(store, "project")).stages.replay,
      ).toBeDefined();
      expect(catalogRequests()).toBe(2);
      const ledger = await readLedger(store, "project");
      const cells = ledger.executions.map(
        ({ evidenceQuestionId, caseId, candidateId }) =>
          JSON.stringify([evidenceQuestionId, caseId, candidateId]),
      );
      expect(new Set(cells).size).toBe(cells.length);
      expect(candidateRequests()).toBe(ledger.executions.length);
      for (const { executionId } of stopped.executions) {
        expect(
          ledger.assessments.filter(
            (assessment) => assessment.executionId === executionId,
          ),
        ).toHaveLength(1);
      }
    } finally {
      await stub.close();
    }
  });
});
