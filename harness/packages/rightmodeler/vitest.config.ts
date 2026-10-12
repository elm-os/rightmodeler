import { defineConfig } from "vitest/config";

// The e2e, runbook, and bundle suites spawn the built CLI and whole stub-backed pipelines. The
// timeouts are hang guards only, sized so even very slow machines are never failed for taking
// their time. Hooks get the same guard as tests: the e2e file's afterAll removes every fixture
// directory the file created, which outlasts the 10 s hook default on a loaded machine.
export default defineConfig({
  test: { testTimeout: 240_000, hookTimeout: 240_000 },
});
