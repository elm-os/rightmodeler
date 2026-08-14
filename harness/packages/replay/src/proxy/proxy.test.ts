import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { requestAttemptSchema } from "@rightmodeler/core";

import {
  redactCredential,
  startEgressListener,
  type EgressListener,
} from "./egress.js";

interface StubProvider {
  port: number;
  close(): Promise<void>;
  getHitCount(): number;
}

interface StubProviderModule {
  startStubProvider(options: { port: number }): Promise<StubProvider>;
}

interface Runtime {
  child: ChildProcessWithoutNullStreams;
  env: NodeJS.ProcessEnv;
  port: number;
  url: string;
  stdout: string[];
  stderr: string[];
}

interface Pair {
  scratch: string;
  stub: StubProvider;
  egress: EgressListener;
  runtime: Runtime;
  env: NodeJS.ProcessEnv;
  scriptPath: string;
}

interface RuntimeOptions {
  scratch: string;
  egressUrl: string;
  swapPolicy?: Record<string, string>;
  pricingTable?: Record<string, { input: number; output: number }>;
  maxUsd?: number;
  streamIdleTimeoutMs?: number;
  streamHardDeadlineMs?: number;
}

const stubModuleUrl = new URL(
  "../../../../fixtures/stub-provider/server.mjs",
  import.meta.url,
).href;
const runtimePath = fileURLToPath(
  new URL("./proxy-runtime.mjs", import.meta.url),
);
const transportPath = fileURLToPath(
  new URL("../transport/stream.ts", import.meta.url),
);
const headersPath = fileURLToPath(new URL("./headers.ts", import.meta.url));
const apiKeyEnv = "REPLAY_PROXY_TEST_API_KEY";
const credential = "credential-sentinel-that-must-never-persist";
const runId = "run-proxy-1";
const caseId = "case-proxy-1";
const executionId = "execution-proxy-1";

const children: Runtime[] = [];
const egressListeners: EgressListener[] = [];
const stubs: StubProvider[] = [];
const servers: Server[] = [];
const scratchDirectories: string[] = [];

afterEach(async () => {
  for (const runtime of children.splice(0).reverse()) {
    await stopRuntime(runtime);
  }
  for (const egress of egressListeners.splice(0).reverse()) {
    await egress.close();
  }
  for (const stub of stubs.splice(0).reverse()) await stub.close();
  for (const server of servers.splice(0).reverse()) await closeServer(server);
  for (const scratch of scratchDirectories.splice(0).reverse()) {
    await rm(scratch, { recursive: true, force: true });
  }
  delete process.env[apiKeyEnv];
});

function stubOrigin(stub: StubProvider): string {
  return `http://127.0.0.1:${stub.port}`;
}

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "acme/large-1",
    messages: [{ role: "user", content: "Meter this deterministic request." }],
    max_tokens: 32,
    stream: false,
    ...overrides,
  };
}

function runtimeEnv(options: RuntimeOptions): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    RM_RUN_ID: runId,
    RM_CASE_ID: caseId,
    RM_EXECUTION_ID: executionId,
    RM_SCRATCH: options.scratch,
    RM_PROXY_HOST: "127.0.0.1",
    RM_PROXY_PORT: "0",
    RM_EGRESS_URL: options.egressUrl,
    RM_SWAP_POLICY: JSON.stringify(options.swapPolicy ?? {}),
    RM_PRICING_TABLE: JSON.stringify(
      options.pricingTable ?? {
        "acme/lite-1": { input: 0.0000001, output: 0.0000004 },
        "acme/large-1": { input: 0.000001, output: 0.000003 },
      },
    ),
    RM_BUDGET_LEASE: JSON.stringify({ maxUsd: options.maxUsd ?? 1 }),
    ...(options.streamIdleTimeoutMs === undefined
      ? {}
      : { RM_STREAM_IDLE_TIMEOUT_MS: String(options.streamIdleTimeoutMs) }),
    ...(options.streamHardDeadlineMs === undefined
      ? {}
      : { RM_STREAM_HARD_DEADLINE_MS: String(options.streamHardDeadlineMs) }),
  };
}

