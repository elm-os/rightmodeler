import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maximumBlameOwners = 3;

export interface RankedOwner {
  readonly handle: string;
  readonly source: "codeowners" | "blame";
}

export type OwnerResolutionReason =
  "codeowners_rule_without_owners" | "no_codeowners_match_or_blame";

export interface OwnerResolution {
  readonly path: string;
  readonly owners: readonly RankedOwner[];
  readonly reason?: OwnerResolutionReason;
}

interface CodeownersRule {
  readonly pattern: string;
  readonly owners: readonly string[];
}

interface BlameCommitter {
  lines: number;
  latestCommitterTime: number;
}

const codeownersPaths = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(repoDir: string, filePath: string): string {
  const path = isAbsolute(filePath) ? relative(repoDir, filePath) : filePath;
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\//, "");
}

async function findCodeowners(repoDir: string): Promise<string | null> {
  for (const path of codeownersPaths) {
    try {
      await access(join(repoDir, path));
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

function tokens(line: string): string[] {
  const result: string[] = [];
  let token = "";
  let escaped = false;

  for (const character of line) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "#") break;
    if (/\s/.test(character)) {
      if (token !== "") {
        result.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  if (token !== "") result.push(token);
  return result;
}

function validOwner(value: string): boolean {
  return (
    /^@[A-Za-z0-9](?:[A-Za-z0-9_-]*)(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)?$/.test(
      value,
    ) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

export function parseCodeowners(content: string): readonly CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trimStart().startsWith("\\#")) continue;
    const [pattern, ...owners] = tokens(line);
    if (
      pattern === undefined ||
      pattern.startsWith("!") ||
      pattern.includes("[") ||
      pattern.includes("]") ||
      pattern.includes("***") ||
      owners.some((owner) => !validOwner(owner))
    ) {
      continue;
    }
    rules.push({ pattern, owners });
  }
  return rules;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function patternBody(pattern: string): string {
  let body = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character !== "*") {
      body += character === "?" ? "[^/]" : escapeRegex(character);
      continue;
    }

    const next = pattern[index + 1];
    if (next !== "*") {
      body += "[^/]*";
      continue;
    }

    while (pattern[index + 1] === "*") index += 1;
    if (pattern[index + 1] === "/") {
      index += 1;
      body += "(?:.*/)?";
    } else {
      body += ".*";
    }
  }
  return body;
}

function codeownersRegex(pattern: string): RegExp {
  const anchored =
    pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
  const directory = pattern.endsWith("/");
  const normalized = pattern.replace(/^\//, "").replace(/\/$/, "");
  const exactPath = !/[*?]/.test(normalized);
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const descendants =
    directory ||
    exactPath ||
    pattern.endsWith("/**") ||
    /^\*\*\/[^*?/]+$/.test(pattern)
      ? "(?:/.*)?"
      : "";
  return new RegExp(`${prefix}${patternBody(normalized)}${descendants}$`);
}

function matchingRule(
  rules: readonly CodeownersRule[],
  filePath: string,
): CodeownersRule | null {
  let matched: CodeownersRule | null = null;
  for (const rule of rules) {
    if (codeownersRegex(rule.pattern).test(filePath)) matched = rule;
  }
  return matched;
}

function blameCommitters(output: string): readonly RankedOwner[] {
  const committers = new Map<string, BlameCommitter>();
  let email: string | null = null;
  let committerTime = 0;

  for (const line of output.split(/\r?\n/)) {
    if (/^[0-9a-f^]{40,64} \d+ \d+(?: \d+)?$/.test(line)) {
      email = null;
      committerTime = 0;
    } else if (line.startsWith("committer-mail ")) {
      email = line.slice("committer-mail ".length).replace(/^<|>$/g, "");
    } else if (line.startsWith("committer-time ")) {
      committerTime =
        Number.parseInt(line.slice("committer-time ".length), 10) || 0;
    } else if (line.startsWith("\t") && email !== null) {
      const committer = committers.get(email) ?? {
        lines: 0,
        latestCommitterTime: 0,
      };
      committer.lines += 1;
      committer.latestCommitterTime = Math.max(
        committer.latestCommitterTime,
        committerTime,
      );
      committers.set(email, committer);
    }
  }

  return [...committers.entries()]
    .sort(
      ([leftEmail, left], [rightEmail, right]) =>
        right.latestCommitterTime - left.latestCommitterTime ||
        right.lines - left.lines ||
        compareText(leftEmail, rightEmail),
    )
    .slice(0, maximumBlameOwners)
    .map(([handle]) => ({ handle, source: "blame" as const }));
}

async function ownersFromBlame(
  repoDir: string,
  filePath: string,
): Promise<readonly RankedOwner[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "blame", "--line-porcelain", "--", filePath],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return blameCommitters(stdout);
  } catch {
    return [];
  }
}

export async function resolveOwners({
  repoDir,
  filePaths,
}: {
  readonly repoDir: string;
  readonly filePaths: readonly string[];
}): Promise<readonly OwnerResolution[]> {
  const codeownersPath = await findCodeowners(repoDir);
  const rules =
    codeownersPath === null
      ? []
      : parseCodeowners(await readFile(join(repoDir, codeownersPath), "utf8"));

  return Promise.all(
    filePaths.map(async (inputPath) => {
      const path = repositoryPath(repoDir, inputPath);
      const rule = matchingRule(rules, path);
      if (rule !== null) {
        return rule.owners.length === 0
          ? {
              path,
              owners: [],
              reason: "codeowners_rule_without_owners" as const,
            }
          : {
              path,
              owners: rule.owners.map((handle) => ({
                handle,
                source: "codeowners" as const,
              })),
            };
      }

      const owners = await ownersFromBlame(repoDir, path);
      return owners.length === 0
        ? {
            path,
            owners,
            reason: "no_codeowners_match_or_blame" as const,
          }
        : { path, owners };
    }),
  );
}
