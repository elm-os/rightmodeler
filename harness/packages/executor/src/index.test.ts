import { describe, expect, it } from "vitest";
import { executorPackage } from "./index.js";

describe("scaffold", () => {
  it("exports the package marker", () => {
    expect(executorPackage).toContain("executor");
  });
});
