import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexLoginProvider } from "./codex-route.js";
import { PlanLoginError, PlanRouteUnavailableError } from "./plan-route.js";
import {
  BlockedError,
  ProviderRequestError,
  type ProviderAttempt,
} from "./provider.js";
import {
  planPriceList,
  turn,
  type StubRecord,
} from "./test-utils/plan-cli-stub.js";

const luna = "openai/gpt-5.6-luna";
const fakeBin = fileURLToPath(
  new URL("../../../fixtures/plan-cli-stub/bin", import.meta.url),
);
const loginRemedy = "Run codex login, then rerun; finished calls are kept.";
const chatgptRemedy = "Sign in with ChatGPT using codex login, then rerun.";
const isolationRemedy =
  "Use a codex version rightmodeler verified (0.153.3 or later), or an API route with --base-url.";
const updateRemedy =
  "Update with npm install -g @openai/codex@latest, then rerun.";
const globalInstructions =
  "Codex adds your global instructions file ($CODEX_HOME/AGENTS.md or AGENTS.override.md) to every call and cannot be told not to; rightmodeler did not read it. Move it aside for this run if it should not shape the replayed answers.";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface CodexHarness {
  readonly root: string;
  readonly codexHome: string;
  readonly provider: ReturnType<typeof createCodexLoginProvider>;
  readonly warnings: Array<{ code: string; message: string }>;
  records(): Promise<StubRecord[]>;
  execs(): Promise<StubRecord[]>;
}

async function codexHarness(
  options: {
    readonly fault?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly path?: string;
    readonly callTimeoutMs?: number;
    readonly agents?: Readonly<Record<string, string>>;
  } = {},
): Promise<CodexHarness> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-codex-harness-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  for (const [name, text] of Object.entries(options.agents ?? {})) {
    await writeFile(join(codexHome, name), text);
    await chmod(join(codexHome, name), 0o000);
  }
  const recordPath = join(root, "record.jsonl");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "CI" &&
        name !== "PLAN_STUB_CODEX_FAULT" &&
        name !== "CODEX_API_KEY" &&
        !name.startsWith("OPENAI_") &&
        !name.startsWith("ANTHROPIC_"),
    ),
  );
  Object.assign(env, {
    PATH: options.path ?? [fakeBin, dirname(process.execPath)].join(delimiter),
    CODEX_HOME: codexHome,
    PLAN_STUB_RECORD: recordPath,
    PLAN_STUB_STATE: join(root, "state"),
    ...(options.fault === undefined
      ? {}
      : { PLAN_STUB_CODEX_FAULT: options.fault }),
    ...options.env,
  });
  const warnings: Array<{ code: string; message: string }> = [];
  const provider = createCodexLoginProvider({
    priceList: planPriceList,
    env,
    callTimeoutMs: options.callTimeoutMs ?? 30_000,
    warning: (code, message) => warnings.push({ code, message }),
  });
  async function records(): Promise<StubRecord[]> {
    let text: string;
    try {
      text = await readFile(recordPath, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as StubRecord & { command?: string })
      .filter(({ command }) => command === "codex");
  }
  return {
    root,
    codexHome,
    provider,
    warnings,
    records,
    execs: async () =>
      (await records()).filter(
        ({ event, argv }) => event === "start" && argv?.[0] === "exec",
      ),
  };
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function overrides(dir: string, store: "file" | "keyring"): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    dir,
    "-m",
    "gpt-5.6-luna",
    "-c",
    `cli_auth_credentials_store="${store}"`,
    "-c",
    `model_instructions_file=${JSON.stringify(join(dir, "instructions.md"))}`,
    "-c",
    "include_permissions_instructions=false",
    "-c",
    "include_apps_instructions=false",
    "-c",
    "include_environment_context=false",
    "-c",
    "include_collaboration_mode_instructions=false",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.unified_exec=false",
    "-c",
    "features.view_image=false",
    "-c",
    "features.image_generation=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.memories=false",
    "-c",
    "features.goals=false",
    "-c",
    "features.tool_suggest=false",
    "-c",
    "features.recommended_plugins=false",
    "-c",
    "features.personality=false",
    "-c",
    "tools.experimental_request_user_input.enabled=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    'history.persistence="none"',
    "-c",
    "features.code_mode_host=false",
    "-o",
    join(dir, "last-message.txt"),
    "-",
  ];
}

