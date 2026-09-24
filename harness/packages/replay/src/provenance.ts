import type { Substitution } from "@rightmodeler/core";

export type ResponseHeaders =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface SubstitutedResponse {
  readonly candidateId: string;
  readonly substitution: Substitution;
}

const DATED_SNAPSHOT = /^\d{2,4}(?:-?\d{2}){1,2}$/;
const PORTKEY_CACHE_HITS = new Set(["hit", "semantic hit"]);

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function servedModel(body: unknown): string | undefined {
  return nonEmptyString(objectOf(body)?.model);
}

function modelParts(id: string): { vendor?: string; name: string } {
  const segments = id.toLowerCase().split("/");
  return {
    name: segments[segments.length - 1]!,
    ...(segments.length > 1 ? { vendor: segments[segments.length - 2]! } : {}),
  };
}

export function sameModel(requested: string, served: string): boolean {
  const want = modelParts(requested);
  const got = modelParts(served);
  if (
    want.vendor !== undefined &&
    got.vendor !== undefined &&
    want.vendor !== got.vendor
  ) {
    return false;
  }
  if (got.name === want.name) return true;
  const prefix = `${want.name}-`;
  return (
    got.name.startsWith(prefix) &&
    DATED_SNAPSHOT.test(got.name.slice(prefix.length))
  );
}

function header(headers: ResponseHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return typeof value === "string" ? value : value?.join(", ");
}

function substitution(
  kind: Substitution["kind"],
  evidence: string,
): Substitution {
  return { kind, evidence: evidence.slice(0, 200) };
}

export function responseSubstitution(input: {
  readonly requestedModel: string;
  readonly headers: ResponseHeaders;
  readonly body: unknown;
}): Substitution | undefined {
  const body = objectOf(input.body);
  const extra = objectOf(body?.extra_fields);
  const served = servedModel(body);
  if (served !== undefined && !sameModel(input.requestedModel, served)) {
    return substitution(
      "model",
      `served ${served} for requested ${input.requestedModel}`,
    );
  }
  const fallback = nonEmptyString(
    objectOf(extra?.routing_info)?.server_side_fallback_model,
  );
  if (fallback !== undefined) {
    return substitution(
      "model",
      `bifrost server-side fallback served ${fallback}`,
    );
  }
  const cacheStatus = header(input.headers, "x-portkey-cache-status");
  if (
    cacheStatus !== undefined &&
    PORTKEY_CACHE_HITS.has(cacheStatus.toLowerCase())
  ) {
    return substitution("cache", `x-portkey-cache-status: ${cacheStatus}`);
  }
  const cacheDebug = objectOf(extra?.cache_debug);
  if (cacheDebug?.cache_hit === true) {
    const hitType = cacheDebug.hit_type;
    return substitution(
      "cache",
      `bifrost cache hit${typeof hitType === "string" ? ` (${hitType})` : ""}`,
    );
  }
  const hookResults = objectOf(body?.hook_results);
  const transformed = [
    hookResults?.before_request_hooks,
    hookResults?.after_request_hooks,
  ]
    .flatMap((hooks) => (Array.isArray(hooks) ? hooks : []))
    .map(objectOf)
    .find((hook) => hook?.transformed === true);
  if (transformed !== undefined) {
    const id = nonEmptyString(transformed.id) ?? "unnamed";
    return substitution("request", `portkey hook ${id} transformed the call`);
  }
  const dropped = [
    extra?.dropped_compat_plugin_params,
    extra?.dropped_unsupported_tools,
  ].flatMap((items) => (Array.isArray(items) ? items : []));
  if (dropped.length > 0) {
    return substitution("request", `bifrost dropped ${dropped.join(", ")}`);
  }
  const converted = nonEmptyString(extra?.converted_request_type);
  if (converted !== undefined) {
    return substitution(
      "request",
      `bifrost converted the request to ${converted}`,
    );
  }
  return undefined;
}
