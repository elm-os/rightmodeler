import { describe, expect, it } from "vitest";

import {
  compileDeclarativeMatchers,
  declarativeMatcherSpecSchema,
  DeclarativeMatcherError,
  type DeclarativeMatcherErrorCode,
} from "./index.js";

function validSpec() {
  return {
    slug: "custom-model-call",
    description: "Custom model call",
    noiseTier: "normal" as const,
    filePatterns: ["**/*.ts"],
    patterns: [
      {
        regex: { source: "customCall\\s*\\(", flags: "i" },
        label: "custom call",
      },
    ],
    examples: ["customCall(input)"],
    closesSurfaceIds: ["custom-framework"],
  };
}

function expectCode(input: unknown, code: DeclarativeMatcherErrorCode): void {
  try {
    compileDeclarativeMatchers(input as readonly unknown[]);
    throw new Error("Expected compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DeclarativeMatcherError);
    expect((error as DeclarativeMatcherError).code).toBe(code);
  }
}

describe("declarative matcher compiler", () => {
  it("compiles validated data into a working matcher", () => {
    const [matcher] = compileDeclarativeMatchers([validSpec()]);
    expect(matcher!.closesSurfaceIds).toEqual(["custom-framework"]);
    expect(matcher!.match("customCall(input)", "src/model.ts")).toHaveLength(1);
  });

  it("rejects an invalid regular expression", () => {
    const spec = validSpec();
    spec.patterns[0]!.regex.source = "(";
    expectCode([spec], "INVALID_REGEX");
  });

  it("rejects unsupported flags", () => {
    const spec = validSpec();
    spec.patterns[0]!.regex.flags = "g";
    expectCode([spec], "INVALID_FLAGS");
  });

  it("rejects a regular expression that matches the empty string", () => {
    const spec = validSpec();
    spec.patterns[0]!.regex.source = "a*";
    spec.examples = ["aaa"];
    expectCode([spec], "EMPTY_STRING_MATCH");
  });

  it.each(["(a+)+$", "(a|aa)+$"])("rejects the ReDoS shape %s", (source) => {
    const spec = validSpec();
    spec.patterns[0]!.regex.source = source;
    spec.examples = ["aaaa"];
    expectCode([spec], "REDOS_RISK");
  });

  it("rejects a glob that matches every file", () => {
    const spec = validSpec();
    spec.filePatterns = ["**"];
    expectCode([spec], "GLOB_BREADTH");
  });

  it("rejects a slug collision within the spec set", () => {
    expectCode([validSpec(), validSpec()], "SLUG_COLLISION");
  });

  it("rejects an example not covered by a declared pattern in schema refinement", () => {
    const spec = validSpec();
    spec.examples = ["differentCall(input)"];
    const parsed = declarativeMatcherSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["examples", 0]);
    }
    expectCode([spec], "EXAMPLE_UNMATCHED");
  });

  it.each([undefined, []])(
    "rejects missing or empty closesSurfaceIds",
    (closesSurfaceIds) => {
      const spec = { ...validSpec(), closesSurfaceIds };
      expectCode([spec], "MISSING_SURFACE_IDS");
    },
  );
});
