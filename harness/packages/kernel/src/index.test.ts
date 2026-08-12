import { describe, expect, it } from "vitest";

import { kernelPlaceholder } from "./index.js";

describe("kernel package", () => {
  it("exports its placeholder", () => {
    expect(kernelPlaceholder).toBe("kernel");
  });
});
