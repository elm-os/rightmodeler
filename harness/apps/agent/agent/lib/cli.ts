import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export type JsonValue =
  boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

interface CliRunOptions {
  repo: string;
  store?: string;
  acceptedExitCodes?: readonly number[];
}

interface CapturedProcess {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const require = createRequire(import.meta.url);

export function rightmodelerCliPath(): string {
  return require.resolve("@rightmodeler/cli");
}

export function cliEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  return environment;
}

export function cliArguments(
  command: string,
  commandArguments: readonly string[],
  options: Pick<CliRunOptions, "repo" | "store">,
): string[] {
  const args = [
    rightmodelerCliPath(),
    "--repo",
    resolve(options.repo),
    "--output",
    "json",
  ];
  if (options.store !== undefined) {
    args.push("--store", resolve(options.store));
  }
  args.push(command, ...commandArguments);
  return args;
}

export async function runCli(
  command: string,
  commandArguments: readonly string[],
  options: CliRunOptions,
): Promise<{ exitCode: number; result: { [key: string]: JsonValue } }> {
  const processResult = await captureProcess(
    process.execPath,
    cliArguments(command, commandArguments, options),
    resolve(options.repo),
  );
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  if (
    processResult.code === null ||
    !acceptedExitCodes.includes(processResult.code)
  ) {
    throw cliFailure(command, processResult);
  }

  return {
    exitCode: processResult.code,
    result: parseJsonObject(processResult.stdout, `${command} stdout`),
  };
}

async function captureProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<CapturedProcess> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd,
      env: cliEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectProcess);
    child.once("close", (code, signal) => {
      resolveProcess({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function parseJsonObject(
  value: string,
  source: string,
): { [key: string]: JsonValue } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${source} was not valid JSON.`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must contain one JSON object.`);
  }
  return parsed as { [key: string]: JsonValue };
}

function cliFailure(command: string, result: CapturedProcess): Error {
  const detail = parseCliError(result.stderr);
  const exit =
    result.code === null ? `signal ${result.signal}` : `exit ${result.code}`;
  return new Error(`rightmodeler ${command} failed with ${exit}: ${detail}`);
}

function parseCliError(stderr: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stderr);
  } catch {
    return stderr;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).message !== "string"
  ) {
    throw new Error("rightmodeler emitted an invalid JSON error object.");
  }
  const errorObject = parsed as Record<string, unknown>;
  const remedy =
    typeof errorObject.remedy === "string"
      ? ` Remedy: ${errorObject.remedy}`
      : "";
  return `${errorObject.message as string}${remedy}`;
}
