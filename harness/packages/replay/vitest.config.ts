import { defineConfig } from "vitest/config";

// Suites here run real subprocesses and containers. The timeout is a hang guard only, sized
// so even very slow machines are never failed for taking their time.
export default defineConfig({
  test: { testTimeout: 120_000 },
});
