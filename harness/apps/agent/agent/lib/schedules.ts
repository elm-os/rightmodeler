import type { GitHubReceiveTarget } from "eve/channels/github";
import type { ScheduleHandlerArgs } from "eve/schedules";

import github from "../channels/github.js";
import type { ReplayStartInput } from "./schemas.js";

export interface ScheduleHarnessInput {
  readonly repo: string;
  readonly store?: string;
}

export function scheduleHarnessInput(
  schedule: string,
): ScheduleHarnessInput | undefined {
  const repo = requiredEnvironment(schedule, "RIGHTMODELER_REPO");
  if (repo === undefined) return undefined;
  const store = process.env.RIGHTMODELER_STORE;
  return { repo, ...(store === undefined ? {} : { store }) };
}

export function scheduleReplayInput(
  schedule: string,
): ReplayStartInput | undefined {
  const harness = scheduleHarnessInput(schedule);
  const traces = requiredEnvironment(schedule, "RIGHTMODELER_TRACES");
  const baseUrl = requiredEnvironment(
    schedule,
    "RIGHTMODELER_PROVIDER_BASE_URL",
  );
  if (harness === undefined || traces === undefined || baseUrl === undefined) {
    return undefined;
  }
  const maxCostUsd = optionalPositiveNumber("RIGHTMODELER_MAX_COST_USD");
  return {
    ...harness,
    traces,
    baseUrl,
    ...(process.env.RIGHTMODELER_MODEB_CONFIG === undefined
      ? {}
      : { modeBConfig: process.env.RIGHTMODELER_MODEB_CONFIG }),
    ...(process.env.RIGHTMODELER_API_KEY_ENV === undefined
      ? {}
      : { apiKeyEnv: process.env.RIGHTMODELER_API_KEY_ENV }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  };
}

export function scheduleGitHubTarget(
  schedule: string,
): GitHubReceiveTarget | undefined {
  const appId = requiredEnvironment(schedule, "GITHUB_APP_ID");
  const privateKey = requiredEnvironment(schedule, "GITHUB_APP_PRIVATE_KEY");
  const owner = requiredEnvironment(schedule, "RIGHTMODELER_GITHUB_OWNER");
  const repo = requiredEnvironment(schedule, "RIGHTMODELER_GITHUB_REPO");
  const issue = requiredEnvironment(
    schedule,
    "RIGHTMODELER_GITHUB_REPORT_ISSUE",
  );
  const installation = requiredEnvironment(
    schedule,
    "RIGHTMODELER_GITHUB_INSTALLATION_ID",
  );
  if (
    appId === undefined ||
    privateKey === undefined ||
    owner === undefined ||
    repo === undefined ||
    issue === undefined ||
    installation === undefined
  ) {
    return undefined;
  }
  const issueNumber = positiveInteger(
    "RIGHTMODELER_GITHUB_REPORT_ISSUE",
    issue,
  );
  return {
    owner,
    repo,
    issueNumber,
    installationId: positiveInteger(
      "RIGHTMODELER_GITHUB_INSTALLATION_ID",
      installation,
    ),
  };
}

export function handOffSchedule(
  args: ScheduleHandlerArgs,
  target: GitHubReceiveTarget,
  message: string,
): void {
  args.waitUntil(args.to(github, target).send(message, { auth: args.appAuth }));
}

function requiredEnvironment(
  schedule: string,
  name: string,
): string | undefined {
  const value = process.env[name];
  if (value !== undefined && value.length > 0) return value;
  console.warn(`${schedule} schedule skipped: ${name} is not configured`);
  return undefined;
}

function optionalPositiveNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must contain positive integers`);
  }
  return parsed;
}
