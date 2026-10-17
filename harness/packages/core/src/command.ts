import { lstatSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

export interface CommandLaunch {
  readonly file: string;
  readonly args: readonly string[];
}

const PROGRAM_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];
const SCRIPT_EXTENSIONS = [".JS", ".CJS", ".MJS"];

// Node refuses to start .cmd and .bat files without a shell, and a shell would reparse every
// argument. So on Windows this finds the command on PATH as cmd.exe would, but never in the
// current folder, and returns the program an npm or pnpm .cmd shim would run. Elsewhere the
// command is returned unchanged.
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandLaunch {
  if (process.platform !== "win32") return { file: command, args: [] };
  const extensions = (envValue(env, "PATHEXT") ?? PROGRAM_EXTENSIONS.join(";"))
    .toUpperCase()
    .split(";")
    .filter((extension) => PROGRAM_EXTENSIONS.includes(extension));
  const found = findProgram(command, env, extensions);
  if (found === undefined) {
    throw launchError("ENOENT", command, `${command} is not on PATH.`);
  }
  return launchFor(found);
}

// npm and pnpm shims end by running "<interpreter>" "<target>" %*, where the target is
// relative to the shim's folder (%~dp0 or %dp0%) or, across drives, absolute.
export function cmdShimTarget(
  text: string,
): { readonly path: string; readonly node: boolean } | undefined {
  const matches = [
    ...text.matchAll(
      /"(?:(?:%~dp0|%dp0%)\\*|(?=[A-Za-z]:\\))([^"%]+)"\s+%\*/gu,
    ),
  ];
  const path = matches.at(-1)?.[1];
  if (path === undefined) return undefined;
  if (/\.(?:exe|com)$/iu.test(path)) return { path, node: false };
  if (/\.(?:bat|cmd)$/iu.test(path) || !/\bnode(?:\.exe)?\b/iu.test(text)) {
    return undefined;
  }
  return { path, node: true };
}

function findProgram(
  command: string,
  env: NodeJS.ProcessEnv,
  extensions: readonly string[],
): string | undefined {
  const extension = extname(command).toUpperCase();
  const named =
    extensions.includes(extension) || SCRIPT_EXTENSIONS.includes(extension);
  const candidates = (base: string): string[] =>
    named ? [base] : extensions.map((suffix) => base + suffix);
  if (/[\\/]/u.test(command)) return candidates(resolve(command)).find(isFile);
  const path = envValue(env, "PATH") ?? process.env.PATH ?? "";
  for (const entry of path.split(";")) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (!isAbsolute(directory)) continue;
    const found = candidates(join(directory, command)).find(isFile);
    if (found !== undefined) return found;
  }
  return undefined;
}

function launchFor(file: string): CommandLaunch {
  const extension = extname(file).toUpperCase();
  if (SCRIPT_EXTENSIONS.includes(extension)) {
    return { file: process.execPath, args: [file] };
  }
  if (extension !== ".CMD" && extension !== ".BAT") return { file, args: [] };
  const target = cmdShimTarget(readFileSync(file, "utf8"));
  if (target !== undefined) {
    const program = resolve(dirname(file), target.path);
    return target.node
      ? { file: process.execPath, args: [program] }
      : { file: program, args: [] };
  }
  // Node's own npm.cmd and npx.cmd name their script through variables.
  const name = basename(file, extname(file)).toLowerCase();
  const cli = join(
    dirname(file),
    "node_modules",
    "npm",
    "bin",
    `${name}-cli.js`,
  );
  if ((name === "npm" || name === "npx") && isFile(cli)) {
    return { file: process.execPath, args: [cli] };
  }
  throw launchError(
    "EINVAL",
    file,
    `${file} is a script that rightmodeler cannot start without a shell.`,
  );
}

// Node uses the first name in sorted order when names differ only in letter case.
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function launchError(
  code: "EINVAL" | "ENOENT",
  path: string,
  message: string,
): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    code,
    path,
    syscall: `spawn ${path}`,
  });
}
