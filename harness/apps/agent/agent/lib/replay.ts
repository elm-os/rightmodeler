import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { cliArguments, cliEnvironment, type JsonValue } from "./cli.js";
import type { ReplayStartInput } from "./schemas.js";

const execFileAsync = promisify(execFile);

const replayEventSchema = z.strictObject({
  runId: z.string(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "needs_input",
    "budget_limited",
    "failed",
  ]),
  at: z.string().datetime(),
  pid: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  message: z.string().optional(),
  result: z.json().optional(),
  spec: z.record(z.string(), z.json()).optional(),
});

type ReplayEvent = z.infer<typeof replayEventSchema>;

interface ReplayWorkerPayload {
  cliArgs: string[];
  cwd: string;
  eventPath: string;
  runId: string;
}

export interface ReplayStatus {
  runId: string;
  status: ReplayEvent["status"];
  updatedAt: string;
  eventCount: number;
  exitCode?: number;
  message?: string;
  result?: JsonValue;
}

const replayWorkerSource = String.raw`
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

const payload = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const append = (event) => appendFile(
  payload.eventPath,
  JSON.stringify({ runId: payload.runId, at: new Date().toISOString(), ...event }) + "\n",
  "utf8",
);

function parseJsonObject(value, source) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(source + " was not valid JSON.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(source + " must contain one JSON object.");
  }
  return parsed;
}

function errorMessage(stderr) {
  const parsed = parseJsonObject(stderr, "replay stderr");
  if (typeof parsed.message !== "string") {
    throw new Error("replay stderr must contain a message.");
  }
  return typeof parsed.remedy === "string"
    ? parsed.message + " Remedy: " + parsed.remedy
    : parsed.message;
}

async function run() {
  await append({ status: "running", pid: process.pid });
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  const child = spawn(process.execPath, payload.cliArgs, {
    cwd: payload.cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const output = Buffer.concat(stdout).toString("utf8");
  const errors = Buffer.concat(stderr).toString("utf8");

  if (outcome.code === 0) {
    await append({
      status: "completed",
      exitCode: outcome.code,
      result: parseJsonObject(output, "replay stdout"),
    });
    return;
  }
  if (outcome.code === 2 || outcome.code === 3) {
    await append({
      status: outcome.code === 2 ? "needs_input" : "budget_limited",
      exitCode: outcome.code,
      message: errorMessage(errors),
    });
    return;
  }
  const exit = outcome.code === null ? "signal " + outcome.signal : "exit " + outcome.code;
  await append({
    status: "failed",
    ...(outcome.code === null ? {} : { exitCode: outcome.code }),
    message: "rightmodeler replay failed with " + exit + ": " + errorMessage(errors),
  });
}

run().catch(async (error) => {
  await append({
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
`;

