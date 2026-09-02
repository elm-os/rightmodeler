import type {
  OpenSwapPrToolInput,
  ReplayStartInput,
  ReplayStartToolInput,
} from "./schemas.js";

export interface OpenSwapPrInput extends OpenSwapPrToolInput {
  readonly owner: string;
  readonly githubBaseUrl: string;
  readonly githubTokenEnv: string;
}

export function resolveReplayInput(
  input: ReplayStartToolInput,
): ReplayStartInput {
  const traces = requiredDefault(input.traces, "traces", "RIGHTMODELER_TRACES");
  const baseUrl = requiredDefault(
    input.baseUrl,
    "baseUrl",
    "RIGHTMODELER_PROVIDER_BASE_URL",
  );
  const apiKeyEnv = input.apiKeyEnv ?? process.env.RIGHTMODELER_API_KEY_ENV;
  return {
    ...input,
    traces,
    baseUrl,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  };
}

export function resolveOpenSwapPrInput(
  input: OpenSwapPrToolInput,
): OpenSwapPrInput {
  return {
    ...input,
    owner: requiredDefault(input.owner, "owner", "RIGHTMODELER_GITHUB_OWNER"),
    githubBaseUrl:
      input.githubBaseUrl ??
      process.env.RIGHTMODELER_GITHUB_API_BASE_URL ??
      "https://api.github.com",
    githubTokenEnv:
      input.githubTokenEnv ??
      process.env.RIGHTMODELER_GITHUB_TOKEN_ENV ??
      "GITHUB_TOKEN",
  };
}

function requiredDefault(
  value: string | undefined,
  field: string,
  variable: string,
): string {
  const resolved = value ?? process.env[variable];
  if (resolved !== undefined && resolved.length > 0) return resolved;
  throw new Error(`${field} was omitted and ${variable} is not configured`);
}
