import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  computeEvidenceQuestionId,
  computeRunSpecDigest,
  computeStepId,
  mintAssessmentId,
  mintAttemptId,
  mintExecutionId,
} from "./identity.js";

describe("canonical identity", () => {
  it("uses JSON canonicalization rules", () => {
    expect(canonicalJson({ z: -0, exponent: 1e30, b: 1, a: "é" })).toBe(
      '{"a":"é","b":1,"exponent":1e+30,"z":0}',
    );
  });

  it("computes a stable step identity from semantic fields", () => {
    const input = {
      projectId: "project-1",
      normalizedPath: "src/agent.ts",
      enclosingSymbolPath: ["Agent", "run"],
      normalizedCallShape: {
        callee: "client.chat",
        argumentKeys: ["model", "messages"],
        enclosing: "Agent.run",
      },
    };

    expect(computeStepId(input)).toBe(
      "15c9f9a3e68916635617bf5f96690359011439615f85be0c7994706d9ab33140",
    );
    expect(
      computeStepId({
        ...input,
        normalizedCallShape: {
          argumentKeys: ["model", "messages"],
          callee: "client.chat",
          enclosing: "Agent.run",
        },
      }),
    ).toBe(computeStepId(input));
  });

  it("computes a stable evidence-question identity", () => {
    const input = {
      corpusVersionId: "corpus-3",
      promptRevision: "prompt-4",
      gatePolicyVersion: "gate-2",
      stepFingerprint: "step-fingerprint",
      evaluatorPlan: {
        evaluators: ["deterministic", "judge"],
        swapsPosition: true,
      },
      replayMode: "e2e" as const,
    };

    expect(computeEvidenceQuestionId(input)).toBe(
      "9764708c9f8ffd83c1150fef7712fdda12814faaab5e3447cf0448da88ec24aa",
    );
  });

  it("computes run digests independent of object insertion order", () => {
    const first = {
      projectId: "project-1",
      candidates: ["candidate-1", "candidate-2"],
      bounds: { maxCostUsd: 20, maxDurationMinutes: 60 },
    };
    const reordered = {
      bounds: { maxDurationMinutes: 60, maxCostUsd: 20 },
      candidates: ["candidate-1", "candidate-2"],
      projectId: "project-1",
    };

    expect(computeRunSpecDigest(first)).toBe(
      "4c67904ae514c592333d8ccdbbee6c0af6eef8131d6bde32aba72eb4f31ef6d6",
    );
    expect(computeRunSpecDigest(reordered)).toBe(computeRunSpecDigest(first));
  });

  it("mints distinct UUIDs for ledger facts", () => {
    const ids = [mintExecutionId(), mintAttemptId(), mintAssessmentId()];
    const uuidV4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    expect(new Set(ids)).toHaveLength(3);
    for (const id of ids) {
      expect(id).toMatch(uuidV4);
    }
  });
});
