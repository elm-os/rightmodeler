import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeEvidenceQuestionId,
  computeRunSpecDigest,
  FsStore,
  setupStateKey,
  type JsonValue,
} from "@rightmodeler/core";
import { minimumTrialsForFloor } from "@rightmodeler/kernel";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceQuestionIdentity,
  releasePolicy,
  resolveCheckpointedPipelineCorpus,
  runPipeline,
} from "./pipeline.js";
import { Reporter } from "./protocol.js";
import { makeGitFixture } from "./test-utils/git-fixture.js";

const temporaryDirectories: string[] = [];
const demoAppPath = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const tracesPath = fileURLToPath(
  new URL("../../../fixtures/traces/otel-genai.json", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release policy", () => {
  it("reproduces the existing defaults", () => {
    const resolved = releasePolicy(undefined);

    expect(resolved.effective).toEqual({
      qualityFloor: 0.85,
      shortlistTop: 3,
      allowModels: [],
      denyModels: [],
    });
    expect(resolved.minimumHoldoutCases).toBe(minimumTrialsForFloor(0.85, 1));
    expect(resolved.gate.gatePolicyVersion).toMatch(
      /^phase-a-v3-[0-9a-f]{12}$/u,
    );
  });

  it("keeps the version stable across key and array order", () => {
    const first = releasePolicy({
      denyModels: ["b", "a"],
      qualityFloor: 0.9,
    });
    const second = releasePolicy({
      qualityFloor: 0.9,
      denyModels: ["a", "b", "b"],
    });

    expect(first.gate.gatePolicyVersion).toBe(second.gate.gatePolicyVersion);
    expect(first.gate.gatePolicyVersion).not.toBe(
      releasePolicy(undefined).gate.gatePolicyVersion,
    );
  });

  it("uses the exported core evidence question formula", () => {
    const input = {
      corpusVersionId: "corpus-1",
      gatePolicyVersion: "policy-1",
      evaluatorPlan: {
        evaluatorKind: "judge",
        gateMetric: "replacement-quality",
      },
      family: "summarize",
      stepIds: ["step-1", "step-2"],
      reproofRequestIds: ["reproof-1"],
    };

    expect(evidenceQuestionIdentity(input)).toBe(
      computeEvidenceQuestionId({
        corpusVersionId: input.corpusVersionId,
        promptRevision: "replay-prompt-v1",
        gatePolicyVersion: input.gatePolicyVersion,
        stepFingerprint: computeRunSpecDigest({
          family: input.family,
          stepIds: [...input.stepIds],
          reproofRequestIds: [...input.reproofRequestIds],
        }),
        evaluatorPlan: input.evaluatorPlan,
        replayMode: "single_shot",
      }),
    );
  });

  it("separates plan-route evidence from API evidence and keeps API identities unchanged", () => {
    const input = {
      corpusVersionId: "corpus-1",
      gatePolicyVersion: "policy-1",
      evaluatorPlan: {
        evaluatorKind: "judge",
        gateMetric: "replacement-quality",
      },
      family: "summarize",
      stepIds: ["step-1", "step-2"],
      reproofRequestIds: [],
    };
    const identity = (stepFingerprint: JsonValue) =>
      computeEvidenceQuestionId({
        corpusVersionId: input.corpusVersionId,
        promptRevision: "replay-prompt-v1",
        gatePolicyVersion: input.gatePolicyVersion,
        stepFingerprint: computeRunSpecDigest(stepFingerprint),
        evaluatorPlan: input.evaluatorPlan,
        replayMode: "single_shot",
      });

    const api = evidenceQuestionIdentity(input);
    const plan = evidenceQuestionIdentity({
      ...input,
      candidateRoute: "claude-login",
    });

    expect(api).toBe(
      identity({ family: input.family, stepIds: [...input.stepIds] }),
    );
    expect(plan).toBe(
      identity({
        family: input.family,
        stepIds: [...input.stepIds],
        candidateRoute: "claude-login",
      }),
    );
    expect(plan).not.toBe(api);
  });

  it("persists evidence question ids from the shared formula", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-policy-"));
    temporaryDirectories.push(root);
    const repo = await makeGitFixture(root, demoAppPath, "demo-app");
    const storeRoot = join(root, "store");
    const reporter = new Reporter("json", {
      stdout: () => undefined,
      stderr: () => undefined,
    });

    await runPipeline({
      repo,
      store: storeRoot,
      traces: tracesPath,
      through: "shortlist",
      reporter,
    });

    const store = new FsStore(storeRoot);
    const stateEntry = await store.get(setupStateKey("project"));
    expect(stateEntry).not.toBeNull();
    const state = JSON.parse(
      Buffer.from(stateEntry!.body).toString("utf8"),
    ) as { stages: Record<string, { outputKey: string }> };
    const outputKey = state.stages.shortlist?.outputKey;
    expect(outputKey).toEqual(expect.any(String));
    const artifactEntry = await store.get(outputKey!);
    expect(artifactEntry).not.toBeNull();
    const artifact = JSON.parse(
      Buffer.from(artifactEntry!.body).toString("utf8"),
    ) as {
      familyPlans: Array<{
        familyId: string;
        evidenceQuestionId: string;
        stepIds: string[];
      }>;
    };
    const corpus = await resolveCheckpointedPipelineCorpus({
      repo,
      store,
      storeRoot,
      projectId: "project",
    });

    expect(artifact.familyPlans.length).toBeGreaterThan(0);
    for (const plan of artifact.familyPlans) {
      expect(plan.evidenceQuestionId).toBe(
        evidenceQuestionIdentity({
          corpusVersionId: corpus.corpusVersionId,
          gatePolicyVersion: releasePolicy(undefined).gate.gatePolicyVersion,
          evaluatorPlan: {
            evaluatorKind: "judge",
            gateMetric: "replacement-quality",
          },
          family: plan.familyId,
          stepIds: plan.stepIds,
          reproofRequestIds: [],
        }),
      );
    }
  }, 120_000);
});
