import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compareText,
  FsStore,
  readLedger,
  setupStateKey,
  type Ledger,
} from "@rightmodeler/core";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const fixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/gateway-acceptance/", import.meta.url),
);

export function liveGatewayGate(name: string): {
  readonly run: boolean;
  readonly reason: string;
} {
  const reason =
    process.env.RIGHTMODELER_LIVE_GATEWAYS !== "1"
      ? "set RIGHTMODELER_LIVE_GATEWAYS=1"
      : !process.env.AI_GATEWAY_API_KEY
        ? "set AI_GATEWAY_API_KEY"
        : spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0
          ? "start Docker (docker info failed)"
          : undefined;
  if (reason === undefined) return { run: true, reason: "available" };
  console.warn(`[${name} live] SKIPPED: ${reason}`);
  return { run: false, reason };
}

export interface LiveModels {
  readonly vendor: string;
  readonly incumbents: readonly [string, string];
  readonly candidates: readonly string[];
  readonly judges: readonly string[];
}

interface CatalogModel {
  readonly id: string;
  readonly type?: string;
  readonly pricing?: { readonly input?: unknown; readonly output?: unknown };
  readonly supported_parameters?: readonly string[];
  readonly modalities?: { readonly output?: readonly string[] };
}

export async function discoverLiveModels(): Promise<LiveModels> {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/models");
  if (!response.ok) {
    throw new Error(
      `The Vercel AI Gateway catalog answered HTTP ${response.status}`,
    );
  }
  const { data } = (await response.json()) as { data: CatalogModel[] };
  const price = (model: CatalogModel): number =>
    3 * Number(model.pricing?.input) + Number(model.pricing?.output);
  const vendorOf = (model: CatalogModel): string => model.id.split("/")[0]!;
  const plain = data
    .filter((model) => {
      const parameters = model.supported_parameters ?? [];
      return (
        model.type === "language" &&
        Number(model.pricing?.input) > 0 &&
        Number(model.pricing?.output) > 0 &&
        (model.modalities?.output ?? []).includes("text") &&
        parameters.includes("temperature") &&
        !parameters.includes("reasoning") &&
        !model.id.endsWith("-fast")
      );
    })
    .sort(
      (left, right) =>
        price(left) - price(right) || compareText(left.id, right.id),
    );
  const byVendor = new Map<string, CatalogModel[]>();
  for (const model of plain) {
    const parameters = model.supported_parameters ?? [];
    if (
      !parameters.includes("tools") ||
      !parameters.includes("response_format")
    ) {
      continue;
    }
    byVendor.set(vendorOf(model), [
      ...(byVendor.get(vendorOf(model)) ?? []),
      model,
    ]);
  }
  const [first, second, third] = [...byVendor].sort(
    ([leftVendor, left], [rightVendor, right]) =>
      right.length - left.length || compareText(leftVendor, rightVendor),
  );
  if (first === undefined || first[1].length < 2) {
    throw new Error(
      "The Vercel AI Gateway catalog has no vendor with two eligible models to pin as incumbents",
    );
  }
  const middle = Math.floor(first[1].length / 2);
  const cheaper = first[1][middle - 1]!;
  const dearer = first[1][middle]!;
  const candidates = (second?.[1] ?? [])
    .filter((model) => price(model) < price(cheaper))
    .slice(0, 3);
  if (candidates.length === 0) {
    throw new Error(
      `The Vercel AI Gateway catalog has no second vendor with an eligible model cheaper than ${cheaper.id}`,
    );
  }
  const judges =
    third === undefined
      ? []
      : plain.filter((model) => vendorOf(model) === third[0]).slice(0, 2);
  if (judges.length === 0) {
    throw new Error(
      "The Vercel AI Gateway catalog has no third vendor with a priced text model to judge",
    );
  }
  return {
    vendor: first[0],
    incumbents: [cheaper.id, dearer.id],
    candidates: candidates.map(({ id }) => id),
    judges: judges.map(({ id }) => id),
  };
}

