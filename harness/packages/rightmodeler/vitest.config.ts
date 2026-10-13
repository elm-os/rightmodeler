import { defineConfig } from "vitest/config";

// The e2e, runbook, and bundle suites spawn the built CLI and whole stub-backed pipelines, so
// both timeouts are hang guards only. Under load the e2e cleanup hook outlasts the 10 s default.
export default defineConfig({
  test: { testTimeout: 240_000, hookTimeout: 240_000 },
});
