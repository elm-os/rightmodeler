import { describe, expect, it } from "vitest";

import { scannerPlaceholder } from "./index.js";

describe("scanner package", () => {
  it("exports its placeholder", () => {
    expect(scannerPlaceholder).toBe("scanner");
  });
});
