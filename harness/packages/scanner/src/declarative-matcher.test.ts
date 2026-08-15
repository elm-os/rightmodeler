import { describe, expect, it } from "vitest";

import {
  compileDeclarativeMatchers,
  declarativeMatcherSpecSchema,
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
  const result = compileDeclarativeMatchers(input as readonly unknown[]);
  expect(result.matchers).toEqual([]);
  expect(result.rejections.map((rejection) => rejection.code)).toContain(code);
}

describe("declarative matcher compiler", () => {
  it("compiles validated data into a working matcher", () => {
    const {
      matchers: [matcher],
      rejections,
    } = compileDeclarativeMatchers([validSpec()]);
    expect(rejections).toEqual([]);
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

  it.each([
    "((?:[A-Za-z_]\\w*\\.)+)create\\s*\\(",
    "^[a-z]+@([a-z]+\\.)+[a-z]+$",
  ])("accepts a separated nested quantifier in %s", (source) => {
    const spec = validSpec();
    spec.patterns[0]!.regex.source = source;
    spec.examples = [
      source.startsWith("^")
        ? "person@example.com"
        : "client.chat.completions.create(",
    ];

    expect(compileDeclarativeMatchers([spec]).rejections).toEqual([]);
  });

  it("rejects a glob that matches every file", () => {
    const spec = validSpec();
    spec.filePatterns = ["**"];
    expectCode([spec], "GLOB_BREADTH");
  });

  it("rejects a path-traversing glob", () => {
    const spec = validSpec();
    spec.filePatterns = ["../../**/*.ts"];
    expectCode([spec], "PATH_TRAVERSAL");
  });

  it.each(["\\b", ".", "(?=c)"])(
    "rejects the match-explosion pattern %s",
    (source) => {
      const spec = validSpec();
      spec.patterns[0]!.regex.source = source;
      spec.examples = ["customCall(input)"];
      expectCode([spec], "MATCH_EXPLOSION");
    },
  );

  it("rejects a slug collision within the spec set", () => {
    const result = compileDeclarativeMatchers([validSpec(), validSpec()]);
    expect(result.matchers).toHaveLength(1);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        slug: "custom-model-call",
        code: "SLUG_COLLISION",
      }),
    ]);
  });

  it("keeps valid siblings when another spec is rejected", () => {
    const bad = { ...validSpec(), slug: "bad-matcher", noiseTier: "extreme" };
    const result = compileDeclarativeMatchers([validSpec(), bad]);

    expect(result.matchers.map(({ slug }) => slug)).toEqual([
      "custom-model-call",
    ]);
    expect(result.rejections).toEqual([
      expect.objectContaining({ slug: "bad-matcher", code: "INVALID_SPEC" }),
    ]);
  });

  it("reports every named rejection for one spec", () => {
    const spec = validSpec();
    spec.filePatterns = ["**"];
    spec.patterns[0]!.regex.flags = "g";

    expect(
      compileDeclarativeMatchers([spec]).rejections.map(({ code }) => code),
    ).toEqual(expect.arrayContaining(["GLOB_BREADTH", "INVALID_FLAGS"]));
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
