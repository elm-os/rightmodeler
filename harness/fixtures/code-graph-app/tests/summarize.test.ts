import { expect, it } from "vitest";

import { summarize } from "../src/summarize.js";

it("summarizes", async () => {
  expect(await summarize("hello")).not.toBe("");
});
