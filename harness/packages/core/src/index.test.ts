import { describe, expect, it } from "vitest";

import {
  executionSchema,
  FsStore,
  PluginRegistry,
  stepKey,
  stepRecordSchema,
} from "./index.js";

describe("core package", () => {
  it("exports the foundation contracts", () => {
    expect(executionSchema).toBeDefined();
    expect(stepRecordSchema).toBeDefined();
    expect(FsStore).toBeDefined();
    expect(PluginRegistry).toBeDefined();
    expect(stepKey("project", "step")).toBe("project/steps/step.json");
  });
});
