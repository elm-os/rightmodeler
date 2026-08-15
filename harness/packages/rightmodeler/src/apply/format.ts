import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { lintSwapDiff } from "./difflint.js";
import type { SwapDiffFile } from "./diff.js";

export type HostFormatterKind = "gofmt" | "prettier" | "ruff";

export interface HostConventions {
  readonly formatter: {
    readonly kind: HostFormatterKind | null;
    readonly configPath: string | null;
  };
}

export interface FormatterBlocker {
  readonly path: string;
  readonly line: number;
  readonly reason: "formatter_conflict" | "formatter_failed";
}

export interface FormatResult {
  readonly files: readonly SwapDiffFile[];
  readonly note?: "formatted" | "formatter_unavailable" | "no_formatter";
  readonly blocker?: FormatterBlocker;
}

interface FormatterCommand {
  readonly executable: string;
  readonly args: (filePath: string) => string[];
  readonly stdin: boolean;
}

function pinnedPrettierVersion(repoDir: string): string | null {
  const pnpmLock = join(repoDir, "pnpm-lock.yaml");
  if (existsSync(pnpmLock)) {
    const match = /^  prettier@([^:\s(]+)(?:\([^\n]*)?:/m.exec(
      readFileSync(pnpmLock, "utf8"),
    );
    if (match !== null) return match[1]!;
  }

  const packageLock = join(repoDir, "package-lock.json");
  if (existsSync(packageLock)) {
    const parsed: unknown = JSON.parse(readFileSync(packageLock, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "packages" in parsed) {
      const packages = parsed.packages;
      if (
        typeof packages === "object" &&
        packages !== null &&
        "node_modules/prettier" in packages
      ) {
        const prettier = packages["node_modules/prettier"];
        if (
          typeof prettier === "object" &&
          prettier !== null &&
          "version" in prettier &&
          typeof prettier.version === "string"
        ) {
          return prettier.version;
        }
      }
    }
  }

  const yarnLock = join(repoDir, "yarn.lock");
  if (existsSync(yarnLock)) {
    return (
      /(?:^|\n)["']?prettier@[^\n]+:\n\s+version\s+["']([^"']+)["']/.exec(
        readFileSync(yarnLock, "utf8"),
      )?.[1] ?? null
    );
  }
  return null;
}

function formatterCommand(
  repoDir: string,
  formatter: HostConventions["formatter"],
): FormatterCommand | null {
  const { kind, configPath } = formatter;
  const configArgs =
    configPath === null ? [] : ["--config", join(repoDir, configPath)];
  if (kind === "prettier") {
    const executable = join(
      repoDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "prettier.cmd" : "prettier",
    );
    if (existsSync(executable)) {
      return {
        executable,
        args: (filePath) => ["--stdin-filepath", filePath, ...configArgs],
        stdin: true,
      };
    }
    const version = pinnedPrettierVersion(repoDir);
    return version === null || !/^\d+\.\d+\.\d+[\w.+-]*$/.test(version)
      ? null
      : {
          executable: process.platform === "win32" ? "npx.cmd" : "npx",
          args: (filePath) => [
            "--yes",
            `--package=prettier@${version}`,
            "prettier",
            "--stdin-filepath",
            filePath,
            ...configArgs,
          ],
          stdin: true,
        };
  }
  if (kind === "ruff") {
    const local = join(
      repoDir,
      ".venv",
      process.platform === "win32" ? "Scripts/ruff.exe" : "bin/ruff",
    );
    return {
      executable: existsSync(local) ? local : "ruff",
      args: (filePath) => ["format", filePath, ...configArgs],
      stdin: false,
    };
  }
  if (kind === "gofmt") {
    return {
      executable: "gofmt",
      args: (filePath) => ["-w", filePath],
      stdin: false,
    };
  }
  return null;
}

function runFormatter(
  command: FormatterCommand,
  filePath: string,
  cwd: string,
  input: string,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command.executable,
      command.args(filePath),
      { cwd, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) reject(error);
        else resolve(command.stdin ? stdout : null);
      },
    );
    if (command.stdin) child.stdin?.end(input);
  });
}

