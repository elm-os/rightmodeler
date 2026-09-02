import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { executeCli } from "./cli.js";
import type { CliIo } from "./protocol.js";
import { version } from "./version.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("rightmodeler package", () => {
  it("exports and reports its package version", async () => {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    };

    expect(version).toBe(manifest.version);
    expect(await executeCli(["--version"], io)).toBe(0);
    expect(stdout.trim()).toBe(manifest.version);
    expect(stderr).toBe("");
  });
});
