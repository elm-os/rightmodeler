import { describe, expect, it } from "vitest";

import {
  canonicalModelName,
  executionSchema,
  FsStore,
  stepKey,
  stepRecordSchema,
} from "./index.js";

describe("core package", () => {
  it("exports the foundation contracts", () => {
    expect(executionSchema).toBeDefined();
    expect(stepRecordSchema).toBeDefined();
    expect(FsStore).toBeDefined();
    expect(stepKey("project", "step")).toBe("project/steps/step.json");
  });
});

describe("canonicalModelName", () => {
  it("canonical model name removes a date snapshot and folds dots into dashes", () => {
    expect(canonicalModelName("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5",
    );
    expect(canonicalModelName("anthropic/claude-haiku-4.5")).toBe(
      "claude-haiku-4-5",
    );
    expect(canonicalModelName("Claude-Opus-5.5")).toBe("claude-opus-5-5");
    expect(canonicalModelName("openai/gpt-4o-2024-08-06")).toBe(
      "gpt-4o-2024-08-06",
    );
  });
});
