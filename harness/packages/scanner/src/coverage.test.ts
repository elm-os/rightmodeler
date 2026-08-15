import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StepRecord } from "@rightmodeler/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  coveragePolicy,
  detectTech,
  evaluateCoverage,
  type DetectedTech,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function step(path: string): StepRecord {
  return {
    stepId: `step-${path}`,
    callSite: { path, line: 1, matcherSlug: "model-call" },
    family: "model-call",
    replayMode: "single_shot",
    prefixProvenance: "unknown",
    riskTier: "normal",
    capabilityRequirements: [],
    evaluatorLadder: [],
    currentModel: "acme/large-1",
    observedCostUsd: 0,
    downstreamStepIds: [],
    candidates: [],
    analysisHistory: [],
    status: "pending",
    contentHash: "hash",
  };
}

const detected: DetectedTech = {
  languages: ["javascript", "python"],
  aiDependencies: [
    { language: "javascript", name: "ai", manifestPath: "package.json" },
    {
      language: "python",
      name: "openai",
      manifestPath: "requirements.txt",
    },
  ],
};

describe("tech detection and coverage policy", () => {
  it("detects the declared JavaScript and Python AI dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-tech-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { ai: "1", openai: "2", unrelated: "3" },
      }),
    );
    await writeFile(
      join(root, "requirements.txt"),
      "openai>=1\nlitellm==2\nrequests==3\n",
    );

    expect(detectTech(root).aiDependencies).toEqual([
      { language: "javascript", name: "ai", manifestPath: "package.json" },
      {
        language: "javascript",
        name: "openai",
        manifestPath: "package.json",
      },
      { language: "python", name: "litellm", manifestPath: "requirements.txt" },
      { language: "python", name: "openai", manifestPath: "requirements.txt" },
    ]);
  });

  it.each(["langchain-openai==0.1", "langchain_anthropic==0.2"])(
    "parses the Python dependency name in %s and ignores comments",
    async (requirement) => {
      const root = await mkdtemp(
        join(tmpdir(), "rightmodeler-scanner-python-"),
      );
      temporaryDirectories.push(root);
      await writeFile(
        join(root, "requirements.txt"),
        `${requirement}\n# openai is deliberately unused\n`,
      );

      expect(detectTech(root).aiDependencies).toEqual([
        {
          language: "python",
          name: "langchain",
          manifestPath: "requirements.txt",
        },
      ]);
    },
  );

  it("fails when a detected dependency language has no call sites", () => {
    const result = evaluateCoverage({
      stepRecords: [step("src/agent.py")],
      fileUniverse: ["src/agent.py", "src/agent.ts"],
      detectedTech: detected,
    });

    expect(result).toMatchObject({
      pass: false,
      failures: [{ code: "AI_DEPENDENCY_ZERO_MATCH", language: "javascript" }],
    });
  });

  it("applies the frozen low-language match-rate threshold", () => {
    const fileUniverse = Array.from(
      { length: 101 },
      (_, index) => `src/${index}.ts`,
    );
    const result = evaluateCoverage({
      stepRecords: [step(fileUniverse[0]!)],
      fileUniverse,
      detectedTech: {
        languages: ["javascript"],
        aiDependencies: [detected.aiDependencies[0]!],
      },
    });

    expect(Object.isFrozen(coveragePolicy)).toBe(true);
    expect(result.failures[0]?.code).toBe("LOW_LANGUAGE_MATCH_RATE");
  });
});
