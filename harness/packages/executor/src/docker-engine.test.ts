import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectDockerAvailability } from "./index.js";

// A fake docker script on PATH stands in for the engine, so this needs no Docker; on Windows
// only a real docker.exe could stand in.
describe.skipIf(process.platform === "win32")("docker engine check", () => {
  it("refuses an engine that runs Windows containers", async () => {
    const bin = await mkdtemp(join(import.meta.dirname, ".docker-windows-"));
    const previousPath = process.env.PATH;
    try {
      await writeFile(join(bin, "docker"), "#!/bin/sh\necho windows\n", {
        mode: 0o755,
      });
      process.env.PATH = bin;
      await expect(detectDockerAvailability()).resolves.toEqual({
        available: false,
        reason: "daemon-unavailable",
        message: expect.stringContaining(
          "Switch Docker Desktop to Linux containers",
        ),
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(bin, { recursive: true, force: true });
    }
  });
});
