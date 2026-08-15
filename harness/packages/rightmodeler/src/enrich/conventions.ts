import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { codeownersPaths, compareText } from "./shared.js";

const execFileAsync = promisify(execFile);

export interface ConventionWarning {
  readonly name:
    | "instruction_file_unreadable"
    | "instruction_include_cycle"
    | "instruction_include_unreadable";
  readonly path: string;
  readonly includedFrom?: string;
}

export interface CapturedConventions {
  readonly version: "1";
  readonly instructionFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly prTemplate: string | null;
  readonly codeowners: string | null;
  readonly formatter: {
    readonly kind: "prettier" | "ruff" | "gofmt" | null;
    readonly configPath: string | null;
  };
  readonly commitConvention: {
    readonly style: "conventional" | "plain";
    readonly inferredFrom: readonly string[];
  };
  readonly branchPrefix: string | null;
  readonly warnings: readonly ConventionWarning[];
}

const pullRequestTemplates = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
] as const;
const prettierConfigs = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
] as const;

function posixPath(repoDir: string, absolutePath: string): string {
  return relative(repoDir, absolutePath).replaceAll("\\", "/");
}

async function existingPath(
  repoDir: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const path of candidates) {
    try {
      await access(join(repoDir, path));
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

async function nestedAgentFiles(repoDir: string): Promise<string[]> {
  return (await gitOutput(repoDir, ["ls-files", "--", "*AGENTS.md"]))
    .split(/\r?\n/)
    .filter((path) => path === "AGENTS.md" || path.endsWith("/AGENTS.md"));
}

function includeTargets(content: string): string[] {
  const targets: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const include = line.match(/^\s*@include\s+(.+?)\s*$/)?.[1];
    if (include?.endsWith(".md")) {
      targets.push(include);
      continue;
    }
    const pointer = line.match(/^\s*@([^\s]+\.md)\s*$/)?.[1];
    if (pointer !== undefined) targets.push(pointer);
  }
  return targets;
}

function includePath(
  repoDir: string,
  includedFrom: string,
  target: string,
): { absolute: string; relative: string } {
  const absolute = target.startsWith("/")
    ? resolve(repoDir, target.slice(1))
    : resolve(repoDir, dirname(includedFrom), target);
  return { absolute, relative: posixPath(repoDir, absolute) };
}

async function captureInstructionFiles(repoDir: string): Promise<{
  files: CapturedConventions["instructionFiles"];
  warnings: ConventionWarning[];
}> {
  const rootFiles = (
    await Promise.all(
      ["AGENTS.md", "CLAUDE.md"].map(async (path) => {
        try {
          await access(join(repoDir, path));
          return path;
        } catch {
          return null;
        }
      }),
    )
  ).filter((path): path is string => path !== null);
  const seeds = [
    ...new Set([...rootFiles, ...(await nestedAgentFiles(repoDir))]),
  ];
  const files = new Map<string, string>();
  const warnings: ConventionWarning[] = [];
  const warningKeys = new Set<string>();

  function warn(warning: ConventionWarning): void {
    const key = JSON.stringify(warning);
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  }

  async function capture(
    path: string,
    depth: number,
    stack: readonly string[],
    includedFrom?: string,
  ): Promise<void> {
    let content: string;
    try {
      content = await readFile(join(repoDir, path), "utf8");
    } catch {
      warn(
        includedFrom === undefined
          ? { name: "instruction_file_unreadable", path }
          : {
              name: "instruction_include_unreadable",
              path,
              includedFrom,
            },
      );
      return;
    }
    files.set(path, content);

    for (const target of includeTargets(content)) {
      const included = includePath(repoDir, path, target);
      if (stack.includes(included.relative) || included.relative === path) {
        warn({
          name: "instruction_include_cycle",
          path: included.relative,
          includedFrom: path,
        });
        continue;
      }
      if (depth < 1) {
        await capture(included.relative, depth + 1, [...stack, path], path);
      }
    }
  }

  for (const seed of seeds.sort(compareText)) {
    await capture(seed, 0, []);
  }

  return {
    files: [...files.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, content]) => ({ path, content })),
    warnings: warnings.sort(
      (left, right) =>
        compareText(left.name, right.name) ||
        compareText(left.path, right.path) ||
        compareText(left.includedFrom ?? "", right.includedFrom ?? ""),
    ),
  };
}

