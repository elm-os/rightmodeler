import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { detectPlanLogins } from "./plan-logins.js";
import type { StubRecord } from "./test-utils/plan-cli-stub.js";

const fakeBin = fileURLToPath(
  new URL("../../../fixtures/plan-cli-stub/bin", import.meta.url),
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function machine(
  clis: { readonly claude?: "fake" | "unrunnable"; readonly codex?: "fake" },
  extra: NodeJS.ProcessEnv = {},
): Promise<{ env: NodeJS.ProcessEnv; records(): Promise<StubRecord[]> }> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-plan-logins-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "codex-home"));
  await symlink(process.execPath, join(bin, "node"));
  if (clis.codex === "fake") {
    await symlink(join(fakeBin, "codex"), join(bin, "codex"));
  }
  if (clis.claude === "fake") {
    await symlink(join(fakeBin, "claude"), join(bin, "claude"));
  }
  if (clis.claude === "unrunnable") {
    await writeFile(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o644 });
  }
  const record = join(root, "record.jsonl");
  return {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CODEX_HOME: join(root, "codex-home"),
      PLAN_STUB_RECORD: record,
      ...extra,
    },
    async records() {
      const text = await readFile(record, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as StubRecord);
    },
  };
}

describe("detectPlanLogins", () => {
  it("reports each CLI's status in rightmodeler's own words without listing or calling a model", async () => {
    const { env, records } = await machine(
      { claude: "fake", codex: "fake" },
      {
        ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-key",
        OPENAI_API_KEY: "sk-dummy-not-a-key",
        CODEX_API_KEY: "dummy-not-a-key",
      },
    );

    expect(await detectPlanLogins(env)).toEqual([
      {
        kind: "codex-login",
        ready: true,
        line: "codex 0.153.3: signed in with your plan",
      },
      {
        kind: "claude-login",
        ready: true,
        line: "claude 2.1.282: signed in with your plan",
      },
    ]);
    const started = (await records()).filter(({ event }) => event === "start");
    expect(started.map(({ argv }) => argv!.join(" ")).sort()).toEqual([
      "--version",
      "--version",
      '-c cli_auth_credentials_store="file" login status',
      "auth status --json",
    ]);
    for (const { envNames } of started) {
      expect(envNames).not.toContain("ANTHROPIC_API_KEY");
      expect(envNames).not.toContain("OPENAI_API_KEY");
      expect(envNames).not.toContain("CODEX_API_KEY");
    }
  });

  it("reports a missing, signed-out or CI-refused CLI as not ready with its fix", async () => {
    const claudeInstall =
      "Install Claude Code and sign in with claude auth login, or use an API route with --base-url <url> and --api-key-env <name>.";
    const ciRemedy =
      "In continuous integration, use an API route: --base-url <url> and --api-key-env <name>. If this is your own machine, unset CI and rerun.";
    const codexReady = {
      kind: "codex-login",
      ready: true,
      line: "codex 0.153.3: signed in with your plan",
    };
    const cases: Array<{
      readonly name: string;
      readonly clis: Parameters<typeof machine>[0];
      readonly env?: NodeJS.ProcessEnv;
      readonly expected: unknown;
      readonly ranCli: boolean;
    }> = [
      {
        name: "claude missing",
        clis: { codex: "fake" },
        expected: [
          codexReady,
          {
            kind: "claude-login",
            ready: false,
            line: `claude: cannot be used here. ${claudeInstall}`,
          },
        ],
        ranCli: true,
      },
      {
        name: "both signed out",
        clis: { claude: "fake", codex: "fake" },
        env: {
          PLAN_STUB_FAULT: "logged-out",
          PLAN_STUB_CODEX_FAULT: "logged-out",
        },
        expected: [
          {
            kind: "codex-login",
            ready: false,
            line: "codex: not signed in with a plan. Run codex login, then rerun; finished calls are kept.",
          },
          {
            kind: "claude-login",
            ready: false,
            line: "claude: not signed in with a plan. Run claude auth login, then rerun; finished calls are kept.",
          },
        ],
        ranCli: true,
      },
      {
        name: "both too old",
        clis: { claude: "fake", codex: "fake" },
        env: {
          PLAN_STUB_FAULT: "old-version",
          PLAN_STUB_CODEX_FAULT: "old-version",
        },
        expected: [
          {
            kind: "codex-login",
            ready: false,
            line: "codex: cannot be used here. Update with npm install -g @openai/codex@latest, then rerun.",
          },
          {
            kind: "claude-login",
            ready: false,
            line: "claude: cannot be used here. Update with claude update, then rerun.",
          },
        ],
        ranCli: true,
      },
      {
        name: "CI set",
        clis: { claude: "fake", codex: "fake" },
        env: { CI: "true" },
        expected: [
          {
            kind: "codex-login",
            ready: false,
            line: `codex: cannot be used here. ${ciRemedy}`,
          },
          {
            kind: "claude-login",
            ready: false,
            line: `claude: cannot be used here. ${ciRemedy}`,
          },
        ],
        ranCli: false,
      },
      {
        name: "claude cannot start",
        clis: { claude: "unrunnable", codex: "fake" },
        expected: [
          codexReady,
          {
            kind: "claude-login",
            ready: false,
            line: "claude: could not be checked.",
          },
        ],
        ranCli: true,
      },
    ];
    for (const { name, clis, env, expected, ranCli } of cases) {
      const setup = await machine(clis, env);

      expect(await detectPlanLogins(setup.env), name).toEqual(expected);
      expect((await setup.records()).length > 0, name).toBe(ranCli);
    }
  });
});
