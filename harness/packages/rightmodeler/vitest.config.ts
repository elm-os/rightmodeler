import { defineConfig } from "vitest/config";

// The e2e, runbook, and bundle suites spawn the built CLI and whole stub-backed pipelines. The
// timeout is a hang guard only, sized so even very slow machines are never failed for taking
// their time.
export default defineConfig({
  test: { testTimeout: 240_000 },
});