describe("codex-login adapter", () => {
  it("passes the verified isolation overrides under --strict-config with an ephemeral, read-only call in an empty temporary directory", async () => {
    const harness = await codexHarness();

    const response = await harness.provider.chat(turn(luna));

    expect(response.content).toBe(`Deterministic reply ${digest("Say lime.")}`);
    const starts = (await harness.records()).filter(
      ({ event }) => event === "start",
    );
    expect(starts.map(({ argv }) => argv)).toEqual([
      ["--version"],
      ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
      ["debug", "models"],
      overrides(starts[3]!.argv![12]!, "file"),
    ]);
    for (const { cwd } of starts) {
      expect(basename(cwd!)).toMatch(/^rightmodeler-plan-/u);
      expect(existsSync(cwd!)).toBe(false);
    }
    expect(basename(starts[3]!.argv![12]!)).toBe(basename(starts[3]!.cwd!));
    const ends = (await harness.records()).filter(
      ({ event }) => event === "end",
    );
    expect(ends.map(({ outcome }) => outcome)).toEqual([
      "version",
      "login-status",
      "models",
      "ok",
    ]);
  });

  it("sends the instructions through model_instructions_file and the one user turn on stdin", async () => {
    const harness = await codexHarness();
    const system = "SYSTEM-MARK-ONE";
    const developer = "DEVELOPER-MARK-TWO";
    const user = "Summarize: the city opened two cooling centers.";

    const response = await harness.provider.chat({
      model: luna,
      messages: [
        { role: "system", content: system },
        { role: "developer", content: developer },
        { role: "user", content: user },
      ],
    });
    const bare = await harness.provider.chat({
      model: luna,
      messages: [{ role: "user", content: "Say ok." }],
    });

    const [call, bareCall] = await harness.execs();
    expect(call?.stdin).toBe(user);
    expect(call?.argv?.join(" ")).not.toContain(system);
    expect(call?.argv?.join(" ")).not.toContain(user);
    expect(call?.argv?.at(-1)).toBe("-");
    expect(response.content).toBe(`Deterministic reply ${digest(user)}`);
    expect(response.usage.inputTokens).toBe(
      Math.ceil(Buffer.byteLength(`${system}\n\n${developer}${user}`) / 4) +
        1800,
    );
    expect(bareCall?.stdin).toBe("Say ok.");
    expect(bare.usage.inputTokens).toBe(
      Math.ceil(Buffer.byteLength("Say ok.") / 4) + 1800,
    );
  });

  it("leaves reasoning effort at each model's default", async () => {
    const harness = await codexHarness();

    await harness.provider.chat(turn(luna));

    const [call] = await harness.execs();
    expect(call?.argv?.length).toBeGreaterThan(0);
    expect(
      call?.argv?.filter((arg) => arg.includes("reasoning_effort")),
    ).toEqual([]);
  });

  it("withholds CODEX_API_KEY and every OPENAI_ and ANTHROPIC_ variable from codex, and names only the codex login variables once", async () => {
    const values = {
      CODEX_API_KEY: "codex-withheld-value",
      OPENAI_API_KEY: "sk-openai-withheld-value",
      OPENAI_BASE_URL: "https://openai.example",
      OPENAI_FEDERATION_RULE_ID: "rule-withheld-value",
      OPENAI_IDENTITY_TOKEN_FILE: "/tmp/identity-withheld-value",
      ANTHROPIC_API_KEY: "sk-ant-withheld-value",
      ANTHROPIC_AUTH_TOKEN: "anthropic-token-withheld-value",
    };
    const harness = await codexHarness({ env: values });

    await harness.provider.chat(turn(luna));
    await harness.provider.chat(turn(luna, "Say plum."));

    const starts = (await harness.records()).filter(
      ({ event }) => event === "start",
    );
    expect(starts.length).toBeGreaterThan(3);
    for (const { envNames } of starts) {
      for (const name of Object.keys(values)) {
        expect(envNames).not.toContain(name);
      }
    }
    expect(harness.warnings).toEqual([
      {
        code: "plan_route_key_withheld",
        message:
          "CODEX_API_KEY, OPENAI_API_KEY, OPENAI_FEDERATION_RULE_ID, OPENAI_IDENTITY_TOKEN_FILE are set; rightmodeler keeps them away from codex so your plan is used, not a key.",
      },
    ]);
  });

  it("keeps CODEX_HOME and CODEX_ACCESS_TOKEN for the child", async () => {
    const harness = await codexHarness({
      env: { CODEX_ACCESS_TOKEN: "plan-token-passed-through" },
    });

    await harness.provider.chat(turn(luna));

    const [call] = await harness.execs();
    expect(call?.envNames).toEqual(
      expect.arrayContaining(["CODEX_ACCESS_TOKEN", "CODEX_HOME"]),
    );
    expect(harness.warnings).toEqual([]);
  });

  it("detects a keyring login and passes that store to every exec", async () => {
    const harness = await codexHarness({ fault: "keyring-only" });

    await harness.provider.chat(turn(luna));
    await harness.provider.chat(turn(luna, "Say plum."));

    const starts = (await harness.records()).filter(
      ({ event }) => event === "start",
    );
    expect(
      starts
        .filter(({ argv }) => argv?.includes("login"))
        .map(({ argv }) => argv),
    ).toEqual([
      ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
      ["login", "status"],
      ["-c", 'cli_auth_credentials_store="keyring"', "login", "status"],
    ]);
    const execs = await harness.execs();
    expect(execs).toHaveLength(2);
    for (const { argv } of execs) {
      expect(argv).toContain('cli_auth_credentials_store="keyring"');
      expect(argv).not.toContain('cli_auth_credentials_store="file"');
    }
  });

  it("refuses a login with an API key, workload identity or Amazon Bedrock before any model call, without printing the masked key", async () => {
    const cases = [
      {
        fault: "api-key-login",
        message:
          "codex is signed in with an API key, which bills API rates, not your ChatGPT plan.",
      },
      {
        fault: "workload-identity-login",
        message:
          "codex is signed in using workload identity, not a ChatGPT plan.",
      },
      {
        fault: "bedrock-login",
        message:
          "codex is signed in using Amazon Bedrock API key, not a ChatGPT plan.",
      },
    ];
    for (const { fault, message } of cases) {
      const harness = await codexHarness({ fault });
      for (const pending of [
        harness.provider.listModels(),
        harness.provider.chat(turn(luna)),
      ]) {
        const error = await rejection(pending);
        expect(error, fault).toBeInstanceOf(PlanLoginError);
        expect(error).toMatchObject({ message, remedy: chatgptRemedy });
        expect(JSON.stringify(error)).not.toMatch(/sk-proj|ABCD/u);
        expect((error as Error).message).not.toMatch(/sk-proj|ABCD/u);
      }
      expect(harness.warnings).toEqual([]);
      expect(await harness.execs()).toEqual([]);
    }
  });

  it("refuses before any model call when codex is older than 0.153.3 or not signed in", async () => {
    const empty = join((await codexHarness()).root, "empty-path");
    await mkdir(empty);
    const cases = [
      {
        harness: await codexHarness({ path: empty }),
        type: PlanRouteUnavailableError,
        message: "codex is not installed or not on PATH.",
        remedy:
          "Install Codex with npm install -g @openai/codex@latest and sign in with codex login, or use an API route with --base-url <url> and --api-key-env <name>.",
      },
      {
        harness: await codexHarness({ fault: "old-version" }),
        type: PlanRouteUnavailableError,
        message:
          "codex 0.150.0 is older than 0.153.3, the version rightmodeler's isolation settings were verified on.",
        remedy: updateRemedy,
      },
      {
        harness: await codexHarness({ fault: "logged-out" }),
        type: PlanLoginError,
        message: "codex is not signed in on this machine.",
        remedy: loginRemedy,
      },
    ];
    for (const { harness, type, message, remedy } of cases) {
      for (const pending of [
        harness.provider.listModels(),
        harness.provider.chat(turn(luna)),
      ]) {
        const error = await rejection(pending);
        expect(error, message).toBeInstanceOf(type);
        expect(error).toMatchObject({ message, remedy });
      }
      expect(await harness.execs()).toEqual([]);
    }
  });

  it("takes the last agent message", async () => {
    const harness = await codexHarness({ fault: "two-messages" });

    const response = await harness.provider.chat(turn(luna));

    expect(response.content).toBe(`Deterministic reply ${digest("Say lime.")}`);
  });

  it("falls back to the -o file when the stream has no agent message", async () => {
    const harness = await codexHarness({ fault: "file-only" });

    const response = await harness.provider.chat(turn(luna));

    expect(response.content).toBe(`Deterministic reply ${digest("Say lime.")}`);
  });

  it("fails a call that exits 0 with no answer", async () => {
    const harness = await codexHarness({ fault: "empty-turn" });
    const attempts: ProviderAttempt[] = [];

    const error = await rejection(
      harness.provider.chat(
        turn(luna, "Say lime.", { onAttempt: (a) => void attempts.push(a) }),
      ),
    );

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as Error).message).toBe("codex returned no answer");
    expect(attempts).toEqual([
      expect.objectContaining({ outcome: "provider_error", costUsd: 0 }),
    ]);
  });

  it("records a model substitution when codex reports a reroute", async () => {
    const harness = await codexHarness({ fault: "rerouted" });

    const response = await harness.provider.chat(turn(luna));

    expect(response.substitution).toEqual({
      kind: "model",
      evidence:
        "codex rerouted: gpt-5.6-luna -> gpt-5.6-sol (HighRiskCyberActivity)",
    });
    expect(response.servedModel).toBeUndefined();
  });

  it("records a request substitution when codex runs a tool during the call", async () => {
    const harness = await codexHarness({ fault: "tool-item" });
    const both = await codexHarness({ fault: "tool-item,rerouted" });

    expect((await harness.provider.chat(turn(luna))).substitution).toEqual({
      kind: "request",
      evidence: "codex ran command_execution during the call",
    });
    expect((await both.provider.chat(turn(luna))).substitution).toMatchObject({
      kind: "model",
    });
  });

  it("stops at an account usage limit, quoting Codex's reset time, and spawns nothing more", async () => {
    const harness = await codexHarness({ fault: "usage-limit-after:1" });

    await harness.provider.chat(turn(luna));
    const limited = await rejection(
      harness.provider.chat(turn(luna, "Say plum.")),
    );
    const later = await rejection(
      harness.provider.chat(turn(luna, "Say fig.")),
    );

    expect(limited).toBeInstanceOf(BlockedError);
    expect(limited).toMatchObject({
      kind: "usage-limit",
      providerId: "codex-login",
      resetsAt: "3:45 PM",
      message:
        "codex-login reached its plan's usage limit (resets 3:45 PM): You've hit your usage limit. Try again at 3:45 PM.",
    });
    expect(later).toBe(limited);
    expect(await harness.execs()).toHaveLength(2);
  });

  it("treats a limit on one model as a rate limit, so the judge can fail over", async () => {
    const harness = await codexHarness({ fault: "model-limit:first" });

    const first = await rejection(harness.provider.chat(turn(luna)));
    const again = await rejection(
      harness.provider.chat(turn(luna, "Say plum.")),
    );
    const other = await harness.provider.chat(turn("openai/gpt-5.6-sol"));

    for (const error of [first, again]) {
      expect(error).toBeInstanceOf(BlockedError);
      expect(error).toMatchObject({ kind: "rate-limit", observedCeiling: 2 });
    }
    expect(other.content).toBe(`Deterministic reply ${digest("Say lime.")}`);
    expect(await harness.execs()).toHaveLength(3);
  });

  it("maps capacity and demand messages to a rate limit", async () => {
    const harness = await codexHarness({ fault: "capacity" });

    const error = await rejection(harness.provider.chat(turn(luna)));

    expect(error).toBeInstanceOf(BlockedError);
    expect(error).toMatchObject({ kind: "rate-limit", observedCeiling: 2 });
  });

  it("reports a model this plan cannot use as a lost request", async () => {
    const harness = await codexHarness({ fault: "bad-model" });

    const error = await rejection(harness.provider.chat(turn(luna)));

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as Error).message).toBe(
      "codex cannot use gpt-5.6-luna on this plan",
    );
  });

  it("maps a 401 during a call to plan_login_required", async () => {
    const harness = await codexHarness({ fault: "auth-failed" });

    const error = await rejection(harness.provider.chat(turn(luna)));
    const later = await rejection(
      harness.provider.chat(turn(luna, "Say plum.")),
    );

    expect(error).toBeInstanceOf(PlanLoginError);
    expect(error).toMatchObject({
      message: "codex stopped accepting its login during the run.",
      remedy: loginRemedy,
    });
    expect(later).toBe(error);
    expect(await harness.execs()).toHaveLength(1);
  });

  it("names a rejected isolation setting or flag as plan_cli_unavailable", async () => {
    for (const [fault, setting] of [
      ["strict-config", "features.shell_tool"],
      ["bad-flag", "--ignore-rules"],
    ] as const) {
      const harness = await codexHarness({ fault });

      const error = await rejection(harness.provider.chat(turn(luna)));

      expect(error, fault).toBeInstanceOf(PlanRouteUnavailableError);
      expect(error).toMatchObject({
        message: `this codex version rejects rightmodeler's isolation setting ${setting}`,
        remedy: isolationRemedy,
      });
    }
  });

  it("lists callable models from codex debug models: listed only, priced, with codex's context, without a model call", async () => {
    const harness = await codexHarness();

    const callable = await harness.provider.listModels();
    const known = await harness.provider.knownModels();

    expect(callable.map(({ id }) => id)).toEqual([
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
    ]);
    for (const entry of callable) {
      expect(entry).toMatchObject({
        family: "openai",
        contextLength: 272_000,
        supportsTools: false,
        supportsStructuredOutput: false,
      });
      expect(entry.pricing).not.toBeNull();
    }
    expect(known).toHaveLength(17);
    expect(harness.warnings).toEqual([]);
    expect(await harness.execs()).toEqual([]);
  });

  it("stops with plan_cli_unavailable when codex debug models changes shape", async () => {
    const harness = await codexHarness({ fault: "bad-models" });

    const error = await rejection(harness.provider.listModels());

    expect(error).toBeInstanceOf(PlanRouteUnavailableError);
    expect(error).toMatchObject({
      message:
        "codex debug models printed a model list rightmodeler cannot read (codex-cli 0.153.3).",
      remedy: updateRemedy,
    });
  });

  it("discloses a global AGENTS.md once without reading it", async () => {
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      const harness = await codexHarness({
        agents: { [name]: "GLOBAL-INSTRUCTIONS-SENTINEL" },
      });

      await harness.provider.listModels();
      await harness.provider.chat(turn(luna));
      await harness.provider.chat(turn(luna, "Say plum."));

      expect(harness.warnings, name).toEqual([
        { code: "codex_global_instructions", message: globalInstructions },
      ]);
      expect(JSON.stringify(harness.warnings)).not.toContain(harness.codexHome);
    }
  });

  it("never records latency for a codex call", async () => {
    const harness = await codexHarness();
    const attempts: ProviderAttempt[] = [];

    const response = await harness.provider.chat(
      turn(luna, "Say lime.", { onAttempt: (a) => void attempts.push(a) }),
    );

    expect(response.costIsEstimate).toBe(true);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: "completed" });
    expect(attempts[0]).not.toHaveProperty("latencyMs");
  });

  it("kills a codex call that outlives its timeout and reports it as a lost request", async () => {
    const harness = await codexHarness({
      fault: "hang",
      callTimeoutMs: 1_000,
    });
    const started = Date.now();

    const error = await rejection(harness.provider.chat(turn(luna)));

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as Error).message).toBe("codex did not answer within 1 s");
    expect(Date.now() - started).toBeLessThan(8_000);
    const [call] = await harness.execs();
    expect(alive(call!.pid)).toBe(false);
  }, 20_000);
});
