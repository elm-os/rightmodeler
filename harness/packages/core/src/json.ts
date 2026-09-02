export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
