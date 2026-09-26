import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Substitution } from "@rightmodeler/core";

import {
  createPlanProvider,
  PlanLoginError,
  PlanRouteUnavailableError,
  type PlanAdapter,
  type PlanCallResult,
  type PlanProvider,
  type PlanProviderOptions,
  type RunCli,
} from "./plan-route.js";
import { BlockedError, ProviderRequestError } from "./provider.js";

type JsonObject = Record<string, unknown>;

const updateRemedy =
  "Update with npm install -g @openai/codex@latest, then rerun.";
const loginRemedy = "Run codex login, then rerun; finished calls are kept.";
const chatgptRemedy = "Sign in with ChatGPT using codex login, then rerun.";
const isolationRemedy =
  "Use a codex version rightmodeler verified (0.153.3 or later), or an API route with --base-url.";
const overrides = [
  "include_permissions_instructions=false",
  "include_apps_instructions=false",
  "include_environment_context=false",
  "include_collaboration_mode_instructions=false",
  "skills.include_instructions=false",
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  "features.image_generation=false",
  "features.multi_agent=false",
  "features.apps=false",
  "features.plugins=false",
  "features.memories=false",
  "features.goals=false",
  "features.tool_suggest=false",
  "features.recommended_plugins=false",
  "features.personality=false",
  "tools.experimental_request_user_input.enabled=false",
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  'history.persistence="none"',
  "features.code_mode_host=false",
].flatMap((setting) => ["-c", setting]);
const toolItems = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "collab_tool_call",
]);

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseLine(line: string): JsonObject | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function planLogin(output: string): boolean {
  return /^Logged in using (ChatGPT|access token|personal access token)$/mu.test(
    output,
  );
}

