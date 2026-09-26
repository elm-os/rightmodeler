import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalModelName,
  isRecord,
  type JsonValue,
  type Substitution,
} from "@rightmodeler/core";

import {
  AdaptiveLimiter,
  BlockedError,
  estimateInputTokens,
  isUsageLimit,
  ProviderConfigurationError,
  ProviderRequestError,
  readModelList,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type CreateProviderOptions,
  type ModelCatalogEntry,
  type ProviderClient,
} from "./provider.js";

export const planRouteVendors = {
  "claude-login": "anthropic",
  "codex-login": "openai",
} as const;
export type PlanRouteKind = keyof typeof planRouteVendors;

export function isPlanRouteKind(value: string): value is PlanRouteKind {
  return Object.hasOwn(planRouteVendors, value);
}

export class PlanRouteUnavailableError extends ProviderConfigurationError {
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = "PlanRouteUnavailableError";
    this.remedy = remedy;
  }
}

export class PlanLoginError extends ProviderConfigurationError {
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.name = "PlanLoginError";
    this.remedy = remedy;
  }
}

export interface PlanProviderOptions {
  readonly priceList: string;
  readonly pricingOverrides?: CreateProviderOptions["pricingOverrides"];
  readonly maxConcurrency?: number;
  readonly warning?: (code: string, message: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly withhold?: readonly string[];
  readonly callTimeoutMs?: number;
}

export interface PlanProvider extends ProviderClient {
  knownModels(): Promise<ModelCatalogEntry[]>;
}

export interface RunCliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stopped: boolean;
}

export type RunCli = (
  args: readonly string[],
  options: {
    readonly stdin: string;
    readonly timeoutMs: number;
    readonly cwd?: string;
    readonly onLine?: (line: string) => boolean;
  },
) => Promise<RunCliResult>;

export type PlanCallResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly servedModel?: string;
      readonly substitution?: Substitution;
      readonly latencyMs?: number;
    }
  | {
      readonly ok: false;
      readonly error:
        | BlockedError
        | PlanLoginError
        | PlanRouteUnavailableError
        | ProviderRequestError;
      readonly status: number | null;
      readonly excerpt: string;
    };

export interface PlanAdapter {
  readonly kind: PlanRouteKind;
  readonly command: string;
  readonly minimumVersion: string;
  readonly remedies: { readonly install: string; readonly update: string };
  readonly keyVariables: readonly string[];
  childEnv(stripped: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  checkLogin(run: RunCli): Promise<void>;
  listModels(
    run: RunCli,
  ): Promise<
    Array<{ readonly cliModel: string; readonly contextWindow?: number }>
  >;
  call(
    run: RunCli,
    input: {
      readonly cliModel: string;
      readonly system: string;
      readonly user: string;
      readonly dir: string;
      readonly timeoutMs: number;
      readonly warnOnce: (code: string, message: string) => void;
      readonly outputSchema?: string;
    },
  ): Promise<PlanCallResult>;
}

const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const running = new Set<ChildProcess>();
let exitHookRegistered = false;

export function stopPlanChildren(): void {
  for (const child of running) child.kill("SIGKILL");
}

export function isSingleTurn(messages: readonly ChatMessage[]): boolean {
  const last = messages.length - 1;
  return (
    last >= 0 &&
    messages[last]!.role === "user" &&
    messages
      .slice(0, last)
      .every(({ role }) => role === "system" || role === "developer")
  );
}

function withheldFromChild(name: string): boolean {
  return (
    name.startsWith("ANTHROPIC_") ||
    name.startsWith("OPENAI_") ||
    name === "CODEX_API_KEY" ||
    name === "CLAUDECODE" ||
    name === "CLAUDE_PID" ||
    name === "CLAUDE_EFFORT" ||
    (name.startsWith("CLAUDE_CODE_") && name !== "CLAUDE_CODE_OAUTH_TOKEN")
  );
}

function outputSchema(format: JsonValue | undefined): string | undefined {
  if (!isRecord(format) || format.type !== "json_schema") return undefined;
  const schema = isRecord(format.json_schema)
    ? format.json_schema.schema
    : undefined;
  return isRecord(schema) ? JSON.stringify(schema) : undefined;
}

function versionAtLeast(version: string, minimum: string): boolean {
  const have = version.split(".").map(Number);
  const want = minimum.split(".").map(Number);
  for (const [index, part] of want.entries()) {
    if (have[index] !== part) return have[index]! > part;
  }
  return true;
}

function runner(
  command: string,
  env: NodeJS.ProcessEnv,
  installRemedy: string,
): RunCli {
  return async (args, options) => {
    const cwd =
      options.cwd ?? (await mkdtemp(join(tmpdir(), "rightmodeler-plan-")));
    try {
      return await new Promise<RunCliResult>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        running.add(child);
        if (!exitHookRegistered) {
          exitHookRegistered = true;
          process.once("exit", stopPlanChildren);
        }
        let stdout = "";
        let stderr = "";
        let pending = "";
        let bytes = 0;
        let timedOut = false;
        let stopped = false;
        let overflowed = false;
        let spawnError: NodeJS.ErrnoException | undefined;
        let forceKill: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, options.timeoutMs);
        const readLine = (line: string): void => {
          if (!stopped && options.onLine?.(line) === true) {
            stopped = true;
            child.kill("SIGKILL");
          }
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_STDOUT_BYTES) {
            overflowed = true;
            child.kill("SIGKILL");
            return;
          }
          stdout += chunk;
          pending += chunk;
          for (
            let newline = pending.indexOf("\n");
            newline !== -1;
            newline = pending.indexOf("\n")
          ) {
            readLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          if (stderr.length < 500) stderr += chunk;
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin);
        child.once("error", (error: NodeJS.ErrnoException) => {
          spawnError = error;
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          clearTimeout(forceKill);
          running.delete(child);
          if (pending.length > 0) readLine(pending);
          if (spawnError !== undefined) {
            reject(
              spawnError.code === "ENOENT"
                ? new PlanRouteUnavailableError(
                    `${command} is not installed or not on PATH.`,
                    installRemedy,
                  )
                : new ProviderRequestError(
                    `${command} could not start: ${spawnError.message}`,
                  ),
            );
            return;
          }
          if (overflowed) {
            reject(
              new ProviderRequestError(`${command} printed more than 32 MiB`),
            );
            return;
          }
          resolve({
            code,
            stdout,
            stderr: stderr.slice(0, 500),
            timedOut,
            stopped,
          });
        });
      });
    } finally {
      if (options.cwd === undefined) {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  };
}

