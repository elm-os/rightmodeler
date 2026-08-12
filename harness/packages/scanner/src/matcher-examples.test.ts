import { describe, expect, it } from "vitest";

import { createMatcherRegistry } from "./index.js";
import { samplePath } from "./path-pattern.js";

const registry = createMatcherRegistry();

describe("builtin matcher examples", () => {
  it("discovers every named builtin matcher", () => {
    expect(registry.getAll()).toHaveLength(13);
  });

  for (const matcher of registry.getAll()) {
    describe(matcher.slug, () => {
      it("declares at least one example", () => {
        expect(matcher.examples.length).toBeGreaterThan(0);
      });

      for (const [index, example] of matcher.examples.entries()) {
        it(`fires on example ${index}`, () => {
          const filePath = samplePath(matcher.filePatterns);
          expect(
            matcher.match(example, filePath),
            `${matcher.slug} did not match example ${index}: ${JSON.stringify(example)} at ${filePath}`,
          ).not.toHaveLength(0);
        });
      }
    });
  }
});
