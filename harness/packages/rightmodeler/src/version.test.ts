import { describe, expect, it } from "vitest";

import { version } from "./version.js";

describe("rightmodeler package", () => {
  it("exports its version", () => {
    expect(version).toBe("0.2.0");
  });
});
