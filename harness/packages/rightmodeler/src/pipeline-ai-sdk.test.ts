import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FsStore, setupStateKey } from "@rightmodeler/core";
import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterEach, describe, expect, it } from "vitest";

import { runPipeline, type FamilyPlan } from "./pipeline.js";
import { Reporter } from "./protocol.js";
import { commitGitFixture, makeGitFixture } from "./test-utils/git-fixture.js";

const temporaryDirectories: string[] = [];
const aiSdkAppPath = fileURLToPath(
  new URL("../../../fixtures/ai-sdk-app", import.meta.url),
);

function tracePath(name: string): string {
  return fileURLToPath(
    new URL(`../../../fixtures/traces/${name}`, import.meta.url),
  );
}

interface SpanAttribute {
  key: string;
  value: { stringValue?: string };
}

interface ShortlistArtifact {
  familyPlans: FamilyPlan[];
  cases: Array<{ family: string; stepId: string }>;
}

interface ReconcileArtifact {
  traceStepBindings: Array<{
    traceId: string;
    stepIndex: number;
    stepIds: string[];
    via?: string;
  }>;
}

interface IngestArtifact {
  runs: Array<{
    traceId: string;
    steps: Array<{ stepIndex: number; family?: string }>;
  }>;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureRepo(
  label: string,
  files: Record<string, string> = {},
): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `rightmodeler-ai-sdk-${label}-`));
  temporaryDirectories.push(root);
  const repo = await makeGitFixture(root, aiSdkAppPath, "ai-sdk-app");
  if (Object.keys(files).length > 0) {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(repo, path), content);
    }
    await commitGitFixture(repo, "Edit fixture");
  }
  return { root, repo };
}

async function editedCapture(
  root: string,
  edit: (attributes: SpanAttribute[]) => SpanAttribute[],
): Promise<string> {
  const lines = (await readFile(tracePath("ai-sdk-v7-legacy.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const edited = lines.map((line) => {
    const record = JSON.parse(line) as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ attributes: SpanAttribute[] }> }>;
      }>;
    };
    for (const resourceSpan of record.resourceSpans) {
      for (const scopeSpan of resourceSpan.scopeSpans) {
        for (const span of scopeSpan.spans) {
          span.attributes = edit(span.attributes);
        }
      }
    }
    return JSON.stringify(record);
  });
  const path = join(root, "edited-capture.jsonl");
  await writeFile(path, `${edited.join("\n")}\n`);
  return path;
}

function functionId(attributes: readonly SpanAttribute[]): string | undefined {
  return attributes.find(({ key }) => key === "ai.telemetry.functionId")?.value
    .stringValue;
}

async function shortlist(
  root: string,
  repo: string,
  traces: string,
): Promise<{
  shortlist: ShortlistArtifact;
  reconcile: ReconcileArtifact;
  ingest: IngestArtifact;
  warnings: Array<{ code: string; message: string }>;
}> {
  const storeRoot = join(root, "store");
  const warnings: Array<{ code: string; message: string }> = [];
  const reporter = new Reporter("json", {
    stdout: () => undefined,
    stderr: (text) => {
      for (const line of text.split("\n").filter(Boolean)) {
        const value = JSON.parse(line) as {
          event?: string;
          code: string;
          message: string;
        };
        if (value.event === "warning") {
          warnings.push({ code: value.code, message: value.message });
        }
      }
    },
  });
  await runPipeline({
    repo,
    store: storeRoot,
    traces,
    through: "shortlist",
    reporter,
  });
  const store = new FsStore(storeRoot);
  const state = JSON.parse(
    Buffer.from((await store.get(setupStateKey("project")))!.body).toString(
      "utf8",
    ),
  ) as { stages: Record<string, { outputKey: string }> };
  const artifact = async <T>(stage: string): Promise<T> =>
    JSON.parse(
      Buffer.from(
        (await store.get(state.stages[stage]!.outputKey))!.body,
      ).toString("utf8"),
    ) as T;
  return {
    shortlist: await artifact<ShortlistArtifact>("shortlist"),
    reconcile: await artifact<ReconcileArtifact>("reconcile"),
    ingest: await artifact<IngestArtifact>("ingest"),
    warnings,
  };
}

function stepIdsByPath(repo: string): Map<string, string> {
  return new Map(
    scan(repo, createMatcherRegistry(), "project")
      .filter(({ callSite }) => callSite.matcherSlug.startsWith("js-ai-sdk-"))
      .map(({ callSite, stepId }) => [callSite.path, stepId]),
  );
}

function familyPlan(artifact: ShortlistArtifact, familyId: string): FamilyPlan {
  const plan = artifact.familyPlans.find(
    (candidate) => candidate.familyId === familyId,
  );
  expect(plan, `no plan for ${familyId}`).toBeDefined();
  return plan!;
}

