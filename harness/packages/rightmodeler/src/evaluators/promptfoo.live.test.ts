import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createPromptfooEvaluator } from "./promptfoo.js";

const livePromptfoo = process.env.RIGHTMODELER_LIVE_PROMPTFOO;
if (livePromptfoo === undefined) {
  console.warn(
    "[promptfoo live] SKIPPED: set RIGHTMODELER_LIVE_PROMPTFOO to a promptfoo executable",
  );
}
const fixtureAssertionsPath = fileURLToPath(
  new URL(
    "../../../../fixtures/promptfoo-stub/assertions.yaml",
    import.meta.url,
  ),
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(livePromptfoo === undefined)("promptfoo live", () => {
  it("grades with the real promptfoo CLI despite the caller's own promptfoo settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-promptfoo-live-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "assertions"));
    const assertionsPath = join(root, "assertions", "assertions.yaml");
    await copyFile(fixtureAssertionsPath, assertionsPath);
    vi.stubEnv("PROMPTFOO_CONFIG_DIR", join(root, "promptfoo-config"));
    vi.stubEnv("PROMPTFOO_FAILED_TEST_EXIT_CODE", "1");
    vi.stubEnv("PROMPTFOO_STRIP_GRADING_RESULT", "true");
    vi.stubEnv("PROMPTFOO_STRIP_RESPONSE_OUTPUT", "true");
    vi.stubEnv("PROMPTFOO_STRIP_TEST_VARS", "true");
    vi.stubEnv("PROMPTFOO_DISABLE_VAR_EXPANSION", "false");
    vi.stubEnv("PROMPTFOO_SHORT_CIRCUIT_TEST_FAILURES", "true");
    const version = execFileSync(livePromptfoo!, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PROMPTFOO_DISABLE_UPDATE: "true" },
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1)!;
    const provider = createPromptfooEvaluator({
      command: livePromptfoo!,
      assertionsPath,
      scorers: ["output_similarity", "secondary_similarity"],
      gateMetric: "output_similarity",
    });

    expect(await provider.detectAvailability()).toBe(true);
    const { providerRunId } = await provider.launch({
      experimentName: "promptfoo-live",
      cases: [
        "Paris",
        "Parish",
        "Paris\n",
        "{{ 7 * 7 }}",
        "file://rightmodeler-live-missing.txt",
      ].map((output, index) => ({
        caseId: `live-${index + 1}`,
        input: { prompt: "capital" },
        expected: "Paris",
        output,
      })),
    });
    expect(await provider.status(providerRunId)).toBe("complete");
    const results = await provider.collect(providerRunId);

    expect(results.map(({ caseId }) => caseId)).toEqual([
      "live-1",
      "live-2",
      "live-3",
      "live-4",
      "live-5",
    ]);
    const [first, second, third, fourth, fifth] = results;
    for (const graded of [first, third]) {
      expect(graded).not.toHaveProperty("absentReason");
      expect(
        graded?.metrics.map(({ metricName, passed }) => [metricName, passed]),
      ).toEqual([
        ["output_similarity", true],
        ["secondary_similarity", true],
      ]);
    }
    expect(second).not.toHaveProperty("absentReason");
    expect(second?.metrics).toEqual([
      expect.objectContaining({
        metricName: "output_similarity",
        score: 0,
        passed: false,
      }),
      expect.objectContaining({
        metricName: "secondary_similarity",
        passed: true,
      }),
    ]);
    expect(fourth).toMatchObject({
      metrics: [],
      absentReason: "external_output_mismatch",
    });
    expect(fifth).toMatchObject({
      metrics: [],
      absentReason: "external_evaluator_error",
    });
    const rubricVersions = results.flatMap(({ metrics }) =>
      metrics.map(({ rubricVersion }) => rubricVersion),
    );
    expect(rubricVersions.length).toBeGreaterThan(0);
    for (const rubricVersion of rubricVersions) {
      expect(rubricVersion?.startsWith(`promptfoo@${version}/`)).toBe(true);
      expect(rubricVersion).toMatch(
        /\/(output|secondary)_similarity\/[0-9a-f]{16}$/u,
      );
    }
    expect(readdirSync(join(root, "assertions"))).toEqual(["assertions.yaml"]);
  }, 120_000);
});
