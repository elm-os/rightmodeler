import { samplePath } from "./path-pattern.js";
import type { Matcher } from "./types.js";

export class MatcherRegistry {
  readonly #matchers = new Map<string, Matcher>();

  constructor(matchers: readonly Matcher[] = []) {
    for (const matcher of matchers) this.register(matcher);
  }

  register(matcher: Matcher): void {
    if (matcher.examples.length === 0) {
      throw new Error(
        `Matcher ${matcher.slug} must declare at least one example`,
      );
    }
    const filePath = samplePath(matcher.filePatterns);
    for (const [index, example] of matcher.examples.entries()) {
      if (matcher.match(example, filePath).length === 0) {
        throw new Error(
          `Matcher ${matcher.slug} does not match its example at index ${index}`,
        );
      }
    }
    this.#matchers.set(matcher.slug, matcher);
  }

  getAll(): Matcher[] {
    return [...this.#matchers.values()];
  }

  getBySlug(slug: string): Matcher | undefined {
    return this.#matchers.get(slug);
  }
}