export async function preflightPlanCli(
  adapter: PlanAdapter,
  parentEnv: NodeJS.ProcessEnv,
  withhold: readonly string[] = [],
): Promise<{ readonly run: RunCli; readonly version: string }> {
  if ((parentEnv.CI ?? "").length > 0) {
    throw new PlanRouteUnavailableError(
      "Plan routes run only on your own machine, and CI is set.",
      "In continuous integration, use an API route: --base-url <url> and --api-key-env <name>. If this is your own machine, unset CI and rerun.",
    );
  }
  const run = runner(
    adapter.command,
    adapter.childEnv(
      Object.fromEntries(
        Object.entries(parentEnv).filter(
          ([name]) => !withheldFromChild(name) && !withhold.includes(name),
        ),
      ),
    ),
    adapter.remedies.install,
  );
  const version = /\d+\.\d+\.\d+/u.exec(
    (
      await run(["--version"], {
        stdin: "",
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
      })
    ).stdout,
  )?.[0];
  if (
    version === undefined ||
    !versionAtLeast(version, adapter.minimumVersion)
  ) {
    throw new PlanRouteUnavailableError(
      `${adapter.command} ${version ?? "(unknown version)"} is older than ${adapter.minimumVersion}, the version rightmodeler's isolation settings were verified on.`,
      adapter.remedies.update,
    );
  }
  await adapter.checkLogin(run);
  return { run, version };
}

