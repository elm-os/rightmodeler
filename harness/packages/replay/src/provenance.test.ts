import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { responseSubstitution, sameModel } from "./provenance.js";

interface GatewayResponse {
  readonly name?: string;
  readonly requestedModel: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function fixture<T>(file: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`../../../fixtures/gateways/${file}`, import.meta.url),
      "utf8",
    ),
  ) as T;
}

const sourceDerived = fixture<GatewayResponse[]>("source-derived.json");

function sourceEntry(name: string): GatewayResponse {
  const entry = sourceDerived.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing fixture entry ${name}`);
  return entry;
}

describe("response provenance", () => {
  it("matches the requested model when a gateway echoes it, strips its provider prefix, or adds a dated snapshot", () => {
    for (const [requested, served] of [
      ["openai/gpt-4o-mini", "openai/gpt-4o-mini"],
      ["OpenAI/GPT-4o-mini", "openai/gpt-4o-mini"],
      ["vercel/openai/gpt-4o-mini", "openai/gpt-4o-mini"],
      ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
      ["openai/gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
      ["claude-3-5-sonnet", "claude-3-5-sonnet-20241022"],
      ["gpt-4", "gpt-4-0613"],
    ] as const) {
      expect(sameModel(requested, served), `${requested} -> ${served}`).toBe(
        true,
      );
    }
  });

  it("refuses another model, another vendor, or a suffix that is not a dated snapshot", () => {
    for (const [requested, served] of [
      ["openai/gpt-4o", "openai/gpt-4o-mini"],
      ["openai/gpt-4o-mini", "openai/gpt-4.1-nano"],
      ["openai/gpt-4o-mini", "azure/gpt-4o-mini-2024-07-18"],
      ["fallback-demo", "openai/gpt-4o-mini"],
      ["gpt-4o-mini-2024-07-18", "gpt-4o-mini"],
    ] as const) {
      expect(sameModel(requested, served), `${requested} -> ${served}`).toBe(
        false,
      );
    }
  });

  it("flags Portkey override_params as a model substitution and leaves the plain call fresh", () => {
    expect(
      responseSubstitution(
        fixture<GatewayResponse>("portkey/override-params.json"),
      ),
    ).toEqual({
      kind: "model",
      evidence: "served stub/override for requested stub/requested",
    });
    expect(
      responseSubstitution(fixture<GatewayResponse>("portkey/plain.json")),
    ).toBeUndefined();
  });

  it("reads Portkey's cache status header in both header forms", () => {
    for (const name of ["portkey-cache-hit", "portkey-semantic-cache-hit"]) {
      const entry = sourceEntry(name);
      const status = entry.headers["x-portkey-cache-status"];
      const expected = {
        kind: "cache",
        evidence: `x-portkey-cache-status: ${status}`,
      };
      expect(responseSubstitution(entry)).toEqual(expected);
      expect(
        responseSubstitution({ ...entry, headers: new Headers(entry.headers) }),
      ).toEqual(expected);
    }
    const hit = sourceEntry("portkey-cache-hit");
    for (const status of ["DISABLED", "MISS", "REFRESH"]) {
      for (const headers of [
        { "x-portkey-cache-status": status },
        new Headers({ "x-portkey-cache-status": status }),
      ]) {
        expect(responseSubstitution({ ...hit, headers })).toBeUndefined();
      }
    }
  });

  it("flags a Portkey hook that transformed the call", () => {
    expect(
      responseSubstitution(
        fixture<GatewayResponse>("portkey/input-mutator.json"),
      ),
    ).toEqual({
      kind: "request",
      evidence: "portkey hook input_guardrail_pod transformed the call",
    });
  });

  it("flags Envoy's priority fallback and leaves its plain answer fresh", () => {
    expect(
      responseSubstitution(fixture<GatewayResponse>("envoy/fallback.json")),
    ).toMatchObject({ kind: "model" });
    expect(
      responseSubstitution(fixture<GatewayResponse>("envoy/plain.json")),
    ).toBeUndefined();
  });

  it("reads every Bifrost marker", () => {
    const expected: Record<string, unknown> = {
      "bifrost-prefix-stripped": undefined,
      "bifrost-cache-hit": {
        kind: "cache",
        evidence: "bifrost cache hit (semantic)",
      },
      "bifrost-dropped-params": {
        kind: "request",
        evidence: "bifrost dropped response_format",
      },
      "bifrost-dropped-tools": {
        kind: "request",
        evidence: "bifrost dropped web_search",
      },
      "bifrost-converted-request": {
        kind: "request",
        evidence: "bifrost converted the request to responses",
      },
      "bifrost-server-side-fallback": {
        kind: "model",
        evidence:
          "bifrost server-side fallback served anthropic/claude-haiku-4.5",
      },
    };
    const bifrost = sourceDerived.filter((entry) =>
      entry.name!.startsWith("bifrost-"),
    );
    expect(bifrost.map((entry) => entry.name).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const entry of bifrost) {
      expect(responseSubstitution(entry), entry.name).toEqual(
        expected[entry.name!],
      );
    }
  });

  it("does not check a body that names no model", () => {
    expect(
      responseSubstitution({
        requestedModel: "acme/small-1",
        headers: {},
        body: { choices: [{ message: { content: "answer" } }] },
      }),
    ).toBeUndefined();
  });

  it("bounds evidence to 200 characters", () => {
    const served = `acme/${"x".repeat(295)}`;
    const substitution = responseSubstitution({
      requestedModel: "acme/small-1",
      headers: {},
      body: { model: served },
    });
    expect(substitution?.kind).toBe("model");
    expect(substitution?.evidence).toHaveLength(200);
    expect(substitution?.evidence).toBe(`served ${served}`.slice(0, 200));
  });
});
