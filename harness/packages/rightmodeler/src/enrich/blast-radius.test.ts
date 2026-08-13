import type { StepRecord } from "@rightmodeler/core";
import { describe, expect, it } from "vitest";

import { blastRadius, type OwnerResolution } from "./index.js";

function step(
  stepId: string,
  path: string,
  family: string,
  downstreamStepIds: readonly string[],
  ownership: OwnerResolution,
): StepRecord {
  return {
    stepId,
    callSite: { path, line: 1, matcherSlug: "fixture" },
    family,
    replayMode: "single_shot",
    prefixProvenance: "external",
    riskTier: "low",
    capabilityRequirements: [],
    evaluatorLadder: [],
    currentModel: "current-model",
    observedCostUsd: 1,
    downstreamStepIds: [...downstreamStepIds],
    candidates: [],
    analysisHistory: [
      {
        path: ownership.path,
        owners: ownership.owners.map(({ handle, source }) => ({
          handle,
          source,
        })),
      },
    ],
    status: "replayed",
    contentHash: `hash-${stepId}`,
  };
}

describe("blastRadius", () => {
  it("collects transitive downstream files and their owner union for recommended families", () => {
    const records = [
      step("a", "src/a.ts", "summarize", ["b"], {
        path: "src/a.ts",
        owners: [{ handle: "@model-team", source: "codeowners" }],
      }),
      step("b", "src/b.ts", "extract", ["c"], {
        path: "src/b.ts",
        owners: [
          { handle: "@model-team", source: "codeowners" },
          { handle: "reviewer@example.com", source: "blame" },
        ],
      }),
      step("c", "src/c.ts", "publish", [], {
        path: "src/c.ts",
        owners: [{ handle: "@release-owner", source: "codeowners" }],
      }),
    ];

    expect(
      blastRadius({
        stepRecords: records,
        verdicts: [
          { familyId: "summarize", decision: "recommend" },
          { familyId: "extract", decision: "reject" },
        ],
      }),
    ).toEqual([
      {
        familyId: "summarize",
        files: ["src/a.ts"],
        downstreamFiles: ["src/b.ts", "src/c.ts"],
        owners: [
          { handle: "@model-team", source: "codeowners" },
          { handle: "@release-owner", source: "codeowners" },
          { handle: "reviewer@example.com", source: "blame" },
        ],
      },
    ]);
  });
});
