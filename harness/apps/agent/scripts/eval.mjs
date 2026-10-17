import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The fixture credentials override inherited values, so the evals never use a
// real token. A `NAME=value` script prefix would do the same, but cmd.exe
// cannot run it.
const { status } = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/eve/bin/eve.js", import.meta.url)),
    "eval",
    "--strict",
    "--skip-report",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      GITHUB_TOKEN: "fixture-github-token",
      RIGHTMODELER_AGENT_EVAL: "1",
      RIGHTMODELER_AGENT_FIXTURE_API_KEY: "fixture-api-key",
      GITHUB_WEBHOOK_SECRET: "fixture-webhook-secret",
    },
  },
);
process.exit(status ?? 1);
