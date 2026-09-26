import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import type { Ledger } from "@rightmodeler/core";

import { releasePolicy } from "../pipeline.js";
import {
  discoverLiveModels,
  makeAcceptanceRepo,
  protocolLines,
  runCapture,
  type LiveModels,
} from "./gateway-live.js";

export type PlanLeg = "a" | "b" | "c";

export const planPolicy = { shortlistTop: 1 };

export const DUMMY_KEYS = {
  ANTHROPIC_API_KEY: "sk-ant-dummy-not-a-key",
  CODEX_API_KEY: "sk-dummy-not-a-key",
  OPENAI_API_KEY: "sk-dummy-not-a-key",
} as const;

const gatewayKeys = new Set(["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"]);
const planKinds = new Set(["claude-login", "codex-login"]);
const planProcessPatterns = ["claude -p", "codex exec", "codex debug"];
const captureCount = 2 * releasePolicy(planPolicy).minimumHoldoutCases;
const pinnedIncumbents: Record<"a" | "b", readonly [string, string]> = {
  a: ["openai/gpt-4.1", "openai/gpt-4o"],
  b: ["anthropic/claude-sonnet-4.6", "anthropic/claude-opus-4.6"],
};

export function planCliEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !gatewayKeys.has(name) &&
        !/^(?:ANTHROPIC_|OPENAI_)/u.test(name) &&
        ![
          "CODEX_API_KEY",
          "CLAUDECODE",
          "CLAUDE_PID",
          "CLAUDE_EFFORT",
          "NODE_OPTIONS",
        ].includes(name) &&
        (!name.startsWith("CLAUDE_CODE_") ||
          name === "CLAUDE_CODE_OAUTH_TOKEN"),
    ),
  );
}

export function livePlanGate(): {
  readonly run: boolean;
  readonly reason: string;
  readonly dir: string;
} {
  const dir = process.env.RIGHTMODELER_LIVE_PLAN_DIR ?? "";
  const signedIn = (command: string, args: readonly string[]): boolean =>
    spawnSync(command, args, {
      env: planCliEnv(),
      stdio: "ignore",
      timeout: 30_000,
    }).status === 0;
  const reason =
    process.env.RIGHTMODELER_LIVE_PLAN_ROUTES !== "1"
      ? "set RIGHTMODELER_LIVE_PLAN_ROUTES=1"
      : (process.env.CI ?? "") !== ""
        ? "unset CI; plan routes are refused in CI"
        : !isAbsolute(dir) ||
            statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true
          ? "set RIGHTMODELER_LIVE_PLAN_DIR to an existing absolute directory"
          : !process.env.AI_GATEWAY_API_KEY
            ? "set AI_GATEWAY_API_KEY"
            : !signedIn("claude", ["auth", "status", "--json"])
              ? "sign in to the claude CLI"
              : !signedIn("codex", ["login", "status"])
                ? "sign in to the codex CLI"
                : undefined;
  if (reason === undefined) return { run: true, reason: "available", dir };
  console.warn(`[plan-routes live] SKIPPED: ${reason}`);
  return { run: false, reason, dir };
}

export async function preparePlanLeg(
  dir: string,
  leg: PlanLeg,
): Promise<{ repo: string; traces: string; models: LiveModels }> {
  const root = join(dir, leg);
  const repo = join(root, "repo");
  const traces = join(root, "traces.jsonl");
  const saved = join(root, "models.json");
  if (existsSync(saved)) {
    return {
      repo,
      traces,
      models: JSON.parse(await readFile(saved, "utf8")) as LiveModels,
    };
  }
  const models: LiveModels =
    leg === "c"
      ? await discoverLiveModels()
      : {
          vendor: pinnedIncumbents[leg][0].split("/")[0]!,
          incumbents: pinnedIncumbents[leg],
          candidates: [],
          judges: [],
        };
  await rm(root, { recursive: true, force: true });
  await makeAcceptanceRepo(root, models.incumbents);
  const captured = await runCapture([
    "--base-url",
    "https://ai-gateway.vercel.sh/v1",
    "--api-key-env",
    "AI_GATEWAY_API_KEY",
    "--models",
    models.incumbents.join(","),
    "--count",
    String(captureCount),
    "--family",
    "summarize",
    "--out",
    traces,
  ]);
  if (captured.sent !== captureCount || captured.failed !== 0) {
    throw new Error(
      `Leg ${leg}: the capture sent ${captured.sent} and failed ${captured.failed}, not ${captureCount} and 0`,
    );
  }
  const lines = (await readFile(traces, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const { model, response } = JSON.parse(line) as {
      model?: string;
      response?: { choices?: Array<{ message?: { content?: unknown } }> };
    };
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(
        `Leg ${leg}: captured answer ${index + 1} from ${model} is empty`,
      );
    }
  }
  await writeFile(saved, JSON.stringify(models));
  return { repo, traces, models };
}

