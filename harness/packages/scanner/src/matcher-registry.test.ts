import { describe, expect, it } from "vitest";

import {
  createMatcherRegistry,
  type CandidateMatch,
  type Matcher,
} from "./index.js";

describe("matcher registry", () => {
  it("uses the later matcher on a slug collision", () => {
    const replacement: Matcher = {
      slug: "js-ai-sdk-generate-text",
      description: "Plugin replacement",
      noiseTier: "normal",
      filePatterns: ["**/*.ts"],
      examples: ["pluginCall()"],
      match(content): CandidateMatch[] {
        if (!content.includes("pluginCall()")) return [];
        return [
          {
            slug: this.slug,
            label: "plugin",
            snippet: "pluginCall()",
            enclosingSymbolPath: "<module>",
            normalizedCallShape: {
              callee: "pluginCall",
              argumentKeys: [],
              enclosing: "<module>",
            },
            needsTools: false,
            needsStructuredOutput: false,
            line: 1,
          },
        ];
      },
    };

    const registry = createMatcherRegistry([replacement]);
    expect(registry.getBySlug(replacement.slug)).toBe(replacement);
    expect(registry.getAll()).toHaveLength(13);
  });
});