async function readFirst(
  repoDir: string,
  candidates: readonly string[],
): Promise<string | null> {
  const path = await existingPath(repoDir, candidates);
  return path === null ? null : readFile(join(repoDir, path), "utf8");
}

async function detectFormatter(
  repoDir: string,
): Promise<CapturedConventions["formatter"]> {
  const prettier = await existingPath(repoDir, prettierConfigs);
  if (prettier !== null) return { kind: "prettier", configPath: prettier };

  const ruff = await existingPath(repoDir, ["ruff.toml", ".ruff.toml"]);
  if (ruff !== null) return { kind: "ruff", configPath: ruff };

  const pyproject = await existingPath(repoDir, ["pyproject.toml"]);
  if (
    pyproject !== null &&
    /^\s*\[tool\.ruff(?:\.[^\]]+)?\]\s*$/m.test(
      await readFile(join(repoDir, pyproject), "utf8"),
    )
  ) {
    return { kind: "ruff", configPath: pyproject };
  }

  const goModule = await existingPath(repoDir, ["go.mod"]);
  if (goModule !== null) return { kind: "gofmt", configPath: goModule };
  return { kind: null, configPath: null };
}

async function gitOutput(
  repoDir: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return "";
  }
}

async function inferCommitConvention(
  repoDir: string,
): Promise<CapturedConventions["commitConvention"]> {
  const inferredFrom = (await gitOutput(repoDir, ["log", "-30", "--format=%s"]))
    .split(/\r?\n/)
    .filter((subject) => subject !== "");
  const conventional = inferredFrom.filter((subject) =>
    /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s+.+$/.test(
      subject,
    ),
  ).length;
  return {
    style:
      inferredFrom.length > 0 && conventional > inferredFrom.length / 2
        ? "conventional"
        : "plain",
    inferredFrom,
  };
}

async function inferBranchPrefix(repoDir: string): Promise<string | null> {
  const branches = (
    await gitOutput(repoDir, [
      "for-each-ref",
      "--sort=-committerdate",
      "--count=30",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
    ])
  )
    .split(/\r?\n/)
    .filter((branch) => branch !== "")
    .map((branch) =>
      branch.startsWith("refs/heads/")
        ? branch.slice("refs/heads/".length)
        : branch.replace(/^refs\/remotes\/[^/]+\//, ""),
    )
    .filter((branch) => branch !== "HEAD");
  const counts = new Map<string, number>();
  for (const branch of new Set(branches)) {
    const slash = branch.indexOf("/");
    if (slash < 1) continue;
    const prefix = branch.slice(0, slash + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    ([leftPrefix, leftCount], [rightPrefix, rightCount]) =>
      rightCount - leftCount || compareText(leftPrefix, rightPrefix),
  );
  if (ranked.length === 0) return null;
  return ranked[0]![0];
}

export async function captureConventions({
  repoDir,
}: {
  readonly repoDir: string;
}): Promise<CapturedConventions> {
  const instructions = await captureInstructionFiles(repoDir);
  return {
    version: "1",
    instructionFiles: instructions.files,
    prTemplate: await readFirst(repoDir, pullRequestTemplates),
    codeowners: await existingPath(repoDir, codeownersPaths),
    formatter: await detectFormatter(repoDir),
    commitConvention: await inferCommitConvention(repoDir),
    branchPrefix: await inferBranchPrefix(repoDir),
    warnings: instructions.warnings,
  };
}
