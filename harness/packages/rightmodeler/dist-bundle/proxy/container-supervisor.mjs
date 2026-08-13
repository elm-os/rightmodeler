import { spawn } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";

const APP_ROOT = "/rightmodeler/app";

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("Supervisor config is required");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const scratch = process.env.RM_SCRATCH;
if (scratch === undefined || scratch.length === 0) {
  throw new Error("RM_SCRATCH is required");
}

const driverDirectory = join(scratch, "driver");
const workloadDirectory = join(scratch, "workload");
const proxyDirectory = join(scratch, "proxy");
mkdirSync(driverDirectory, { recursive: true });
mkdirSync(workloadDirectory, { recursive: true });
mkdirSync(proxyDirectory, { recursive: true });
const statusPath = join(driverDirectory, "status.json");
const heartbeat = setInterval(
  () => writeFileSync(join(scratch, ".heartbeat"), new Date().toISOString()),
  500,
);
heartbeat.unref();

function start(command, stdoutPath, stderrPath, flags = "w") {
  const stdout = createWriteStream(stdoutPath, { flags });
  const stderr = createWriteStream(stderrPath, { flags });
  const child = spawn(command[0], command.slice(1), {
    cwd: APP_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, closed, stdout, stderr };
}

async function waitForRun(running) {
  let result;
  try {
    result = await running.closed;
  } catch (error) {
    running.stdout.destroy();
    running.stderr.destroy();
    throw error;
  }
  await Promise.all([finished(running.stdout), finished(running.stderr)]);
  return result;
}

async function execute(command, label) {
  return waitForRun(
    start(
      command,
      join(workloadDirectory, `${label}-stdout.log`),
      join(workloadDirectory, `${label}-stderr.log`),
      "a",
    ),
  );
}

async function startProxy() {
  const running = start(
    [process.execPath, "/rightmodeler/runtime/proxy/proxy-runtime.mjs"],
    join(proxyDirectory, "stdout.log"),
    join(proxyDirectory, "stderr.log"),
    "a",
  );
  let pending = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Proxy readiness timed out")),
      10_000,
    );
    running.child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    running.child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Proxy exited before readiness: ${String(code)}`));
    });
    running.child.stdout.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.event === "ready" && event.port === 8787) {
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch {
          // Proxy diagnostics may precede its structured readiness line.
        }
        newline = pending.indexOf("\n");
      }
    });
  });
  return running;
}

async function stopProxy(proxy) {
  if (proxy.child.exitCode === null && proxy.child.signalCode === null) {
    proxy.child.kill("SIGTERM");
    await Promise.race([
      proxy.closed,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (proxy.child.exitCode === null && proxy.child.signalCode === null) {
      proxy.child.kill("SIGKILL");
    }
  }
  await proxy.closed;
  await Promise.all([finished(proxy.stdout), finished(proxy.stderr)]);
}

let phase = "install";
let proxy;
try {
  if (config.installCommand !== undefined) {
    const installed = await execute(config.installCommand, "install");
    if (installed.code !== 0) {
      writeFileSync(statusPath, JSON.stringify({ phase, ...installed }));
      process.exitCode = installed.code ?? 1;
    }
  }

  if (process.exitCode === undefined) {
    phase = "proxy";
    proxy = await startProxy();
    phase = "workload";
    const workload = await waitForRun(
      start(
        config.command,
        join(workloadDirectory, "stdout.jsonl"),
        join(workloadDirectory, "stderr.log"),
      ),
    );
    writeFileSync(statusPath, JSON.stringify({ phase, ...workload }));
    await stopProxy(proxy);
    proxy = undefined;
    process.exitCode = workload.code ?? 1;
  }
} catch (error) {
  writeFileSync(
    statusPath,
    JSON.stringify({
      phase,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (proxy !== undefined) await stopProxy(proxy);
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
}