describe("AI SDK call-site binding", () => {
  it.each(["ai-sdk-v7-legacy.jsonl", "ai-sdk-v7-genai.jsonl"])(
    "binds every AI SDK family to its own call sites (%s)",
    async (capture) => {
      const { root, repo } = await fixtureRepo("bind");
      const byPath = stepIdsByPath(repo);
      const summarizeSites = [
        byPath.get("src/summarize.mjs")!,
        byPath.get("src/summarize-stream.mjs")!,
      ].sort();
      const triageSite = byPath.get("src/triage.mjs")!;

      const result = await shortlist(root, repo, tracePath(capture));

      const summarize = familyPlan(result.shortlist, "summarize");
      expect(summarize.binding).toBe("trace_key");
      expect(summarize.abstainReason).toBeUndefined();
      expect([...summarize.stepIds].sort()).toEqual(summarizeSites);
      expect(
        [
          ...new Set(
            result.shortlist.cases
              .filter(({ family }) => family === "summarize")
              .map(({ stepId }) => stepId),
          ),
        ].sort(),
      ).toEqual(summarizeSites);

      const triage = familyPlan(result.shortlist, "triage");
      expect(triage).toMatchObject({
        binding: "trace_key",
        stepIds: [triageSite],
      });
      expect(triage.abstainReason).toBeUndefined();

      for (const [familyId, required] of [
        ["support-agent", 12],
        ["extract-order", 5],
        ["extract-order-stream", 5],
      ] as const) {
        expect(familyPlan(result.shortlist, familyId)).toMatchObject({
          binding: "trace_key",
          stepIds: [],
          abstainReason: {
            reason: "bound_call_sites_not_replayable",
            observed: 0,
            required,
          },
        });
      }

      for (const replayCase of result.shortlist.cases) {
        expect(
          familyPlan(result.shortlist, replayCase.family).stepIds,
        ).toContain(replayCase.stepId);
      }

      const traceSteps = result.ingest.runs.flatMap(({ traceId, steps }) =>
        steps.map((step) => ({ traceId, ...step })),
      );
      expect(result.reconcile.traceStepBindings).toHaveLength(
        traceSteps.length,
      );
      const triageSteps = traceSteps.filter(
        ({ family }) => family === "triage",
      );
      expect(triageSteps.length).toBeGreaterThan(0);
      for (const step of triageSteps) {
        expect(
          result.reconcile.traceStepBindings.find(
            ({ traceId, stepIndex }) =>
              traceId === step.traceId && stepIndex === step.stepIndex,
          ),
        ).toEqual({
          traceId: step.traceId,
          stepIndex: step.stepIndex,
          stepIds: [triageSite],
          via: "trace_key",
        });
      }
    },
    120_000,
  );

  it("never lends a keyed call site to an unkeyed family", async () => {
    const notes = (name: string) =>
      [
        'import { generateText } from "ai";',
        "",
        'import { acme } from "./provider.mjs";',
        "",
        `export async function ${name}(prompt) {`,
        '  return generateText({ model: acme("acme/max-1"), prompt });',
        "}",
        "",
      ].join("\n");
    const { root, repo } = await fixtureRepo("lend", {
      "src/zz-notes-a.mjs": notes("notesA"),
      "src/zz-notes-b.mjs": notes("notesB"),
    });
    const byPath = stepIdsByPath(repo);
    const traces = await editedCapture(root, (attributes) =>
      functionId(attributes) === "triage"
        ? attributes.filter(({ key }) => key !== "ai.telemetry.functionId")
        : attributes,
    );

    const result = await shortlist(root, repo, traces);

    expect([...familyPlan(result.shortlist, "unclassified").stepIds]).toEqual([
      byPath.get("src/zz-notes-a.mjs")!,
      byPath.get("src/zz-notes-b.mjs")!,
    ]);
    const summarizeSites = new Set([
      byPath.get("src/summarize.mjs")!,
      byPath.get("src/summarize-stream.mjs")!,
    ]);
    for (const plan of result.shortlist.familyPlans) {
      if (plan.familyId === "summarize") continue;
      expect(
        plan.stepIds.filter((stepId) => summarizeSites.has(stepId)),
      ).toEqual([]);
    }
  }, 120_000);

  it("leaves out cases from a keyed call site that replay cannot run", async () => {
    const supportAgent = (
      await readFile(join(aiSdkAppPath, "src/support-agent.mjs"), "utf8")
    )
      .replace('functionId: "support-agent"', 'functionId: "summarize"')
      .replace('acme("acme/large-1")', 'acme("acme/max-1")');
    const { root, repo } = await fixtureRepo("left-out", {
      "src/support-agent.mjs": supportAgent,
    });
    const byPath = stepIdsByPath(repo);
    const traces = await editedCapture(root, (attributes) =>
      functionId(attributes) === "support-agent"
        ? attributes.map((attribute) =>
            attribute.key === "ai.telemetry.functionId"
              ? { key: attribute.key, value: { stringValue: "summarize" } }
              : attribute.key === "ai.model.id"
                ? { key: attribute.key, value: { stringValue: "acme/max-1" } }
                : attribute,
          )
        : attributes,
    );

    const result = await shortlist(root, repo, traces);

    const summarize = familyPlan(result.shortlist, "summarize");
    expect([...summarize.stepIds].sort()).toEqual(
      [
        byPath.get("src/summarize.mjs")!,
        byPath.get("src/summarize-stream.mjs")!,
      ].sort(),
    );
    expect(summarize.leftOutCases).toBe(12);
    expect(result.warnings).toContainEqual({
      code: "family_cases_left_out",
      message: expect.stringContaining("Family summarize: 12 of"),
    });
  }, 120_000);
});
