import { writeFile } from "node:fs/promises";
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
} from "./plan-route.js";
import { sameModel } from "./provenance.js";
import { BlockedError, ProviderRequestError } from "./provider.js";

type JsonObject = Record<string, unknown>;

const updateRemedy = "Update with claude update, then rerun.";
const loginRemedy =
  "Run claude auth login, then rerun; finished calls are kept.";
const keyRemedy =
  "Remove the setting that supplies it (an API key helper, an env block in Claude Code settings, or a cloud provider variable), or use an API route with --base-url <url> and --api-key-env <name>.";
const isolation = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--setting-sources",
  "",
  "--no-session-persistence",
];
const settings = ["--settings", '{"switchModelsOnFlag":false}'];
const streamJson = ["--output-format", "stream-json", "--verbose"];
const loginErrors = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
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

function label(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[\w.-]{1,64}$/u.test(value)
    ? value
    : fallback;
}

function resetTime(value: unknown): string | null {
  return typeof value === "number"
    ? new Date(value * 1000).toISOString()
    : null;
}

function count(usage: JsonObject | undefined, key: string): number {
  const value = usage?.[key];
  return typeof value === "number" ? value : 0;
}

function unreportedPayment(): PlanRouteUnavailableError {
  return new PlanRouteUnavailableError(
    "claude did not report how the call was paid for, so this claude version changed a shape rightmodeler relies on.",
    updateRemedy,
  );
}

