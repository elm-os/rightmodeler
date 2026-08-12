import { describe, expect, it } from "vitest";

import { replayPlaceholder } from "./index.js";

describe("replay package", () => {
  it("exports its placeholder", () => {
    expect(replayPlaceholder).toBe("replay");
  });
});
