import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, vi } from "vitest";

import { createPromptfooEvaluator } from "./promptfoo.js";

const stubPath = fileURLToPath(
  new URL("../../../../fixtures/promptfoo-stub/run.mjs", import.meta.url),
);
const assertionsPath = fileURLToPath(
  new URL(
    "../../../../fixtures/promptfoo-stub/assertions.yaml",
    import.meta.url,
  ),
);

// promptfoo reads the model outputs from a path relative to its working directory, and Windows
// has no relative path from one drive to another. CI keeps TEMP on the workspace's drive, so this
// test rebuilds the split layout explicitly: Windows' default TEMP on the system drive, the
// assertions in a checkout on another drive. It skips when both are on one drive. The default
// TEMP comes from the home directory because turbo's strict environment mode drops LOCALAPPDATA.
const systemTemp = join(homedir(), "AppData", "Local", "Temp");
const crossDrive =
  process.platform === "win32" &&
  win32.parse(systemTemp).root.toLowerCase() !==
    win32.parse(assertionsPath).root.toLowerCase();

it.skipIf(!crossDrive)(
  "on Windows, keeps the model outputs on the assertions' drive when TEMP is on another drive",
  async () => {
    const temp = await mkdtemp(
      join(systemTemp, "rightmodeler-promptfoo-cross-drive-"),
    );
    const recordPath = join(temp, "record.json");
    vi.stubEnv("TEMP", temp);
    vi.stubEnv("TMP", temp);
    vi.stubEnv("PROMPTFOO_STUB_RECORD", recordPath);
    try {
      const provider = createPromptfooEvaluator({
        command: stubPath,
        assertionsPath,
        scorers: ["output_similarity"],
      });

      const { providerRunId } = await provider.launch({
        experimentName: "cross-drive",
        cases: ["Paris", "Parish"].map((output, index) => ({
          caseId: `execution-${index + 1}`,
          input: { prompt: "capital" },
          expected: "Paris",
          output,
        })),
      });

      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        argv: string[];
        cwd: string;
      };
      const cwd = await realpath(dirname(assertionsPath));
      const modelOutputs =
        record.argv[record.argv.indexOf("--model-outputs") + 1]!;
      expect(record.cwd).toBe(cwd);
      expect(isAbsolute(modelOutputs)).toBe(false);
      expect(
        resolve(cwd, modelOutputs).startsWith(join(cwd, ".rightmodeler") + sep),
      ).toBe(true);
      await expect(
        stat(dirname(resolve(cwd, modelOutputs))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await readdir(temp)).filter((name) =>
          name.startsWith("rightmodeler-promptfoo-"),
        ),
      ).toEqual([]);
      expect(await provider.collect(providerRunId)).toEqual([
        expect.objectContaining({
          caseId: "execution-1",
          metrics: [
            expect.objectContaining({
              metricName: "output_similarity",
              passed: true,
            }),
          ],
        }),
        expect.objectContaining({
          caseId: "execution-2",
          metrics: [
            expect.objectContaining({
              metricName: "output_similarity",
              passed: false,
            }),
          ],
        }),
      ]);
    } finally {
      vi.unstubAllEnvs();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
