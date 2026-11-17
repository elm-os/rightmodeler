import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

// With no duration cache, as on CI, vitest starts the largest files first. The Docker Mode B file
// is small but is the slowest file on Linux, so it starts first and the other files run beside it.
class ModeBFirstSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const isModeB = (file: TestSpecification) =>
      file.moduleId.endsWith("e2e-modeb.test.ts");
    return [
      ...sorted.filter(isModeB),
      ...sorted.filter((file) => !isModeB(file)),
    ];
  }
}

// The e2e, runbook, and bundle suites spawn the built CLI and whole stub-backed pipelines, so
// both timeouts are hang guards only. Under load the e2e cleanup hook outlasts the 10 s default.
export default defineConfig({
  test: {
    testTimeout: 240_000,
    hookTimeout: 240_000,
    sequence: { sequencer: ModeBFirstSequencer },
  },
});