function firstOutsideTouchedLine(
  before: string,
  after: string,
  touchedLines: ReadonlySet<number>,
): number | null {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length !== afterLines.length) {
    const sharedLength = Math.min(beforeLines.length, afterLines.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (beforeLines[index] !== afterLines[index]) return index + 1;
    }
    return sharedLength + 1;
  }
  for (let index = 0; index < beforeLines.length; index += 1) {
    if (
      beforeLines[index] !== afterLines[index] &&
      !touchedLines.has(index + 1)
    ) {
      return index + 1;
    }
  }
  return null;
}

function isMissingExecutable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function formatWithHostFormatter({
  repoDir,
  conventions,
  files,
}: {
  readonly repoDir: string;
  readonly conventions: HostConventions;
  readonly files: readonly SwapDiffFile[];
}): Promise<FormatResult> {
  const command = formatterCommand(repoDir, conventions.formatter);
  if (command === null) {
    return {
      files,
      note:
        conventions.formatter.kind === null
          ? "no_formatter"
          : "formatter_unavailable",
    };
  }

  const formattedFiles: SwapDiffFile[] = [];
  for (const [fileIndex, file] of files.entries()) {
    const sourcePath = join(repoDir, file.path);
    let temporaryDirectory: string | null = null;
    try {
      if (!command.stdin) {
        temporaryDirectory = await mkdtemp(
          join(dirname(sourcePath), ".rightmodeler-format-"),
        );
        writeFileSync(
          join(temporaryDirectory, basename(sourcePath)),
          file.after,
          "utf8",
        );
      }
      const temporaryPath =
        temporaryDirectory === null
          ? sourcePath
          : join(temporaryDirectory, basename(sourcePath));
      const stdout = await runFormatter(
        command,
        command.stdin ? sourcePath : temporaryPath,
        repoDir,
        file.after,
      );
      const formatted =
        stdout === null ? await readFile(temporaryPath, "utf8") : stdout;
      const touchedLines = new Set(file.hunks.map(({ line }) => line));
      const conflictLine = firstOutsideTouchedLine(
        file.after,
        formatted,
        touchedLines,
      );
      if (conflictLine !== null) {
        return {
          files: [...formattedFiles, ...files.slice(fileIndex)],
          ...(formattedFiles.length > 0 ? { note: "formatted" as const } : {}),
          blocker: {
            path: file.path,
            line: conflictLine,
            reason: "formatter_conflict",
          },
        };
      }

      const lint = lintSwapDiff({
        files: [
          {
            path: file.path,
            before: file.before,
            after: formatted,
            replacements: file.hunks.flatMap(({ replacements }) =>
              replacements.map(({ from, to }) => ({ from, to })),
            ),
          },
        ],
      });
      if (!lint.pass) {
        return {
          files: [...formattedFiles, ...files.slice(fileIndex)],
          ...(formattedFiles.length > 0 ? { note: "formatted" as const } : {}),
          blocker: {
            path: file.path,
            line: lint.violations[0]!.line,
            reason: "formatter_conflict",
          },
        };
      }
      const formattedLines = formatted.split("\n");
      formattedFiles.push({
        ...file,
        after: formatted,
        hunks: file.hunks.map((hunk) => ({
          ...hunk,
          after: formattedLines[hunk.line - 1] ?? "",
        })),
      });
    } catch (error) {
      if (isMissingExecutable(error)) {
        return {
          files: [...formattedFiles, ...files.slice(fileIndex)],
          note: "formatter_unavailable",
        };
      }
      return {
        files: [...formattedFiles, ...files.slice(fileIndex)],
        ...(formattedFiles.length > 0 ? { note: "formatted" as const } : {}),
        blocker: { path: file.path, line: 1, reason: "formatter_failed" },
      };
    } finally {
      if (temporaryDirectory !== null) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  return { files: formattedFiles, note: "formatted" };
}
