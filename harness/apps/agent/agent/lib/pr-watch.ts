import { runCli } from "./cli.js";
import {
  scheduleCliTimeoutMs,
  type ScheduleHarnessInput,
} from "./schedules.js";

export function githubTokenEnvName(): string {
  const tokenEnv = process.env.RIGHTMODELER_GITHUB_TOKEN_ENV ?? "GITHUB_TOKEN";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv)) {
    throw new Error(
      "RIGHTMODELER_GITHUB_TOKEN_ENV must name an environment variable",
    );
  }
  return tokenEnv;
}

export function watchPullRequest(
  input: ScheduleHarnessInput,
  owner: string,
  repo: string,
  prNumber: number,
) {
  return runCli(
    "watch",
    [
      "--owner",
      owner,
      "--github-repo",
      repo,
      "--pr",
      String(prNumber),
      "--github-base-url",
      process.env.RIGHTMODELER_GITHUB_API_BASE_URL ?? "https://api.github.com",
      "--github-token-env",
      githubTokenEnvName(),
    ],
    {
      ...input,
      acceptedExitCodes: [0, 1, 2],
      timeoutMs: scheduleCliTimeoutMs,
    },
  );
}

export async function watchPullRequestOnEvent(
  source: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const harnessRepo = process.env.RIGHTMODELER_REPO;
  if (harnessRepo === undefined || harnessRepo.length === 0) {
    console.warn(
      `${source} webhook skipped: RIGHTMODELER_REPO is not configured`,
    );
    return;
  }
  const tokenEnv = githubTokenEnvName();
  if (!process.env[tokenEnv]) {
    console.warn(`${source} webhook skipped: ${tokenEnv} is not configured`);
    return;
  }
  const store = process.env.RIGHTMODELER_STORE;
  await watchPullRequest(
    {
      repo: harnessRepo,
      ...(store === undefined ? {} : { store }),
    },
    owner,
    repo,
    prNumber,
  );
}