export async function startReplay(input: ReplayStartInput): Promise<{
  runId: string;
  status: ReplayEvent["status"];
  deduplicated: boolean;
}> {
  const spec = await replaySpec(input);
  const runId = `replay_${createHash("sha256")
    .update(canonicalJson(spec))
    .digest("hex")}`;
  const eventPath = replayEventPath(input.repo, input.store, runId);
  await mkdir(dirname(eventPath), { recursive: true });

  const queued: ReplayEvent = {
    runId,
    status: "queued",
    at: new Date().toISOString(),
    spec,
  };
  try {
    await writeFile(eventPath, `${JSON.stringify(queued)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readReplayStatus(input.repo, input.store, runId);
    return { runId, status: existing.status, deduplicated: true };
  }

  const payload: ReplayWorkerPayload = {
    cliArgs: cliArguments("replay", replayCliArguments(input), input),
    cwd: resolve(input.repo),
    eventPath,
    runId,
  };
  try {
    await launchWorker(payload);
  } catch (error) {
    await appendReplayEvent(eventPath, {
      runId,
      status: "failed",
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  return { runId, status: "queued", deduplicated: false };
}

export async function readReplayStatus(
  repo: string,
  store: string | undefined,
  runId: string,
): Promise<ReplayStatus> {
  const content = await readFile(replayEventPath(repo, store, runId), "utf8");
  const rows = content.split("\n").filter((row) => row.length > 0);
  if (rows.length === 0) throw new Error(`Replay run ${runId} has no events.`);
  const events = rows.map((row, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row);
    } catch (error) {
      throw new Error(
        `Replay run ${runId} has invalid JSON at event ${index + 1}.`,
        {
          cause: error,
        },
      );
    }
    return replayEventSchema.parse(parsed);
  });
  if (events.some((event) => event.runId !== runId)) {
    throw new Error(`Replay run ${runId} contains an event for another run.`);
  }
  const latest = events.at(-1);
  if (latest === undefined)
    throw new Error(`Replay run ${runId} has no events.`);
  return {
    runId,
    status: latest.status,
    updatedAt: latest.at,
    eventCount: events.length,
    ...(latest.exitCode === undefined ? {} : { exitCode: latest.exitCode }),
    ...(latest.message === undefined ? {} : { message: latest.message }),
    ...(latest.result === undefined ? {} : { result: latest.result }),
  };
}

export function replayEventPath(
  repo: string,
  store: string | undefined,
  runId: string,
): string {
  const storeRoot = resolve(store ?? resolve(repo, ".rightmodeler"));
  return resolve(storeRoot, "agent-runs", "replay", `${runId}.jsonl`);
}

async function replaySpec(
  input: ReplayStartInput,
): Promise<{ [key: string]: JsonValue }> {
  const repo = resolve(input.repo);
  const traces = resolve(input.traces);
  const modeBConfig =
    input.modeBConfig === undefined ? null : resolve(input.modeBConfig);
  await access(traces, constants.R_OK);
  if (modeBConfig !== null) await access(modeBConfig, constants.R_OK);
  const { stdout: revision } = await execFileAsync(
    "git",
    ["-C", repo, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );

  return {
    command: "replay",
    repo,
    store: resolve(input.store ?? resolve(repo, ".rightmodeler")),
    revision: revision.trim(),
    traces,
    tracesDigest: await fileDigest(traces),
    modeBConfig,
    modeBConfigDigest:
      modeBConfig === null ? null : await fileDigest(modeBConfig),
    baseUrl: input.baseUrl,
    apiKeyEnv: input.apiKeyEnv ?? null,
    maxCostUsd: input.maxCostUsd ?? null,
    evaluator:
      input.evaluator === undefined
        ? null
        : {
            provider: input.evaluator.provider,
            baseUrl: input.evaluator.baseUrl ?? null,
            apiKeyEnv: input.evaluator.apiKeyEnv ?? null,
            projectId: input.evaluator.projectId ?? null,
            scorers: input.evaluator.scorers ?? null,
            gateMetric: input.evaluator.gateMetric ?? null,
            gateThreshold: input.evaluator.gateThreshold ?? null,
          },
  };
}

function replayCliArguments(input: ReplayStartInput): string[] {
  const args = ["--traces", resolve(input.traces), "--base-url", input.baseUrl];
  if (input.modeBConfig !== undefined) {
    args.push("--modeb-config", resolve(input.modeBConfig));
  }
  if (input.apiKeyEnv !== undefined) {
    args.push("--api-key-env", input.apiKeyEnv);
  }
  if (input.maxCostUsd !== undefined) {
    args.push("--max-cost-usd", String(input.maxCostUsd));
  }
  if (input.evaluator !== undefined) {
    args.push("--evaluator", input.evaluator.provider);
    if (input.evaluator.baseUrl !== undefined) {
      args.push("--evaluator-base-url", input.evaluator.baseUrl);
    }
    if (input.evaluator.apiKeyEnv !== undefined) {
      args.push("--evaluator-api-key-env", input.evaluator.apiKeyEnv);
    }
    if (input.evaluator.projectId !== undefined) {
      args.push("--evaluator-project-id", input.evaluator.projectId);
    }
    for (const scorer of input.evaluator.scorers ?? []) {
      args.push("--evaluator-scorer", scorer);
    }
    if (input.evaluator.gateMetric !== undefined) {
      args.push("--evaluator-gate-metric", input.evaluator.gateMetric);
    }
    if (input.evaluator.gateThreshold !== undefined) {
      args.push(
        "--evaluator-gate-threshold",
        String(input.evaluator.gateThreshold),
      );
    }
  }
  return args;
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function launchWorker(payload: ReplayWorkerPayload): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const worker = spawn(
    process.execPath,
    ["--input-type=module", "--eval", replayWorkerSource, encoded],
    {
      cwd: payload.cwd,
      detached: true,
      env: cliEnvironment(),
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolveWorker, rejectWorker) => {
    worker.once("spawn", resolveWorker);
    worker.once("error", rejectWorker);
  });
  worker.unref();
}

async function appendReplayEvent(
  eventPath: string,
  event: ReplayEvent,
): Promise<void> {
  await appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
}
