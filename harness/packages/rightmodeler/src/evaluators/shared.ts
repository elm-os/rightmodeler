import { z } from "zod";

export interface ScoringConfig {
  readonly scorers: readonly string[];
  readonly gateMetric?: string;
  readonly gateThreshold?: number;
}

export interface ResolvedScoringConfig {
  readonly scorers: readonly string[];
  readonly gateMetric: string;
  readonly gateThreshold?: number;
}

export function resolveScoringConfig(
  config: ScoringConfig,
): ResolvedScoringConfig {
  if (config.scorers.length === 0) {
    throw new Error("At least one evaluator scorer must be configured");
  }
  if (config.scorers.some((scorer) => scorer.length === 0)) {
    throw new Error("Evaluator scorer names must not be empty");
  }
  if (new Set(config.scorers).size !== config.scorers.length) {
    throw new Error("Evaluator scorer names must not contain duplicates");
  }
  if (
    config.gateThreshold !== undefined &&
    !Number.isFinite(config.gateThreshold)
  ) {
    throw new Error("Evaluator gateThreshold must be a finite number");
  }
  const gateMetric =
    config.gateMetric ??
    (config.scorers.length === 1 ? config.scorers[0] : undefined);
  if (gateMetric === undefined) {
    throw new Error(
      `Multiple evaluator scorers are configured; choose --evaluator-gate-metric from: ${config.scorers.join(", ")}`,
    );
  }
  if (!config.scorers.includes(gateMetric)) {
    throw new Error(
      `Evaluator gate metric ${gateMetric} is not a configured scorer; choose from: ${config.scorers.join(", ")}`,
    );
  }
  return {
    scorers: [...config.scorers],
    gateMetric,
    ...(config.gateThreshold === undefined
      ? {}
      : { gateThreshold: config.gateThreshold }),
  };
}

export function requireText(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

export function environmentSecret(name: string, label: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} environment variable is not set: ${name}`);
  }
  return value;
}

export function redactSecrets(
  value: string,
  secrets: readonly string[],
): string {
  return secrets.reduce(
    (redacted, secret) =>
      secret.length === 0
        ? redacted
        : redacted.replaceAll(secret, "[redacted]"),
    value,
  );
}

export async function responseJson(
  response: Response,
  label: string,
  secrets: readonly string[],
): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${label} request failed with ${response.status}: ${redactSecrets(text, secrets)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${label} returned invalid JSON: ${redactSecrets(text, secrets)}`,
    );
  }
}

export function apiRoot(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

export const metadataSchema = z.record(z.string(), z.unknown()).optional();

export function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = metadata?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function metadataBoolean(
  metadata: Readonly<Record<string, unknown>> | undefined,
  ...names: readonly string[]
): boolean | null {
  for (const name of names) {
    const value = metadata?.[name];
    if (typeof value === "boolean") return value;
  }
  return null;
}