export interface LiveContainer {
  readonly name: string;
  readonly port: number;
  copyOut(containerPath: string, hostPath: string): Promise<void>;
  stop(): Promise<void>;
}

async function docker(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim();
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    if (await portIsFree(port)) return port;
  }
  throw new Error("No free port between 18000 and 18999");
}

export async function startPinnedContainer(options: {
  readonly image: string;
  readonly digest: string;
  readonly namePrefix: string;
  readonly containerPort: number;
  readonly runArgs?: readonly string[];
  readonly commandArgs?: readonly string[];
  readonly files?: readonly { readonly from: string; readonly to: string }[];
  readonly readyUrl: (port: number) => string;
}): Promise<LiveContainer> {
  const repository = options.image.slice(0, options.image.lastIndexOf(":"));
  const pinned = `${repository}@${options.digest}`;
  const repoDigests = async (): Promise<string[]> =>
    JSON.parse(
      await docker([
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        options.image,
      ]),
    ) as string[];
  const digests = await repoDigests().catch(async () => {
    await docker(["pull", options.image]);
    return repoDigests();
  });
  if (!digests.includes(pinned)) {
    throw new Error(
      `${options.image} is not ${pinned}; its digests are ${digests.join(", ")}`,
    );
  }
  const port = await freePort();
  const name = `${options.namePrefix}-${randomBytes(4).toString("hex")}`;
  await docker([
    "create",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:${options.containerPort}`,
    ...(options.runArgs ?? []),
    options.image,
    ...(options.commandArgs ?? []),
  ]);
  const running = async (): Promise<boolean> =>
    (await docker(["inspect", "--format", "{{.State.Running}}", name])) ===
    "true";
  const container: LiveContainer = {
    name,
    port,
    async copyOut(containerPath, hostPath) {
      if (await running()) await docker(["stop", "--time", "10", name]);
      await docker(["cp", `${name}:${containerPath}`, hostPath]);
    },
    async stop() {
      await docker(["stop", "--time", "10", name]).catch(() => undefined);
      await docker(["rm", "-f", "-v", name]).catch((error: unknown) => {
        if (
          !String((error as { stderr?: unknown }).stderr).includes(
            "No such container",
          )
        ) {
          throw error;
        }
      });
    },
  };
  try {
    for (const file of options.files ?? []) {
      await docker(["cp", file.from, `${name}:${file.to}`]);
    }
    await docker(["start", name]);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const answered = await fetch(options.readyUrl(port), {
        signal: AbortSignal.timeout(5_000),
      }).then(
        async (response) => {
          await response.body?.cancel();
          return true;
        },
        () => false,
      );
      if (answered) return container;
      if (Date.now() > deadline) {
        throw new Error(
          `${name} did not answer ${options.readyUrl(port)} within 120 seconds`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } catch (error) {
    await container.stop();
    throw error;
  }
}

export async function makeAcceptanceRepo(
  root: string,
  models: readonly [string, string],
): Promise<string> {
  const repo = join(root, "repo");
  await cp(join(fixtureRoot, "app"), repo, { recursive: true });
  const source = join(repo, "summarize.mjs");
  await writeFile(
    source,
    (await readFile(source, "utf8"))
      .replace("__MODEL_A__", models[0])
      .replace("__MODEL_B__", models[1]),
  );
  const git = (args: readonly string[]) =>
    execFileAsync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Aakash Harish",
      "-c",
      "user.email=aharish4@asu.edu",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  await git(["init", "--initial-branch", "main"]);
  await git(["add", "--all"]);
  await git(["commit", "--message", "Seed gateway acceptance app"]);
  return repo;
}

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 10, stdout, stderr });
    });
  });
}

export async function runBuiltCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv = { ...process.env, ...env };
  delete childEnv.FORCE_COLOR;
  delete childEnv.NO_COLOR;
  return run([cliPath, ...args], childEnv);
}

export async function runCapture(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ sent: number; failed: number }> {
  const result = await run([join(fixtureRoot, "capture.mjs"), ...args], {
    ...process.env,
    ...env,
  });
  if (result.code !== 0) {
    throw new Error(`capture.mjs exited ${result.code}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    sent: number;
    failed: number;
  };
}

async function ledgerOf(storeRoot: string): Promise<Ledger> {
  return readLedger(new FsStore(storeRoot), "project");
}

export interface ProtocolLine {
  readonly code?: string;
  readonly message?: string;
}

export function protocolLines(stderr: string): ProtocolLine[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as ProtocolLine);
}

