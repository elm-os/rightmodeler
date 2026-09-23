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
  cases: Array<{ family: string; stepId: string; trajectoryId: string }>;
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
    steps: Array<{
      stepIndex: number;
      family?: string;
      model: string;
      trajectoryId: string;
    }>;
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
  edit: (attributes: SpanAttribute[], line: number) => SpanAttribute[],
): Promise<string> {
  const lines = (await readFile(tracePath("ai-sdk-v7-legacy.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  const edited = lines.map((line, index) => {
    const record = JSON.parse(line) as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ attributes: SpanAttribute[] }> }>;
      }>;
    };
    for (const resourceSpan of record.resourceSpans) {
      for (const scopeSpan of resourceSpan.scopeSpans) {
        for (const span of scopeSpan.spans) {
          span.attributes = edit(span.attributes, index);
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

function notes(name: string, model: string): string {
  return [
    'import { generateText } from "ai";',
    "",
    'import { acme } from "./provider.mjs";',
    "",
    `export async function ${name}(prompt) {`,
    `  return generateText({ model: acme("${model}"), prompt });`,
    "}",
    "",
  ].join("\n");
}

function retaggedTriage(
  modelOf: (triageCall: number) => string,
  functionIdOf: (triageCall: number) => string | undefined = () => undefined,
): (attributes: SpanAttribute[], line: number) => SpanAttribute[] {
  const triageLines: number[] = [];
  return (attributes, line) => {
    if (functionId(attributes) !== "triage") return attributes;
    if (!triageLines.includes(line)) triageLines.push(line);
    const call = triageLines.indexOf(line);
    const model = modelOf(call);
    const family = functionIdOf(call);
    return attributes.flatMap((attribute) =>
      attribute.key === "ai.telemetry.functionId"
        ? family === undefined
          ? []
          : [{ key: attribute.key, value: { stringValue: family } }]
        : attribute.key === "ai.model.id" ||
            attribute.key === "gen_ai.request.model"
          ? [{ key: attribute.key, value: { stringValue: model } }]
          : [attribute],
    );
  };
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

  it("abstains an unkeyed family whose model several call sites share", async () => {
    const { root, repo } = await fixtureRepo("lend", {
      "src/zz-notes-a.mjs": notes("notesA", "acme/max-1"),
      "src/zz-notes-b.mjs": notes("notesB", "acme/max-1"),
    });
    const byPath = stepIdsByPath(repo);
    const traces = await editedCapture(root, (attributes) =>
      functionId(attributes) === "triage"
        ? attributes.filter(({ key }) => key !== "ai.telemetry.functionId")
        : attributes,
    );

    const result = await shortlist(root, repo, traces);

    expect(familyPlan(result.shortlist, "unclassified")).toMatchObject({
      binding: "trace_match",
      stepIds: [],
      abstainReason: {
        reason: "ambiguous_call_site_binding",
        observed: 0,
        required: 64,
      },
    });
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

  it("places an unkeyed family on the call sites its traces matched by model", async () => {
    const { root, repo } = await fixtureRepo("by-model", {
      "src/zz-notes-a.mjs": notes("notesA", "acme/lite-1"),
      "src/zz-notes-b.mjs": notes("notesB", "acme/small-1"),
    });
    const byPath = stepIdsByPath(repo);
    const siteByModel = new Map([
      ["acme/lite-1", byPath.get("src/zz-notes-a.mjs")!],
      ["acme/small-1", byPath.get("src/zz-notes-b.mjs")!],
    ]);
    const traces = await editedCapture(
      root,
      retaggedTriage((call) => (call < 32 ? "acme/lite-1" : "acme/small-1")),
    );

    const result = await shortlist(root, repo, traces);

    const unclassified = familyPlan(result.shortlist, "unclassified");
    expect(unclassified).toMatchObject({
      binding: "trace_match",
      stepIds: [...siteByModel.values()],
    });
    expect(unclassified.abstainReason).toBeUndefined();
    expect(unclassified.leftOutCases).toBeUndefined();
    const modelByTrajectory = new Map(
      result.ingest.runs.flatMap(({ steps }) =>
        steps.map(({ trajectoryId, model }) => [trajectoryId, model] as const),
      ),
    );
    const placed = result.shortlist.cases.filter(
      ({ family }) => family === "unclassified",
    );
    expect(placed).toHaveLength(64);
    for (const { trajectoryId, stepId } of placed) {
      expect(stepId).toBe(
        siteByModel.get(modelByTrajectory.get(trajectoryId)!),
      );
    }
    expect(
      result.warnings.filter(({ code }) => code === "family_cases_left_out"),
    ).toEqual([]);
  }, 120_000);

  it("leaves out ambiguous cases and still replays the rest", async () => {
    const { root, repo } = await fixtureRepo("partly-ambiguous", {
      "src/zz-notes-a.mjs": notes("notesA", "acme/lite-1"),
      "src/zz-notes-b.mjs": notes("notesB", "acme/small-1"),
    });
    const byPath = stepIdsByPath(repo);
    const traces = await editedCapture(
      root,
      retaggedTriage((call) =>
        call >= 59
          ? "acme/large-1"
          : call < 32
            ? "acme/lite-1"
            : "acme/small-1",
      ),
    );

    const result = await shortlist(root, repo, traces);

    const unclassified = familyPlan(result.shortlist, "unclassified");
    expect(unclassified).toMatchObject({
      binding: "trace_match",
      cases: 64,
      leftOutCases: 5,
      stepIds: [
        byPath.get("src/zz-notes-a.mjs")!,
        byPath.get("src/zz-notes-b.mjs")!,
      ],
    });
    expect(unclassified.abstainReason).toBeUndefined();
    expect(
      result.shortlist.cases.filter(({ family }) => family === "unclassified"),
    ).toHaveLength(59);
    expect(
      result.warnings.filter(({ code }) => code === "family_cases_left_out"),
    ).toEqual([
      {
        code: "family_cases_left_out",
        message:
          "Family unclassified: 5 of 64 traced cases were left out of the replay sample: 5 could not be tied to a call site of this family alone.",
      },
    ]);
  }, 120_000);

  it("never places two families on a call site both of their traces matched", async () => {
    const { root, repo } = await fixtureRepo("shared-site", {
      "src/zz-notes-a.mjs": notes("notesA", "acme/lite-1"),
    });
    const traces = await editedCapture(
      root,
      retaggedTriage(
        () => "acme/lite-1",
        (call) => (call < 32 ? undefined : "notes"),
      ),
    );

    const result = await shortlist(root, repo, traces);

    for (const familyId of ["unclassified", "notes"]) {
      expect(familyPlan(result.shortlist, familyId)).toMatchObject({
        binding: "trace_match",
        stepIds: [],
        leftOutCases: 32,
        abstainReason: {
          reason: "ambiguous_call_site_binding",
          observed: 0,
          required: 32,
        },
      });
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
