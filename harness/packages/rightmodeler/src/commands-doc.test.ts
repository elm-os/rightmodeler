import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createProgram } from "./cli.js";
import { renderCommandsDoc } from "./commands-doc.js";

describe("command documentation", () => {
  it("matches the current Commander definitions", async () => {
    const committed = await readFile(
      new URL("../docs/commands.md", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(renderCommandsDoc(createProgram().program));
  });
});