export async function ingestArtifact(storeRoot: string): Promise<{
  format: unknown;
  runs: Array<{ steps: Array<{ model: string; family?: string }> }>;
}> {
  const store = new FsStore(storeRoot);
  const text = async (key: string) =>
    Buffer.from((await store.get(key))!.body).toString("utf8");
  const state = JSON.parse(await text(setupStateKey("project"))) as {
    stages: Record<string, { outputKey: string }>;
  };
  return JSON.parse(await text(state.stages.ingest!.outputKey)) as {
    format: unknown;
    runs: Array<{ steps: Array<{ model: string; family?: string }> }>;
  };
}

export async function recordLeg(
  gateway: string,
  leg: string,
  context: {
    readonly models: LiveModels;
    readonly repo: string;
    readonly store: string;
    readonly result: { readonly code: number; readonly stderr: string };
    readonly extra?: Record<string, unknown>;
  },
): Promise<{
  ledger: Ledger;
  spend:
    | {
        totalCostUsd: number;
        byActor: Record<string, { events: number; costUsd: number }>;
      }
    | undefined;
}> {
  const ledger = await ledgerOf(context.store);
  const status = await runBuiltCli([
    "status",
    "--output",
    "json",
    "--repo",
    context.repo,
    "--store",
    context.store,
  ]);
  const spend =
    status.code === 0
      ? (
          JSON.parse(status.stdout) as {
            spend: {
              totalCostUsd: number;
              byActor: Record<string, { events: number; costUsd: number }>;
            };
          }
        ).spend
      : undefined;
  console.info(
    `[${gateway} live] ${leg} leg: ${JSON.stringify({
      models: context.models,
      exitCode: context.result.code,
      stderr: protocolLines(context.result.stderr).map(
        ({ code, message }) => `${code}: ${message}`,
      ),
      candidates: [
        ...new Set(ledger.executions.map(({ candidateId }) => candidateId)),
      ],
      judgesTried: [
        ...new Set(
          ledger.spendEvents
            .filter(({ actor }) => actor === "judge")
            .map(
              ({ reconcilableTo }) =>
                (reconcilableTo as { judgeModel?: unknown }).judgeModel,
            ),
        ),
      ],
      judges: [
        ...new Set(ledger.assessments.map(({ evaluatorId }) => evaluatorId)),
      ],
      executions: ledger.executions.length,
      requestAttempts: ledger.requestAttempts.length,
      assessments: ledger.assessments.length,
      spend: spend ?? status.stderr,
      ...context.extra,
    })}`,
  );
  return { ledger, spend };
}

export async function assertNoSecretIn(
  root: string,
  secretNames: readonly string[],
): Promise<void> {
  const secrets = secretNames.flatMap((name) => {
    const value = process.env[name];
    return value !== undefined && value.length >= 8
      ? [{ name, value: Buffer.from(value) }]
      : [];
  });
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const content = await readFile(path);
    for (const secret of secrets) {
      if (content.includes(secret.value)) {
        throw new Error(`The value of ${secret.name} was written to ${path}`);
      }
    }
  }
}

export async function removeLeftoverContainers(prefix: string): Promise<void> {
  const names = await docker([
    "ps",
    "-a",
    "--filter",
    `name=${prefix}`,
    "--format",
    "{{.Names}}",
  ]);
  for (const name of names.split("\n").filter((line) => line.length > 0)) {
    await docker(["rm", "-f", "-v", name]);
  }
}