export const claudeAdapter: PlanAdapter = {
  kind: "claude-login",
  command: "claude",
  minimumVersion: "2.1.282",
  remedies: {
    install:
      "Install Claude Code and sign in with claude auth login, or use an API route with --base-url <url> and --api-key-env <name>.",
    update: updateRemedy,
  },
  keyVariables: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],

  childEnv(stripped) {
    const env: NodeJS.ProcessEnv = {
      ...stripped,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_MAX_RETRIES: "2",
      DISABLE_AUTOUPDATER: "1",
      MAX_THINKING_TOKENS: "0",
    };
    delete env.NODE_OPTIONS;
    return env;
  },

  async checkLogin(run) {
    const result = await run(["auth", "status", "--json"], {
      stdin: "",
      timeoutMs: 30_000,
    });
    const notSignedIn = new PlanLoginError(
      "claude is not signed in on this machine.",
      loginRemedy,
    );
    if (result.code === 1) throw notSignedIn;
    const status = parseLine(result.stdout.trim());
    if (status === undefined) {
      throw new PlanRouteUnavailableError(
        "claude auth status did not print JSON, so this claude version changed a shape rightmodeler relies on.",
        updateRemedy,
      );
    }
    if (status.loggedIn !== true) throw notSignedIn;
    if (Object.hasOwn(status, "apiKeySource")) {
      throw new PlanLoginError(
        `claude would use ${label(status.apiKeySource, "an API key")} instead of your Claude plan login.`,
        keyRemedy,
      );
    }
    if (status.apiProvider !== "firstParty") {
      throw new PlanLoginError(
        `claude is signed in through ${label(status.apiProvider, "another provider")}, not a Claude plan.`,
        keyRemedy,
      );
    }
    if (
      status.authMethod !== "claude.ai" &&
      status.authMethod !== "oauth_token"
    ) {
      throw new PlanLoginError(
        `claude is signed in with ${label(status.authMethod, "another method")}, not a Claude plan login.`,
        keyRemedy,
      );
    }
  },

  async listModels(run) {
    const result = await run(
      [
        "-p",
        "--input-format",
        "stream-json",
        ...streamJson,
        ...isolation,
        ...settings,
      ],
      {
        stdin: `${JSON.stringify({
          type: "control_request",
          request_id: "rightmodeler-models",
          request: { subtype: "initialize" },
        })}\n`,
        timeoutMs: 30_000,
      },
    );
    const answer = result.stdout
      .split("\n")
      .map(parseLine)
      .find(
        (event) =>
          event?.type === "control_response" &&
          object(event.response)?.request_id === "rightmodeler-models",
      );
    const models = object(object(answer?.response)?.response)?.models;
    if (!Array.isArray(models)) {
      throw new PlanRouteUnavailableError(
        "claude's initialize answer has no model list, so this claude version changed a shape rightmodeler relies on.",
        updateRemedy,
      );
    }
    const cliModels = new Set<string>();
    for (const model of models) {
      const value = object(model)?.value;
      const resolvedModel = object(model)?.resolvedModel;
      if (
        typeof resolvedModel !== "string" ||
        resolvedModel.length === 0 ||
        (typeof value === "string" && value.includes("[1m]")) ||
        resolvedModel.includes("[1m]") ||
        resolvedModel.startsWith("claude-fable")
      ) {
        continue;
      }
      cliModels.add(resolvedModel);
    }
    return [...cliModels].map((cliModel) => ({ cliModel }));
  },

  async call(run, input): Promise<PlanCallResult> {
    const systemFile = join(input.dir, "system.txt");
    await writeFile(systemFile, input.system);
    const seen: {
      init?: JsonObject;
      models: string[];
      toolUse: boolean;
      assistantError?: string;
      rateLimit?: JsonObject;
      result?: JsonObject;
    } = { models: [], toolUse: false };
    const outcome = await run(
      [
        "-p",
        "--model",
        input.cliModel,
        "--system-prompt-file",
        systemFile,
        ...isolation,
        "--max-turns",
        "1",
        ...settings,
        ...streamJson,
      ],
      {
        stdin: input.user,
        timeoutMs: input.timeoutMs,
        cwd: input.dir,
        onLine: (line) => {
          const event = parseLine(line);
          if (event?.type === "system" && event.subtype === "init") {
            seen.init ??= event;
            return event.apiKeySource !== "none";
          }
          if (event?.type === "assistant") {
            const message = object(event.message);
            if (
              typeof message?.model === "string" &&
              message.model !== "<synthetic>"
            ) {
              seen.models.push(message.model);
            }
            if (
              Array.isArray(message?.content) &&
              message.content.some(
                (block) => object(block)?.type === "tool_use",
              )
            ) {
              seen.toolUse = true;
            }
            if (typeof event.error === "string") {
              seen.assistantError = event.error;
            }
          }
          if (event?.type === "rate_limit_event") {
            seen.rateLimit = object(event.rate_limit_info) ?? seen.rateLimit;
          }
          if (event?.type === "result") seen.result = event;
          return false;
        },
      },
    );
    const { init, models, toolUse, assistantError, rateLimit, result } = seen;
    const status =
      typeof result?.api_error_status === "number"
        ? result.api_error_status
        : null;
    const failed = (
      error: Extract<PlanCallResult, { ok: false }>["error"],
      excerpt = outcome.stderr,
    ): PlanCallResult => ({ ok: false, error, status, excerpt });

    if (
      rateLimit?.status === "allowed_warning" &&
      typeof rateLimit.utilization === "number"
    ) {
      const resetsAt = resetTime(rateLimit.resetsAt);
      input.warnOnce(
        "plan_usage_warning",
        `claude reports your plan at ${Math.round(rateLimit.utilization * 100)}% of its usage limit${resetsAt === null ? "" : `, resetting at ${resetsAt}`}; rightmodeler stops at the limit, and a rerun after the reset continues.`,
      );
    }
    if (outcome.stopped) {
      return failed(
        init !== undefined && Object.hasOwn(init, "apiKeySource")
          ? new PlanLoginError(
              `claude reported that the call would be paid by ${label(init.apiKeySource, "an API key")}, not your plan, so rightmodeler stopped it.`,
              keyRemedy,
            )
          : unreportedPayment(),
      );
    }
    if (outcome.timedOut) {
      return failed(
        new ProviderRequestError(
          `claude did not answer within ${input.timeoutMs / 1000} s`,
        ),
      );
    }
    const usageLimit =
      rateLimit?.errorCode === "credits_required"
        ? "credits_required"
        : rateLimit?.isUsingOverage === true
          ? "overage"
          : rateLimit?.status === "rejected" || assistantError === "rate_limit"
            ? "rejected"
            : undefined;
    if (usageLimit !== undefined) {
      return failed(
        new BlockedError({
          kind: "usage-limit",
          providerId: "claude-login",
          resetsAt: resetTime(rateLimit?.resetsAt),
          detail: usageLimit,
        }),
      );
    }
    if (assistantError !== undefined && loginErrors.has(assistantError)) {
      return failed(
        new PlanLoginError(
          `claude stopped accepting its login during the run (${assistantError}).`,
          loginRemedy,
        ),
      );
    }
    if (result === undefined) {
      return failed(
        new ProviderRequestError(
          `claude exited with code ${outcome.code} without a result`,
        ),
      );
    }
    if (init === undefined || !Object.hasOwn(init, "apiKeySource")) {
      return failed(unreportedPayment());
    }
    const text = typeof result.result === "string" ? result.result : "";
    if (result.is_error === true) {
      const excerpt = text.slice(0, 300);
      return failed(
        new ProviderRequestError(
          `claude reported ${status ?? String(result.subtype)}: ${excerpt}`,
        ),
        excerpt,
      );
    }
    const modelUsage = Object.entries(object(result.modelUsage) ?? {});
    const served = [
      ...(typeof init.model === "string" ? [init.model] : []),
      ...models,
      ...modelUsage.map(([model]) => model),
    ].find((model) => !sameModel(input.cliModel, model));
    const turns = typeof result.num_turns === "number" ? result.num_turns : 1;
    const substitution: Substitution | undefined =
      served !== undefined
        ? {
            kind: "model",
            evidence: `claude served ${served} for requested ${input.cliModel}`,
          }
        : turns > 1
          ? { kind: "request", evidence: `claude took ${turns} turns` }
          : toolUse
            ? { kind: "request", evidence: "claude called a tool" }
            : undefined;
    return {
      ok: true,
      content: text,
      inputTokens: modelUsage.reduce(
        (total, [, usage]) =>
          total +
          count(object(usage), "inputTokens") +
          count(object(usage), "cacheReadInputTokens") +
          count(object(usage), "cacheCreationInputTokens"),
        0,
      ),
      outputTokens: modelUsage.reduce(
        (total, [, usage]) => total + count(object(usage), "outputTokens"),
        0,
      ),
      ...(modelUsage.length === 1 ? { servedModel: modelUsage[0]![0] } : {}),
      ...(substitution === undefined ? {} : { substitution }),
      ...(typeof result.duration_api_ms === "number"
        ? { latencyMs: result.duration_api_ms }
        : {}),
    };
  },
};

export function createClaudeLoginProvider(
  options: PlanProviderOptions,
): PlanProvider {
  return createPlanProvider(claudeAdapter, options);
}
