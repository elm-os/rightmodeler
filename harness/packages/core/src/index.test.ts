import { describe, expect, it } from "vitest";

import { corePlaceholder } from "./index.js";

describe("core package", () => {
  it("exports its placeholder", () => {
    expect(corePlaceholder).toBe("core");
  });
});
