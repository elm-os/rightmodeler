import { execFile } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitFixtureAuthor {
  readonly name: string;
  readonly email: string;
  readonly date?: string;
}

const defaultAuthor: GitFixtureAuthor = {
  name: "Fixture Author",
  email: "fixture@example.com",
};

async function git(
  repoDir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args], { env });
}

export async function commitGitFixture(
  repoDir: string,
  subject: string,
  author: GitFixtureAuthor = defaultAuthor,
): Promise<void> {
  await git(repoDir, ["config", "user.name", author.name]);
  await git(repoDir, ["config", "user.email", author.email]);
  await git(repoDir, ["add", "--all"]);
  const env =
    author.date === undefined
      ? process.env
      : {
          ...process.env,
          GIT_AUTHOR_DATE: author.date,
          GIT_COMMITTER_DATE: author.date,
        };
  await git(repoDir, ["commit", "--allow-empty", "--message", subject], env);
}

export async function makeGitFixture(
  rootDir: string,
  sourceDir?: string,
  name = "repo",
): Promise<string> {
  const repoDir = join(rootDir, name);
  if (sourceDir === undefined) {
    await mkdir(repoDir, { recursive: true });
  } else {
    await cp(sourceDir, repoDir, { recursive: true });
  }
  await git(repoDir, ["init", "--initial-branch", "main"]);
  await commitGitFixture(repoDir, "Seed fixture");
  return repoDir;
}