export function createPlanProvider(
  adapter: PlanAdapter,
  options: PlanProviderOptions,
): PlanProvider {
  const parentEnv = options.env ?? process.env;
  const vendor = planRouteVendors[adapter.kind];
  const limiter = new AdaptiveLimiter(options.maxConcurrency ?? 2);
  const warned = new Set<string>();
  const cliModelById = new Map<string, string>();
  let preflight: Promise<RunCli> | undefined;
  let known: Promise<ModelCatalogEntry[]> | undefined;
  let callable: Promise<ModelCatalogEntry[]> | undefined;
  let latch:
    BlockedError | PlanLoginError | PlanRouteUnavailableError | undefined;

  function warnOnce(code: string, message: string): void {
    if (warned.has(code)) return;
    warned.add(code);
    options.warning?.(code, message);
  }

  function ready(): Promise<RunCli> {
    preflight ??= (async () => {
      const { run } = await preflightPlanCli(
        adapter,
        parentEnv,
        options.withhold,
      );
      const withheld = adapter.keyVariables.filter(
        (name) => (parentEnv[name] ?? "").length > 0,
      );
      if (withheld.length > 0) {
        const one = withheld.length === 1;
        warnOnce(
          "plan_route_key_withheld",
          `${withheld.join(", ")} ${one ? "is" : "are"} set; rightmodeler keeps ${one ? "it" : "them"} away from ${adapter.command} so your plan is used, not a key.`,
        );
      }
      return run;
    })();
    return preflight;
  }

  function knownModels(): Promise<ModelCatalogEntry[]> {
    known ??= (async () => {
      await ready();
      return (await readModelList(options.priceList)).map((entry) => {
        const override = options.pricingOverrides?.[entry.id];
        return override === undefined
          ? entry
          : {
              ...entry,
              pricing: { input: override.input, output: override.output },
              ...(override.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: override.maxOutputTokens }),
            };
      });
    })();
    return known;
  }

  function listModels(): Promise<ModelCatalogEntry[]> {
    callable ??= (async () => {
      const listed = await adapter.listModels(await ready());
      const priced = await knownModels();
      const entries: ModelCatalogEntry[] = [];
      const unpriced: string[] = [];
      for (const { cliModel, contextWindow } of listed) {
        const canonical = priced.filter(
          ({ id, family }) =>
            family === vendor &&
            canonicalModelName(id) === canonicalModelName(cliModel),
        );
        const match =
          priced.find(({ id }) => id === `${vendor}/${cliModel}`) ??
          (canonical.length === 1 ? canonical[0] : undefined);
        if (match === undefined || match.pricing === null) {
          unpriced.push(cliModel);
          continue;
        }
        if (cliModelById.has(match.id)) continue;
        cliModelById.set(match.id, cliModel);
        entries.push({
          ...match,
          supportsTools: false,
          supportsStructuredOutput: false,
          ...(contextWindow === undefined
            ? {}
            : { contextLength: Math.min(match.contextLength, contextWindow) }),
        });
      }
      if (unpriced.length > 0) {
        const one = unpriced.length === 1;
        options.warning?.(
          "plan_model_unpriced",
          `${adapter.command} lists ${unpriced.join(", ")} but the price list ${options.priceList} has no price for ${one ? "it" : "them"}; ${one ? "it is" : "they are"} left out.`,
        );
      }
      return entries;
    })();
    return callable;
  }

  async function chat(request: ChatRequest): Promise<ChatResponse> {
    const run = await ready();
    if (latch !== undefined) throw latch;
    const entry = (await listModels()).find(({ id }) => id === request.model);
    if (entry?.pricing === null || entry?.pricing === undefined) {
      throw new ProviderRequestError(
        `${request.model} is not a model the ${adapter.kind} route lists`,
      );
    }
    if (!isSingleTurn(request.messages)) {
      throw new Error(
        `The ${adapter.kind} route sends one user turn, but the request has ${request.messages.map(({ role }) => role).join(", ")} messages`,
      );
    }
    const pricing = entry.pricing;
    const system = request.messages
      .slice(0, -1)
      .map(({ content }) => content)
      .join("\n\n");
    const user = request.messages.at(-1)!.content;
    const schema = outputSchema(request.responseFormat);
    return limiter.run(async () => {
      if (latch !== undefined) throw latch;
      const dir = await mkdtemp(join(tmpdir(), "rightmodeler-plan-"));
      let result: PlanCallResult;
      try {
        result = await adapter.call(run, {
          cliModel: cliModelById.get(entry.id)!,
          system,
          user,
          dir,
          timeoutMs: options.callTimeoutMs ?? 600_000,
          warnOnce,
          ...(schema === undefined ? {} : { outputSchema: schema }),
        });
      } catch (error) {
        if (
          !(error instanceof ProviderRequestError) &&
          !(error instanceof PlanRouteUnavailableError) &&
          !(error instanceof PlanLoginError)
        ) {
          throw error;
        }
        result = { ok: false, error, status: null, excerpt: "" };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      if (!result.ok) {
        await request.onAttempt?.({
          outcome: "provider_error",
          content: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          costIsEstimate: true,
          errorDetail: { status: result.status, bodyExcerpt: result.excerpt },
        });
        const { error } = result;
        if (
          isUsageLimit(error) ||
          error instanceof PlanLoginError ||
          error instanceof PlanRouteUnavailableError
        ) {
          latch ??= error;
        }
        throw error;
      }
      const response: ChatResponse = {
        content: result.content,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        costUsd:
          (request.estimatedInputTokens ??
            estimateInputTokens(request.messages)) *
            pricing.input +
          result.outputTokens * pricing.output,
        costIsEstimate: true,
        ...(result.servedModel === undefined
          ? {}
          : { servedModel: result.servedModel }),
        ...(result.substitution === undefined
          ? {}
          : { substitution: result.substitution }),
      };
      await request.onAttempt?.({
        outcome: "completed",
        ...response,
        ...(result.latencyMs === undefined
          ? {}
          : { latencyMs: result.latencyMs }),
      });
      return response;
    });
  }

  return { providerId: adapter.kind, listModels, knownModels, chat };
}
