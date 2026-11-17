import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FsStore,
  confirmPlanKey,
  factsPrefix,
  reportKey,
  verdictsPrefix,
} from "@rightmodeler/core";
import { afterAll, describe, expect, it } from "vitest";

import {
  ensureLanggraphImage,
  jsonOutput,
  langgraphFixtureCopy,
  removeTemporaryDirectories,
  runCli,
  secret,
  startConfirmStub,
  startStub,
  storeText,
  writeModeBConfig,
} from "./test-utils/e2e.js";

afterAll(removeTemporaryDirectories);

const skipDocker = process.env.RIGHTMODELER_SKIP_DOCKER === "1";
if (skipDocker) {
  console.warn(
    "[cli e2e] SKIPPED Mode B confirmation: RIGHTMODELER_SKIP_DOCKER=1",
  );
}

describe("built CLI pipeline", () => {
  it.skipIf(skipDocker)(
    "runs Mode B confirmation, isolates the interacting pair, and resumes from its frontier",
    async () => {
      const { root, repo, traces } = await langgraphFixtureCopy("confirm");
      const image = await ensureLanggraphImage(root);
      const modeBConfig = await writeModeBConfig(root, repo, image);
      const stub = await startConfirmStub();
      const args = [
        "init",
        "--traces",
        traces,
        "--base-url",
        `http://127.0.0.1:${stub.port}/v1`,
        "--api-key-env",
        "RIGHTMODELER_CONFIRM_E2E_API_KEY",
        "--modeb-config",
        modeBConfig,
        "--output",
        "json",
        "--repo",
        repo,
      ];

      try {
        const first = await runCli(args, {
          env: { RIGHTMODELER_CONFIRM_E2E_API_KEY: secret },
        });
        const output = jsonOutput(first);
        expect(first.code, JSON.stringify(output.familyOutcomes)).toBe(0);
        const store = new FsStore(join(repo, ".rightmodeler"));
        expect(output.executedStages).toContain("confirm");
        expect(output.familyOutcomes).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            verdict: expect.objectContaining({
              decision: "reject",
              abstainReason: { reason: "cascade_isolated" },
            }),
            decisionDisplay: "reject",
            effectiveRecommendation: false,
            confirmation: expect.objectContaining({
              status: "isolated",
              runSetsUsed: expect.any(Number),
              culprits: [["classify", "lookup"]],
              cascadeSeedStepId: "classify",
              maxRunSets: 20,
            }),
          }),
        );

        const factKeys = await store.list(factsPrefix("project"));
        const facts = await Promise.all(
          factKeys.map(async (key) => JSON.parse(await storeText(store, key))),
        );
        const cascades = facts.filter(
          (fact) =>
            typeof fact === "object" && fact !== null && "cascadeId" in fact,
        ) as Array<Record<string, unknown>>;
        expect(cascades).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            verdict: "isolated",
            culprits: [["classify", "lookup"]],
            cascadeSeedStepId: "classify",
            runSetsUsed: expect.any(Number),
          }),
        );
        const plan = JSON.parse(
          await storeText(
            store,
            confirmPlanKey("project", "langgraph_order_lookup"),
          ),
        ) as { verdict: string; queue: Array<{ status: string }> };
        expect(plan.verdict).toBe("isolated");
        expect(
          plan.queue.every(
            ({ status }) => status === "pass" || status === "fail",
          ),
        ).toBe(true);

        const reportMarkdown = await storeText(
          store,
          reportKey("project", "report.md"),
        );
        expect(reportMarkdown).toContain("## Confirm");
        expect(reportMarkdown).toContain(
          "| langgraph_order_lookup | isolated |",
        );
        expect(reportMarkdown).toContain("classify + lookup");
        expect(reportMarkdown).toContain("cascade_isolated");
        const storedVerdictKeys = await store.list(verdictsPrefix("project"));
        const storedVerdicts = await Promise.all(
          storedVerdictKeys.map(async (key) =>
            JSON.parse(await storeText(store, key)),
          ),
        );
        expect(storedVerdicts).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            decision: "reject",
            abstainReason: { reason: "cascade_isolated" },
          }),
        );

        const hits = stub.getHitCount();
        const resumed = await runCli(args, {
          env: { RIGHTMODELER_CONFIRM_E2E_API_KEY: secret },
        });
        expect(resumed.code).toBe(0);
        expect(jsonOutput(resumed).executedStages).toEqual([]);
        expect(stub.getHitCount()).toBe(hits);
        expect(await store.list(factsPrefix("project"))).toHaveLength(
          factKeys.length,
        );
      } finally {
        await stub.close();
      }
    },
    900_000,
  );

  it.skipIf(skipDocker)(
    "confirms a mixed-vendor LangGraph family with a judge outside the final node's model family",
    async () => {
      const { root, repo, traces } = await langgraphFixtureCopy(
        "mixed-vendor-confirm",
      );
      const spans = JSON.parse(await readFile(traces, "utf8")) as Array<{
        name: string;
        attributes: Record<string, unknown>;
      }>;
      await writeFile(
        traces,
        JSON.stringify(
          spans.map((span) =>
            span.name === "answer"
              ? {
                  ...span,
                  attributes: {
                    ...span.attributes,
                    "gen_ai.request.model": "zeta/judge-1",
                    "gen_ai.response.model": "zeta/judge-1",
                  },
                }
              : span,
          ),
        ),
      );
      const image = await ensureLanggraphImage(root);
      const modeBConfig = await writeModeBConfig(root, repo, image);
      const { stepMap } = JSON.parse(await readFile(modeBConfig, "utf8")) as {
        stepMap: Record<string, string>;
      };
      const answerStepId = Object.keys(stepMap).find(
        (stepId) => stepMap[stepId] === "answer",
      )!;
      const stub = await startStub();

      try {
        const result = await runCli(
          [
            "init",
            "--traces",
            traces,
            "--base-url",
            `http://127.0.0.1:${stub.port}/v1`,
            "--api-key-env",
            "RIGHTMODELER_MIXED_CONFIRM_API_KEY",
            "--modeb-config",
            modeBConfig,
            "--output",
            "json",
            "--repo",
            repo,
          ],
          { env: { RIGHTMODELER_MIXED_CONFIRM_API_KEY: secret } },
        );
        const output = jsonOutput(result);
        expect([0, 1], JSON.stringify(output.familyOutcomes)).toContain(
          result.code,
        );
        expect(output.executedStages).toContain("confirm");
        expect(output.familyOutcomes).toContainEqual(
          expect.objectContaining({
            familyId: "langgraph_order_lookup",
            confirmation: expect.objectContaining({ status: "confirmed" }),
          }),
        );

        const store = new FsStore(join(repo, ".rightmodeler"));
        const facts = (await Promise.all(
          (await store.list(factsPrefix("project"))).map(async (key) =>
            JSON.parse(await storeText(store, key)),
          ),
        )) as Array<Record<string, unknown>>;
        const executions = new Map(
          facts
            .filter(
              ({ executionId, caseId }) =>
                typeof executionId === "string" && typeof caseId === "string",
            )
            .map((fact) => [fact.executionId as string, fact]),
        );
        const judges: Record<string, string[]> = {};
        for (const { executionId, evaluatorId } of facts.filter(
          ({ assessmentId }) => typeof assessmentId === "string",
        )) {
          const execution = executions.get(executionId as string)!;
          const role = String(execution.caseId).startsWith("confirm-")
            ? "confirm"
            : execution.stepId === answerStepId
              ? "answer"
              : "upstream";
          judges[role] = [
            ...new Set([...(judges[role] ?? []), evaluatorId as string]),
          ];
        }
        expect(judges).toEqual({
          confirm: ["yotta/judge-2"],
          answer: ["yotta/judge-2"],
          upstream: ["zeta/judge-1"],
        });
      } finally {
        await stub.close();
      }
    },
    900_000,
  );
});
