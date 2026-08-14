import { defineConfig } from "vitest/config";

// The e2e, runbook, and bundle suites spawn the built CLI and whole stub-backed pipelines; on
// two-core CI runners under full-graph parallelism they can exceed vitest's five-second default.
export default defineConfig({
  test: { testTimeout: 60_000 },
});