function refuseOtherLogin(output: string): void {
  if (/^Logged in using an API key/mu.test(output)) {
    throw new PlanLoginError(
      "codex is signed in with an API key, which bills API rates, not your ChatGPT plan.",
      chatgptRemedy,
    );
  }
  const kind = /^Logged in using (.+)$/mu.exec(output)?.[1]?.split(" - ")[0];
  if (kind !== undefined && !planLogin(output)) {
    throw new PlanLoginError(
      `codex is signed in using ${kind}, not a ChatGPT plan.`,
      chatgptRemedy,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function failure(
  message: string,
  cliModel: string,
  maxConcurrency: number,
): Extract<PlanCallResult, { ok: false }>["error"] {
  if (/You've hit your usage limit for /u.test(message)) {
    return new BlockedError({
      kind: "rate-limit",
      status: 429,
      observedCeiling: maxConcurrency,
    });
  }
  if (/You've hit your usage limit|out of credits|spend cap/u.test(message)) {
    return new BlockedError({
      kind: "usage-limit",
      providerId: "codex-login",
      resetsAt: /try again at ([^.]+)\./iu.exec(message)?.[1] ?? null,
      detail: message,
    });
  }
  if (
    /at capacity|high demand|exceeded retry limit|rate limit exceeded/iu.test(
      message,
    )
  ) {
    return new BlockedError({
      kind: "rate-limit",
      status: 429,
      observedCeiling: maxConcurrency,
    });
  }
  if (
    /401 Unauthorized|Missing bearer|invalid_api_key|upgrade to Plus/u.test(
      message,
    )
  ) {
    return new PlanLoginError(
      "codex stopped accepting its login during the run.",
      loginRemedy,
    );
  }
  if (/not supported when using Codex with a ChatGPT account/u.test(message)) {
    return new ProviderRequestError(
      `codex cannot use ${cliModel} on this plan`,
    );
  }
  return new ProviderRequestError(`codex reported: ${message.slice(0, 300)}`);
}

function createCodexAdapter(options: PlanProviderOptions): PlanAdapter {
  const env = options.env ?? process.env;
  let store: "file" | "keyring" = "file";

  async function loginStatus(
    run: RunCli,
    storeName?: "file" | "keyring",
  ): Promise<{ code: number | null; output: string }> {
    const result = await run(
      [
        ...(storeName === undefined
          ? []
          : ["-c", `cli_auth_credentials_store="${storeName}"`]),
        "login",
        "status",
      ],
      { stdin: "", timeoutMs: 30_000 },
    );
    refuseOtherLogin(`${result.stdout}\n${result.stderr}`);
    return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
  }

  return {
    kind: "codex-login",
    command: "codex",
    minimumVersion: "0.153.3",
    remedies: {
      install:
        "Install Codex with npm install -g @openai/codex@latest and sign in with codex login, or use an API route with --base-url <url> and --api-key-env <name>.",
      update: updateRemedy,
    },
    keyVariables: [
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_FEDERATION_RULE_ID",
      "OPENAI_IDENTITY_TOKEN_FILE",
    ],

    childEnv(stripped) {
      return stripped;
    },

    async checkLogin(run) {
      const file = await loginStatus(run, "file");
      if (file.code === 0 && planLogin(file.output)) {
        store = "file";
      } else {
        const plain = await loginStatus(run);
        if (plain.code === 1 || /^Not logged in/mu.test(plain.output)) {
          throw new PlanLoginError(
            "codex is not signed in on this machine.",
            loginRemedy,
          );
        }
        const keyring = await loginStatus(run, "keyring");
        if (keyring.code !== 0 || !planLogin(keyring.output)) {
          throw new PlanLoginError(
            "codex reports a login, but rightmodeler could not use it from the file or keyring credential store.",
            "Run codex login, then rerun.",
          );
        }
        store = "keyring";
      }
      const home = env.CODEX_HOME ?? join(homedir(), ".codex");
      if (
        (await exists(join(home, "AGENTS.override.md"))) ||
        (await exists(join(home, "AGENTS.md")))
      ) {
        options.warning?.(
          "codex_global_instructions",
          "Codex adds your global instructions file ($CODEX_HOME/AGENTS.md or AGENTS.override.md) to every call and cannot be told not to; rightmodeler did not read it. Move it aside for this run if it should not shape the replayed answers.",
        );
      }
    },

    async listModels(run) {
      const result = await run(["debug", "models"], {
        stdin: "",
        timeoutMs: 30_000,
      });
      const models = parseLine(result.stdout.trim())?.models;
      if (
        !Array.isArray(models) ||
        !models.every(
          (model) =>
            typeof object(model)?.slug === "string" &&
            typeof object(model)?.visibility === "string",
        )
      ) {
        const version = (
          await run(["--version"], { stdin: "", timeoutMs: 30_000 })
        ).stdout.trim();
        throw new PlanRouteUnavailableError(
          `codex debug models printed a model list rightmodeler cannot read (${version}).`,
          updateRemedy,
        );
      }
      return models.flatMap((model) => {
        const entry = object(model)!;
        if (entry.visibility !== "list") return [];
        return [
          {
            cliModel: entry.slug as string,
            ...(typeof entry.context_window === "number"
              ? { contextWindow: entry.context_window }
              : {}),
          },
        ];
      });
    },

    async call(run, input): Promise<PlanCallResult> {
      const instructions = join(input.dir, "instructions.md");
      const lastMessage = join(input.dir, "last-message.txt");
      const hasInstructions = input.system.trim().length > 0;
      if (hasInstructions) await writeFile(instructions, input.system);
      const outcome = await run(
        [
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
          input.dir,
          "-m",
          input.cliModel,
          "-c",
          `cli_auth_credentials_store="${store}"`,
          "-c",
          hasInstructions
            ? `model_instructions_file=${JSON.stringify(instructions)}`
            : 'instructions=""',
          ...overrides,
          "-o",
          lastMessage,
          "-",
        ],
        { stdin: input.user, timeoutMs: input.timeoutMs, cwd: input.dir },
      );
      const failed = (
        error: Extract<PlanCallResult, { ok: false }>["error"],
        excerpt = outcome.stderr,
      ): PlanCallResult => ({ ok: false, error, status: null, excerpt });

      const rejected =
        /unknown configuration field `([^`]+)`/u.exec(outcome.stderr)?.[1] ??
        /unexpected argument '([^']+)'/u.exec(outcome.stderr)?.[1];
      if (rejected !== undefined) {
        return failed(
          new PlanRouteUnavailableError(
            `this codex version rejects rightmodeler's isolation setting ${rejected}`,
            isolationRemedy,
          ),
        );
      }
      if (outcome.timedOut) {
        return failed(
          new ProviderRequestError(
            `codex did not answer within ${input.timeoutMs / 1000} s`,
          ),
        );
      }
      const events = outcome.stdout
        .split("\n")
        .map(parseLine)
        .filter((event) => event !== undefined);
      const turnFailed = events.find(({ type }) => type === "turn.failed");
      if (turnFailed !== undefined) {
        const message = String(object(turnFailed.error)?.message ?? "");
        return failed(
          failure(message, input.cliModel, options.maxConcurrency ?? 2),
          message.slice(0, 300),
        );
      }
      if (outcome.code !== 0) {
        return failed(
          new ProviderRequestError(
            `codex exited ${outcome.code}: ${outcome.stderr.trim().slice(0, 300)}`,
          ),
        );
      }
      const items = events.flatMap(({ type, item }) =>
        type === "item.completed" && object(item) !== undefined
          ? [object(item)!]
          : [],
      );
      const content =
        items.filter(({ type }) => type === "agent_message").at(-1)?.text ??
        (await readFile(lastMessage, "utf8").catch(() => ""));
      if (typeof content !== "string" || content.length === 0) {
        return failed(new ProviderRequestError("codex returned no answer"));
      }
      const usage = object(
        events.find(({ type }) => type === "turn.completed")?.usage,
      );
      if (
        typeof usage?.input_tokens !== "number" ||
        typeof usage.output_tokens !== "number"
      ) {
        return failed(
          new ProviderRequestError("codex ended without completing the turn"),
        );
      }
      const rerouted = items.find(
        ({ type, message }) =>
          type === "error" &&
          typeof message === "string" &&
          message.startsWith("model rerouted:"),
      );
      const tool = items.find(({ type }) => toolItems.has(String(type)));
      const substitution: Substitution | undefined =
        rerouted !== undefined
          ? {
              kind: "model",
              evidence: `codex rerouted: ${String(rerouted.message).slice("model rerouted:".length).trim()}`,
            }
          : tool !== undefined
            ? {
                kind: "request",
                evidence: `codex ran ${String(tool.type)} during the call`,
              }
            : undefined;
      return {
        ok: true,
        content,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(substitution === undefined ? {} : { substitution }),
      };
    },
  };
}

export function createCodexLoginProvider(
  options: PlanProviderOptions,
): PlanProvider {
  return createPlanProvider(createCodexAdapter(options), options);
}
