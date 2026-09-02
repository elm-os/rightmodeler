import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
const pipelineSource = readFileSync(
  new URL("./pipeline.ts", import.meta.url),
  "utf8",
);
const exitCodes = readFileSync(
  new URL("../docs/exit-codes.md", import.meta.url),
  "utf8",
);
const protocolErrorPattern =
  /new ProtocolError\(\{\s*exitCode:\s*\d+,\s*code:\s*"([a-z_]+)"/gu;
const protocolCodes = new Set(
  [cliSource, pipelineSource].flatMap((source) =>
    [...source.matchAll(protocolErrorPattern)].map((match) => match[1]!),
  ),
);

describe("protocol error documentation", () => {
  it("extracts the current ProtocolError code floor", () => {
    expect(protocolCodes.size).toBeGreaterThanOrEqual(20);
  });

  it("documents every ProtocolError code", () => {
    for (const code of protocolCodes) {
      expect(exitCodes, code).toContain(`\`${code}\``);
    }
  });
});
