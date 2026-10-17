import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "./cli.js";
import { renderCommandsDoc } from "./commands-doc.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command documentation", () => {
  it("matches the current Commander definitions", async () => {
    const committed = await readFile(
      new URL("../docs/commands.md", import.meta.url),
      "utf8",
    );

    expect(committed).toBe(renderCommandsDoc(createProgram().program));
  });

  it.each([
    "C:\\Users\\John Smith\\rightmodeler\\harness\\packages\\rightmodeler",
    "/r",
  ])("renders the same from %s", (cwd) => {
    const expected = renderCommandsDoc(createProgram().program);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    expect(renderCommandsDoc(createProgram().program)).toBe(expected);
  });
});