async function entryNames(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

async function fileSize(path: string): Promise<number | null> {
  return stat(path).then(
    ({ size }) => size,
    () => null,
  );
}

async function filesChangedSince(
  directory: string,
  since: number,
): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  const changed: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const { mtimeMs, birthtimeMs } = await stat(path);
    if (Math.max(mtimeMs, birthtimeMs) > since) {
      changed.push(relative(directory, path));
    }
  }
  return changed.sort();
}

function planProcesses(): string[] {
  const found = spawnSync("pgrep", ["-fl", planProcessPatterns.join("|")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  return found.status !== 0
    ? []
    : found.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) =>
            `process ${line.trim().split(/\s+/u)[0]} (${planProcessPatterns.find((pattern) => line.includes(pattern)) ?? "plan CLI"})`,
        );
}

interface PlanHygiene {
  readonly violations: string[];
  readonly otherClaudeEntries: number;
  readonly historyBytes: {
    readonly before: number | null;
    readonly after: number | null;
  };
}

export async function planHygiene({
  homeDir = homedir(),
  tempDir = tmpdir(),
}: { readonly homeDir?: string; readonly tempDir?: string } = {}): Promise<{
  check(): Promise<PlanHygiene>;
}> {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homeDir, ".claude");
  const projects = join(claudeDir, "projects");
  const history = join(claudeDir, "history.jsonl");
  const sessions = join(
    process.env.CODEX_HOME || join(homeDir, ".codex"),
    "sessions",
  );
  const before = new Set(await entryNames(projects));
  const tempBefore = new Set(await entryNames(tempDir));
  const historyBefore = await fileSize(history);
  const startedAt = Date.now();
  return {
    async check() {
      const added = (await entryNames(projects)).filter(
        (name) => !before.has(name),
      );
      const planEntries = added.filter((name) =>
        name.includes("rightmodeler-plan-"),
      );
      return {
        violations: [
          ...planEntries.map((name) => `new Claude projects entry ${name}`),
          ...(await filesChangedSince(sessions, startedAt)).map(
            (path) => `new Codex session file ${path}`,
          ),
          ...(await entryNames(tempDir))
            .filter(
              (name) =>
                name.startsWith("rightmodeler-plan-") && !tempBefore.has(name),
            )
            .map((name) => `leftover temporary directory ${name}`),
          ...planProcesses(),
        ],
        otherClaudeEntries: added.length - planEntries.length,
        historyBytes: { before: historyBefore, after: await fileSize(history) },
      };
    },
  };
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function legFacts(
  ledger: Ledger,
  stderr: string,
  routes: { readonly candidates: string; readonly judge: string },
) {
  const lines = protocolLines(stderr);
  const messages = (code: string): string[] =>
    lines
      .filter((line) => line.code === code)
      .map(({ message }) => message ?? "");
  const utilizations = messages("plan_usage_warning").map((message) => {
    const match = /at (\d+)% of its usage limit/u.exec(message);
    return match === null ? null : Number(match[1]) / 100;
  });
  const candidateEvents = ledger.spendEvents.filter(
    ({ actor }) => actor === "replay-driver",
  );
  const judgeEvents = ledger.spendEvents.filter(
    ({ actor }) => actor === "judge",
  );
  const judgeCalls = judgeEvents.filter(
    ({ reconcilableTo }) => fields(reconcilableTo).invocation !== undefined,
  );
  const failures = judgeEvents
    .map(({ reconcilableTo }) => fields(reconcilableTo))
    .filter(({ judgeFailureKind }) => judgeFailureKind !== undefined);
  const judgeProviders = distinct(
    ledger.assessments.map(({ artifactRef }) =>
      String(fields(artifactRef).judgeProvider),
    ),
  );
  const inputTokens = ledger.requestAttempts
    .filter(({ streamOutcome }) => streamOutcome === "completed")
    .map(({ usage }) => Number(fields(usage).inputTokens))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const substituted = ledger.executions
    .filter(({ attribution }) => attribution === "substituted")
    .map(({ executionId, candidateId }) => ({
      candidateId,
      evidence: ledger.requestAttempts.flatMap((attempt) =>
        attempt.executionId === executionId &&
        attempt.substitution !== undefined
          ? [attempt.substitution.evidence]
          : [],
      ),
    }));
  const providers = {
    candidate: distinct(candidateEvents.map(({ provider }) => provider)),
    judge: distinct(judgeCalls.map(({ provider }) => provider)),
  };
  return {
    withheld: distinct(
      messages("plan_route_key_withheld").flatMap(
        (message) =>
          /^(.+?) (?:is|are) set;/u.exec(message)?.[1]?.split(", ") ?? [],
      ),
    ),
    usage: utilizations.filter((value): value is number => value !== null),
    providers,
    judgeAttempts: ledger.assessments.length + failures.length,
    malformed: failures.filter(
      ({ judgeFailureKind }) => judgeFailureKind === "response_malformed",
    ).length,
    judgeFailures: failures.map(
      ({ judgeModel, judgeFailureKind, errorDetail }) => ({
        judgeModel,
        kind: judgeFailureKind,
        message: String(fields(errorDetail).message ?? "").slice(0, 120),
      }),
    ),
    retirements: judgeEvents
      .map(({ reconcilableTo }) => fields(reconcilableTo))
      .filter(({ judgeStatus }) => judgeStatus === "unusable"),
    planCalls:
      (planKinds.has(routes.candidates) ? ledger.executions.length : 0) +
      (planKinds.has(routes.judge) ? judgeCalls.length : 0),
    substituted,
    candidateInputTokens:
      inputTokens.length === 0
        ? null
        : {
            min: inputTokens[0]!,
            median: inputTokens[Math.floor((inputTokens.length - 1) / 2)]!,
            max: inputTokens.at(-1)!,
          },
    largestCallUsd: Math.max(
      0,
      ...ledger.spendEvents.map(({ costUsd }) => costUsd),
    ),
    violations: [
      ...providers.candidate
        .filter((provider) => provider !== routes.candidates)
        .map(
          (provider) =>
            `candidate spend booked under ${provider}, not ${routes.candidates}`,
        ),
      ...providers.judge
        .filter((provider) => provider !== routes.judge)
        .map(
          (provider) =>
            `judge call booked under ${provider}, not ${routes.judge}`,
        ),
      ...judgeProviders
        .filter((provider) => provider !== routes.judge)
        .map(
          (provider) =>
            `assessment judged under ${provider}, not ${routes.judge}`,
        ),
      ...substituted
        .filter(({ evidence }) => evidence.length === 0)
        .map(
          ({ candidateId }) =>
            `substituted execution of ${candidateId} has no evidence`,
        ),
      ...utilizations.flatMap((value) =>
        value === null
          ? ["plan_usage_warning states no utilization"]
          : value >= 0.8
            ? [`plan usage reached ${value}`]
            : [],
      ),
      ...Object.entries(DUMMY_KEYS)
        .filter(([, value]) => stderr.includes(value))
        .map(([name]) => `stderr carries the dummy value of ${name}`),
    ],
  };
}