async function startRuntime(
  env: NodeJS.ProcessEnv,
  scriptPath = runtimePath,
): Promise<Runtime> {
  const child = spawn(process.execPath, [scriptPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  const port = await new Promise<number>((resolve, reject) => {
    let pending = "";
    const timeout = setTimeout(
      () => reject(new Error(`Proxy readiness timed out: ${stderr.join("")}`)),
      5_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const event = JSON.parse(line) as { event?: string; port?: number };
        if (event.event === "ready" && event.port !== undefined) {
          clearTimeout(timeout);
          resolve(event.port);
        }
        newline = pending.indexOf("\n");
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Proxy exited before readiness (${String(code)}): ${stderr.join("")}`,
        ),
      );
    });
  });

  const runtime = {
    child,
    env,
    port,
    url: `http://127.0.0.1:${port}`,
    stdout,
    stderr,
  };
  children.push(runtime);
  return runtime;
}

async function createRuntimeBundle(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-proxy-runtime-"));
  scratchDirectories.push(root);
  const proxyDirectory = join(root, "proxy");
  const transportDirectory = join(root, "transport");
  await mkdir(proxyDirectory, { recursive: true });
  await mkdir(transportDirectory, { recursive: true });
  await writeFile(
    join(proxyDirectory, "proxy-runtime.mjs"),
    await readFile(runtimePath),
  );
  const compilerOptions = {
    module: ModuleKind.ESNext,
    target: ScriptTarget.ES2022,
  };
  const transport = transpileModule(await readFile(transportPath, "utf8"), {
    compilerOptions,
  });
  const headers = transpileModule(await readFile(headersPath, "utf8"), {
    compilerOptions,
  });
  await writeFile(join(transportDirectory, "stream.js"), transport.outputText);
  await writeFile(join(proxyDirectory, "headers.js"), headers.outputText);
  return join(proxyDirectory, "proxy-runtime.mjs");
}

async function stopRuntime(
  runtime: Runtime,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null)
    return;
  const exited = new Promise<void>((resolve) =>
    runtime.child.once("exit", () => resolve()),
  );
  runtime.child.kill(signal);
  await exited;
}

async function startStub(): Promise<StubProvider> {
  const fixture = (await import(stubModuleUrl)) as StubProviderModule;
  const stub = await fixture.startStubProvider({ port: 0 });
  stubs.push(stub);
  return stub;
}

async function startEgress(stub: StubProvider): Promise<EgressListener> {
  const egress = await startEgressListener({
    providerBaseUrl: stubOrigin(stub),
    apiKeyEnv,
  });
  egressListeners.push(egress);
  return egress;
}

async function startPair(
  options: Omit<RuntimeOptions, "scratch" | "egressUrl"> = {},
): Promise<Pair> {
  process.env[apiKeyEnv] = credential;
  const scratch = await mkdtemp(join(tmpdir(), "rightmodeler-proxy-"));
  scratchDirectories.push(scratch);
  const stub = await startStub();
  const egress = await startEgress(stub);
  const env = runtimeEnv({
    ...options,
    scratch,
    egressUrl: egress.url,
  });
  const scriptPath = await createRuntimeBundle();
  const runtime = await startRuntime(env, scriptPath);
  return { scratch, stub, egress, runtime, env, scriptPath };
}

function correlatedHeaders(stepId: string, logicalCallId: string) {
  return {
    "content-type": "application/json",
    "x-rm-step": stepId,
    "x-rm-call": logicalCallId,
  };
}

async function callProxy(
  runtime: Runtime,
  stepId: string,
  logicalCallId: string,
  body = chatBody(),
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${runtime.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...correlatedHeaders(stepId, logicalCallId),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function spoolPath(scratch: string): string {
  return join(scratch, "proxy", "attempts", `${executionId}.0.jsonl`);
}

function checkpointPath(scratch: string): string {
  return join(scratch, "proxy", "checkpoints", `${caseId}.jsonl`);
}

async function readRows(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readTree(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    contents.push(
      entry.isDirectory() ? await readTree(path) : await readFile(path, "utf8"),
    );
  }
  return contents.join("");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function absoluteRequest(
  egress: EgressListener,
  target: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: egress.hostname,
        port: egress.port,
        method: "POST",
        path: target,
        headers: { "content-length": "0" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function sendOversizedChunked(runtime: Runtime): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${runtime.url}/v1/chat/completions`,
      {
        method: "POST",
        headers: correlatedHeaders("step-large", "logical-large"),
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          request.destroy();
          resolve(status);
        });
      },
    );
    request.once("error", (error) => {
      if (!request.destroyed) reject(error);
    });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let index = 0; index < 10; index += 1) request.write(chunk);
    request.write(Buffer.from("a"));
  });
}

async function sendDuplicateStepHeader(
  runtime: Runtime,
): Promise<{ status: number; body: string }> {
  const body = Buffer.from(JSON.stringify(chatBody()));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${runtime.url}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
          "x-rm-step": ["step-a", "step-b"],
          "x-rm-call": "logical-duplicate-step",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

describe("Mode B proxy and host egress", () => {
  it("redacts every credential occurrence from an error body", () => {
    expect(
      redactCredential(
        Buffer.from(`before ${credential} middle ${credential} after`),
        credential,
      ).toString("utf8"),
    ).toBe("before [REDACTED] middle [REDACTED] after");
  });

  it("rewrites only policy steps and meters byte-exact streaming responses", async () => {
    const pair = await startPair({
      swapPolicy: { "step-rewrite": "acme/lite-1" },
    });

    const rewritten = await callProxy(
      pair.runtime,
      "step-rewrite",
      "logical-rewrite",
    );
    expect(rewritten.status).toBe(200);
    await expect(rewritten.json()).resolves.toMatchObject({
      model: "acme/lite-1",
    });

    const streamingBody = chatBody({ stream: true });
    const streamed = await callProxy(
      pair.runtime,
      "step-pass-through",
      "logical-stream",
      streamingBody,
      { "x-stub-enable-streaming": "1" },
    );
    expect(streamed.status).toBe(200);
    const actualBytes = Buffer.from(await streamed.arrayBuffer());
    const direct = await fetch(`${stubOrigin(pair.stub)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stub-enable-streaming": "1",
      },
      body: JSON.stringify(streamingBody),
    });
    const expectedBytes = Buffer.from(await direct.arrayBuffer());
    expect(actualBytes.equals(expectedBytes)).toBe(true);
    expect(pair.stub.getHitCount()).toBe(3);

    const allRows = await readRows(spoolPath(pair.scratch));
    const attempts = allRows.filter((row) => row.kind === "request_attempt");
    const reservations = allRows.filter(
      (row) => row.kind === "attempt_reservation",
    );
    expect(allRows).toHaveLength(4);
    expect(attempts).toHaveLength(2);
    expect(reservations).toHaveLength(2);
    expect(reservations.map(({ attemptId }) => attemptId)).toEqual(
      attempts.map(({ attemptId }) => attemptId),
    );
    expect(attempts[0]).toMatchObject({
      runId,
      caseId,
      stepId: "step-rewrite",
      executionId,
      logicalCallId: "logical-rewrite",
      attemptGroup: 1,
      attribution: "ok",
      model: "acme/lite-1",
      streamOutcome: "completed",
      costUsd: expect.any(Number),
      costIsEstimate: false,
    });
    expect(attempts[1]).toMatchObject({
      stepId: "step-pass-through",
      logicalCallId: "logical-stream",
      attemptGroup: 2,
      attribution: "ok",
      model: "acme/large-1",
      streamOutcome: "completed",
      costUsd: expect.any(Number),
      costIsEstimate: false,
      usage: {
        outputTokens: 12,
      },
    });
    expect(new Set(attempts.map((row) => row.attemptId)).size).toBe(2);
    expect(attempts.every((row) => typeof row.attemptId === "string")).toBe(
      true,
    );
    expect(Date.parse(String(attempts[0]?.startedAt))).not.toBeNaN();
    expect(Date.parse(String(attempts[0]?.endedAt))).not.toBeNaN();
    expect(
      requestAttemptSchema.parse({
        attemptId: attempts[0]?.attemptId,
        logicalCallId: attempts[0]?.logicalCallId,
        executionId: attempts[0]?.executionId,
        streamOutcome: attempts[0]?.streamOutcome,
        usage: attempts[0]?.usage,
        costUsd: attempts[0]?.costUsd,
        costIsEstimate: attempts[0]?.costIsEstimate,
      }),
    ).toBeDefined();
  });

  it("loads the production-relative transport classifier", async () => {
    const pair = await startPair();
    await stopRuntime(pair.runtime);
    const built = await startRuntime(pair.env, await createRuntimeBundle());

    const streamed = await callProxy(
      built,
      "step-built",
      "logical-built",
      chatBody({ stream: true }),
      { "x-stub-enable-streaming": "1" },
    );
    expect(streamed.status).toBe(200);
    expect((await streamed.text()).endsWith("data: [DONE]\n\n")).toBe(true);
    const truncated = await callProxy(
      built,
      "step-built",
      "logical-truncated",
      chatBody({ stream: true }),
      {
        "x-stub-enable-streaming": "1",
        "x-stub-truncate-stream": "1",
      },
    );
    expect(truncated.status).toBe(200);
    expect((await truncated.text()).endsWith("data: [DONE]\n\n")).toBe(false);
    const finishedWithoutSentinel = await callProxy(
      built,
      "step-built",
      "logical-finished-without-sentinel",
      chatBody({ stream: true }),
      {
        "x-stub-enable-streaming": "1",
        "x-stub-finish-without-sentinel": "1",
      },
    );
    expect(finishedWithoutSentinel.status).toBe(200);
    expect(
      (await finishedWithoutSentinel.text()).endsWith("data: [DONE]\n\n"),
    ).toBe(false);

    const attempts = (await readRows(spoolPath(pair.scratch))).filter(
      (row) => row.kind === "request_attempt",
    );
    expect(attempts[0]).toMatchObject({
      streamOutcome: "completed",
      usage: { outputTokens: 12 },
    });
    expect(attempts[1]).toMatchObject({
      logicalCallId: "logical-truncated",
      streamOutcome: "truncated",
      usage: null,
    });
    expect(attempts[2]).toMatchObject({
      logicalCallId: "logical-finished-without-sentinel",
      streamOutcome: "completed",
      finishedWithoutSentinel: true,
    });
  });

  it("spools a streaming response over one MiB through the proxy", async () => {
    const pair = await startPair();
    const response = await callProxy(
      pair.runtime,
      "step-large-stream",
      "logical-large-stream",
      chatBody({ stream: true }),
      {
        "x-stub-enable-streaming": "1",
        "x-stub-large-stream": "1",
      },
    );

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const attempt = (await readRows(spoolPath(pair.scratch))).find(
      (row) => row.kind === "request_attempt",
    );
    expect(attempt).toMatchObject({
      streamOutcome: "completed",
      responseSpoolPath: expect.any(String),
    });
    const spooled = await readFile(String(attempt?.responseSpoolPath));
    expect(spooled.length).toBe(1_200_000);
    expect(spooled.equals(Buffer.from("x".repeat(1_200_000)))).toBe(true);
  });

  it("fails closed without step correlation and never forwards", async () => {
    const pair = await startPair();
    const before = pair.stub.getHitCount();

    const response = await fetch(`${pair.runtime.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rm-call": "logical-lost",
      },
      body: JSON.stringify(chatBody()),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("x-rm-step"),
    });
    expect(pair.stub.getHitCount()).toBe(before);
    expect(await readRows(spoolPath(pair.scratch))).toEqual([
      expect.objectContaining({
        kind: "lost",
        stepId: null,
        logicalCallId: "logical-lost",
        attribution: "lost",
        rejectionReason: "missing_correlation",
        costUsd: null,
        streamOutcome: null,
      }),
    ]);
  });

  it("rejects duplicate step correlation as lost without forwarding", async () => {
    const pair = await startPair();
    const response = await sendDuplicateStepHeader(pair.runtime);

    expect(response.status).toBe(400);
    expect(response.body).toContain("Duplicate correlation header");
    expect(pair.stub.getHitCount()).toBe(0);
    expect(await readRows(spoolPath(pair.scratch))).toEqual([
      expect.objectContaining({
        kind: "lost",
        logicalCallId: "logical-duplicate-step",
        rejectionReason: "duplicate_step_correlation",
        streamOutcome: null,
      }),
    ]);
  });

  it("treats constructor as a normal step id when no swap is configured", async () => {
    const pair = await startPair();
    const response = await callProxy(
      pair.runtime,
      "constructor",
      "logical-constructor",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      model: "acme/large-1",
    });
  });

  it("uses the spawned hard-deadline override for upstream response headers", async () => {
    const pair = await startPair({ streamHardDeadlineMs: 20 });
    const startedAt = performance.now();
    const response = await callProxy(
      pair.runtime,
      "step-timeout",
      "logical-timeout",
      chatBody(),
      { "x-stub-hold-before-response-ms": "500" },
    );

    expect(response.status).toBe(502);
    expect(performance.now() - startedAt).toBeLessThan(200);
    const attempts = (await readRows(spoolPath(pair.scratch))).filter(
      (row) => row.kind === "request_attempt",
    );
    expect(attempts).toEqual([
      expect.objectContaining({
        kind: "request_attempt",
        logicalCallId: "logical-timeout",
        streamOutcome: "truncated",
        costIsEstimate: true,
      }),
    ]);
  });

  it("marks a post-header upstream reset as an egress failure", async () => {
    process.env[apiKeyEnv] = credential;
    const scratch = await mkdtemp(join(tmpdir(), "rightmodeler-proxy-reset-"));
    scratchDirectories.push(scratch);
    const provider = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":[');
      setImmediate(() => response.socket?.destroy());
    });
    servers.push(provider);
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (address === null || typeof address === "string") {
      throw new Error("Reset provider did not bind a TCP address");
    }
    const egress = await startEgressListener({
      providerBaseUrl: `http://127.0.0.1:${address.port}`,
      apiKeyEnv,
    });
    egressListeners.push(egress);
    const runtime = await startRuntime(
      runtimeEnv({ scratch, egressUrl: egress.url }),
      await createRuntimeBundle(),
    );

    await callProxy(runtime, "step-reset", "logical-reset")
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const attempts = (await readRows(spoolPath(scratch))).filter(
      (row) => row.kind === "request_attempt",
    );
    expect(attempts).toEqual([
      expect.objectContaining({
        logicalCallId: "logical-reset",
        streamOutcome: "truncated",
        upstreamStatus: 200,
        upstreamSource: "egress",
      }),
    ]);
  });

  it("uses the spawned idle-timeout override between stream events", async () => {
    const pair = await startPair({
      streamIdleTimeoutMs: 20,
      streamHardDeadlineMs: 1_000,
    });
    const startedAt = performance.now();
    const response = await callProxy(
      pair.runtime,
      "step-idle-timeout",
      "logical-idle-timeout",
      chatBody({ stream: true }),
      {
        "x-stub-enable-streaming": "1",
        "x-stub-stall-stream-ms": "500",
      },
    );

    await response.arrayBuffer().catch(() => undefined);
    // The bound only needs to discriminate the idle override firing (tens of milliseconds)
    // from the 500ms stall completing or the 1s hard deadline; slow CI runners need headroom.
    expect(performance.now() - startedAt).toBeLessThan(450);
    const attempts = (await readRows(spoolPath(pair.scratch))).filter(
      (row) => row.kind === "request_attempt",
    );
    expect(attempts).toEqual([
      expect.objectContaining({
        kind: "request_attempt",
        logicalCallId: "logical-idle-timeout",
        streamOutcome: "truncated",
      }),
    ]);
  });

  it("rehydrates checkpoints and continues attempt groups after restart", async () => {
    const pair = await startPair();
    const first = await callProxy(pair.runtime, "step-1", "logical-1");
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const second = await callProxy(pair.runtime, "step-1", "logical-2");
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    await stopRuntime(pair.runtime, "SIGKILL");
    const priorBytes = await readFile(spoolPath(pair.scratch), "utf8");

    const restarted = await startRuntime(pair.env, pair.scriptPath);
    const retry = await callProxy(restarted, "step-1", "logical-2");
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
    const third = await callProxy(restarted, "step-1", "logical-3");
    expect(third.status).toBe(200);
    await third.arrayBuffer();

    const resumedBytes = await readFile(spoolPath(pair.scratch), "utf8");
    expect(resumedBytes.startsWith(priorBytes)).toBe(true);
    const attempts = (await readRows(spoolPath(pair.scratch))).filter(
      (row) => row.kind === "request_attempt",
    );
    expect(attempts.map((row) => row.attemptGroup)).toEqual([1, 2, 2, 3]);
    expect(new Set(attempts.map((row) => row.attemptId)).size).toBe(4);
    expect(await readRows(checkpointPath(pair.scratch))).toEqual([
      {
        caseId,
        seqPos: 1,
        attemptGroup: 1,
        logicalCallId: "logical-1",
      },
      {
        caseId,
        seqPos: 2,
        attemptGroup: 2,
        logicalCallId: "logical-2",
      },
      {
        caseId,
        seqPos: 3,
        attemptGroup: 2,
        logicalCallId: "logical-2",
      },
      {
        caseId,
        seqPos: 4,
        attemptGroup: 3,
        logicalCallId: "logical-3",
      },
    ]);
  });

  it("rehydrates and conservatively retains an in-flight reservation", async () => {
    const pair = await startPair();
    const pending = callProxy(
      pair.runtime,
      "step-killed",
      "logical-killed",
      chatBody(),
      { "x-stub-hold-before-response-ms": "5000" },
    ).catch(() => undefined);
    await waitFor(
      () => pair.stub.getHitCount() === 1,
      "Stub did not receive the in-flight request",
    );
    const beforeKill = await readRows(spoolPath(pair.scratch));
    expect(beforeKill).toEqual([
      expect.objectContaining({
        kind: "attempt_reservation",
        logicalCallId: "logical-killed",
        attemptGroup: 1,
      }),
    ]);
    await stopRuntime(pair.runtime, "SIGKILL");
    await pending;

    const restarted = await startRuntime(pair.env, pair.scriptPath);
    const retry = await callProxy(restarted, "step-killed", "logical-killed");
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();

    const rows = await readRows(spoolPath(pair.scratch));
    const reservations = rows.filter(
      (row) => row.kind === "attempt_reservation",
    );
    const attempts = rows.filter((row) => row.kind === "request_attempt");
    expect(reservations).toHaveLength(2);
    expect(reservations[0]?.attemptId).not.toBe(reservations[1]?.attemptId);
    expect(attempts).toEqual([
      expect.objectContaining({
        logicalCallId: "logical-killed",
        attemptGroup: 1,
        streamOutcome: "completed",
      }),
    ]);
    expect(typeof attempts[0]?.attemptId).toBe("string");
  });

  it("blocks the second request when the case lease covers only one", async () => {
    const body = chatBody();
    const pricing = { input: 0.001, output: 0.002 };
    const forwardedBytes = Buffer.byteLength(JSON.stringify(body));
    const oneRequestLease =
      forwardedBytes * pricing.input + 32 * pricing.output;
    const pair = await startPair({
      pricingTable: { "acme/large-1": pricing },
      maxUsd: oneRequestLease,
    });

    const first = await callProxy(
      pair.runtime,
      "step-budget",
      "logical-1",
      body,
    );
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const afterFirst = pair.stub.getHitCount();
    expect(afterFirst).toBe(1);
    const firstAttempt = (await readRows(spoolPath(pair.scratch))).find(
      (row) => row.kind === "request_attempt",
    );
    expect(Number(firstAttempt?.leaseChargeUsd)).toBeLessThan(
      Number(firstAttempt?.reservedUsd),
    );
    expect(firstAttempt?.estimatedInputTokens).toBe(forwardedBytes);
    const second = await callProxy(
      pair.runtime,
      "step-budget",
      "logical-2",
      body,
    );

    expect(second.status).toBe(402);
    const refusal = (await second.json()) as {
      requiredLease?: { maxUsd?: number };
    };
    expect(refusal.requiredLease?.maxUsd).toBeGreaterThan(oneRequestLease);
    expect(refusal.requiredLease?.maxUsd).toBeCloseTo(
      Number(firstAttempt?.leaseChargeUsd) + oneRequestLease,
    );
    expect(pair.stub.getHitCount()).toBe(afterFirst);
    const rows = await readRows(spoolPath(pair.scratch));
    expect(rows.filter((row) => row.kind === "request_attempt")).toHaveLength(
      1,
    );
    expect(rows.filter((row) => row.kind === "blocked")).toEqual([
      expect.objectContaining({
        reason: "budget",
        requiredLease: expect.objectContaining({
          maxUsd: refusal.requiredLease?.maxUsd,
        }),
      }),
    ]);
    expect(rows.find((row) => row.kind === "blocked")).not.toHaveProperty(
      "attemptId",
    );
  });

  it("rejects a non-allowlisted egress host before forwarding", async () => {
    process.env[apiKeyEnv] = credential;
    const stub = await startStub();
    const egress = await startEgress(stub);
    let disallowedHits = 0;
    const disallowed = createServer((_request, response) => {
      disallowedHits += 1;
      response.end("unexpected");
    });
    servers.push(disallowed);
    await new Promise<void>((resolve, reject) => {
      disallowed.once("error", reject);
      disallowed.listen(0, "127.0.0.1", resolve);
    });
    const address = disallowed.address();
    if (address === null || typeof address === "string") {
      throw new Error("Disallowed fixture did not bind a TCP address");
    }

    const response = await absoluteRequest(
      egress,
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
    );

    expect(response.status).toBe(403);
    expect(response.body).toContain("not allowed");
    expect(disallowedHits).toBe(0);
    expect(stub.getHitCount()).toBe(0);
  });

  it("preserves a configured provider base path prefix", async () => {
    process.env[apiKeyEnv] = credential;
    let receivedPath = "";
    const provider = createServer((request, response) => {
      receivedPath = request.url ?? "";
      request.resume();
      request.once("end", () => {
        response.setHeader("content-type", "application/json");
        response.end("{}");
      });
    });
    servers.push(provider);
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (address === null || typeof address === "string") {
      throw new Error("Pathed provider fixture did not bind a TCP address");
    }
    const egress = await startEgressListener({
      providerBaseUrl: `http://127.0.0.1:${address.port}/provider-prefix`,
      apiKeyEnv,
    });
    egressListeners.push(egress);

    const response = await fetch(`${egress.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/provider-prefix/v1/chat/completions");
  });

  it("injects credentials at forward time and redacts provider errors", async () => {
    delete process.env[apiKeyEnv];
    const scratch = await mkdtemp(join(tmpdir(), "rightmodeler-proxy-secret-"));
    scratchDirectories.push(scratch);
    const stub = await startStub();
    const egress = await startEgress(stub);

    const missing = await fetch(`${egress.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    });
    expect(missing.status).toBe(500);
    expect(stub.getHitCount()).toBe(0);

    process.env[apiKeyEnv] = credential;
    const env = runtimeEnv({ scratch, egressUrl: egress.url });
    expect(JSON.stringify(env)).not.toContain(credential);
    const runtime = await startRuntime(env, await createRuntimeBundle());
    const response = await callProxy(
      runtime,
      "step-secret",
      "logical-secret",
      chatBody(),
      { "x-stub-echo-auth": "1" },
    );
    const errorBody = await response.text();

    expect(response.status).toBe(400);
    expect(errorBody).toContain("[REDACTED]");
    expect(errorBody).not.toContain(credential);
    expect(response.headers.get("x-stub-reflected-auth")).toBe(
      `Bearer ${credential}`,
    );
    const usageEcho = await callProxy(
      runtime,
      "step-secret",
      "logical-secret-usage",
      chatBody(),
      { "x-stub-echo-auth-in-usage": "1" },
    );
    expect(usageEcho.status).toBe(200);
    expect(usageEcho.headers.get("x-stub-reflected-auth")).toBe(
      `Bearer ${credential}`,
    );
    await usageEcho.arrayBuffer();
    const persisted = await readTree(join(scratch, "proxy"));
    expect(persisted).not.toContain(credential);
    const attempts = await readRows(spoolPath(scratch));
    expect(attempts.at(-1)?.usage).toEqual({
      inputTokens: expect.any(Number),
      outputTokens: 12,
      totalTokens: expect.any(Number),
    });
    expect(runtime.stdout.join("")).not.toContain(credential);
    expect(runtime.stderr.join("")).not.toContain(credential);
  });

  it("rejects oversized and malformed JSON bodies as lost attribution", async () => {
    const pair = await startPair();
    const before = pair.stub.getHitCount();
    await expect(sendOversizedChunked(pair.runtime)).resolves.toBe(413);

    const malformed = await fetch(`${pair.runtime.url}/v1/chat/completions`, {
      method: "POST",
      headers: correlatedHeaders("step-malformed", "logical-malformed"),
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(pair.stub.getHitCount()).toBe(before);
    expect(await readRows(spoolPath(pair.scratch))).toEqual([
      expect.objectContaining({
        kind: "lost",
        attribution: "lost",
        rejectionReason: "request_too_large",
        costUsd: null,
        usage: null,
        streamOutcome: null,
      }),
      expect.objectContaining({
        kind: "lost",
        attribution: "lost",
        rejectionReason: "malformed_json",
        costUsd: null,
        usage: null,
        streamOutcome: null,
      }),
    ]);
  });

  it("rehydrates complete rows with extra fields and skips trailing partial lines", async () => {
    process.env[apiKeyEnv] = credential;
    const scratch = await mkdtemp(
      join(tmpdir(), "rightmodeler-proxy-partial-"),
    );
    scratchDirectories.push(scratch);
    const stub = await startStub();
    const egress = await startEgress(stub);
    await mkdir(join(scratch, "proxy", "attempts"), { recursive: true });
    await mkdir(join(scratch, "proxy", "checkpoints"), { recursive: true });
    await writeFile(
      spoolPath(scratch),
      `${JSON.stringify({
        kind: "request_attempt",
        attemptId: "attempt-existing",
        logicalCallId: "logical-existing",
        attemptGroup: 1,
        costUsd: 0.01,
        futureField: "ignored",
      })}\n${JSON.stringify({ kind: "future_row", extra: true })}\n{"kind":`,
      "utf8",
    );
    await writeFile(
      checkpointPath(scratch),
      `${JSON.stringify({
        caseId,
        seqPos: 1,
        attemptGroup: 1,
        logicalCallId: "logical-existing",
        futureField: "ignored",
      })}\n{"caseId":`,
      "utf8",
    );

    const env = runtimeEnv({ scratch, egressUrl: egress.url });
    const scriptPath = await createRuntimeBundle();
    const runtime = await startRuntime(env, scriptPath);

    expect(runtime.port).toBeGreaterThan(0);
    const response = await callProxy(
      runtime,
      "step-existing",
      "logical-existing",
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await stopRuntime(runtime);

    const restarted = await startRuntime(env, scriptPath);
    expect(restarted.port).toBeGreaterThan(0);
  });

  it("fails startup loudly when the authoritative spool is malformed", async () => {
    process.env[apiKeyEnv] = credential;
    const scratch = await mkdtemp(
      join(tmpdir(), "rightmodeler-proxy-corrupt-"),
    );
    scratchDirectories.push(scratch);
    const stub = await startStub();
    const egress = await startEgress(stub);
    await mkdir(join(scratch, "proxy", "attempts"), { recursive: true });
    await writeFile(spoolPath(scratch), "not-json\n", "utf8");

    await expect(
      startRuntime(
        runtimeEnv({ scratch, egressUrl: egress.url }),
        await createRuntimeBundle(),
      ),
    ).rejects.toThrow("attempt spool has malformed JSON on line 1");
  });
});
