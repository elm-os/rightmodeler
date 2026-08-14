import { defineConfig } from "vitest/config";

// Confirmation and stream-parser tests run real subprocesses and containers; on two-core CI
// runners under full-graph parallelism they can exceed vitest's five-second default.
export default defineConfig({
  test: { testTimeout: 30_000 },
});
