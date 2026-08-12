import { z } from "zod";

import { candidateFromText, extractCallText } from "./matchers/utils.js";
import type { CandidateMatch, Matcher } from "./types.js";

export type DeclarativeMatcherErrorCode =
  | "INVALID_REGEX"
  | "INVALID_FLAGS"
  | "EMPTY_STRING_MATCH"
  | "REDOS_RISK"
  | "GLOB_BREADTH"
  | "SLUG_COLLISION"
  | "EXAMPLE_UNMATCHED"
  | "MISSING_SURFACE_IDS";

export class DeclarativeMatcherError extends Error {
  readonly code: DeclarativeMatcherErrorCode;

  constructor(code: DeclarativeMatcherErrorCode, message: string) {
    super(message);
    this.name = "DeclarativeMatcherError";
    this.code = code;
  }
}

const errorCodes = new Set<DeclarativeMatcherErrorCode>([
  "INVALID_REGEX",
  "INVALID_FLAGS",
  "EMPTY_STRING_MATCH",
  "REDOS_RISK",
  "GLOB_BREADTH",
  "SLUG_COLLISION",
  "EXAMPLE_UNMATCHED",
  "MISSING_SURFACE_IDS",
]);

function issue(
  context: z.RefinementCtx,
  code: DeclarativeMatcherErrorCode,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({
    code: "custom",
    path,
    message: `[${code}] ${message}`,
  });
}

const regexValueSchema = z.union([
  z.string().min(1),
  z.strictObject({
    source: z.string().min(1),
    flags: z.string().optional(),
  }),
]);

interface ParsedRegex {
  source: string;
  flags: string;
}

function parsedRegex(value: z.infer<typeof regexValueSchema>): ParsedRegex {
  if (typeof value !== "string") {
    return { source: value.source, flags: value.flags ?? "" };
  }
  if (value.startsWith("/")) {
    const slash = value.lastIndexOf("/");
    if (slash > 0) {
      return { source: value.slice(1, slash), flags: value.slice(slash + 1) };
    }
  }
  return { source: value, flags: "" };
}

function hasRedosRisk(source: string): boolean {
  const nestedQuantifier =
    /\((?:[^()]|\([^()]*\))*?(?:[*+]|\{\d+(?:,\d*)?\})(?:[^()]|\([^()]*\))*\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/;
  if (nestedQuantifier.test(source.replace(/\s+/g, ""))) return true;

  for (const match of source.matchAll(
    /\((?:\?:)?([^()]*(?:\|[^()]*)+)\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/g,
  )) {
    const alternatives = match[1]!
      .split("|")
      .map((part) => part.replace(/^\^/, ""));
    for (let left = 0; left < alternatives.length; left += 1) {
      for (let right = left + 1; right < alternatives.length; right += 1) {
        const first = alternatives[left]!;
        const second = alternatives[right]!;
        if (
          first.startsWith(second) ||
          second.startsWith(first) ||
          (first[0] !== undefined && first[0] === second[0])
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function isBroadGlob(pattern: string): boolean {
  const trimmed = pattern.trim();
  return (
    /^(?:\*|\*\*|\*\*\/\*|\*\*\/\*\*)\/?$/.test(trimmed) ||
    /^[*?./]+$/.test(trimmed)
  );
}

const patternSchema = z.strictObject({
  regex: regexValueSchema,
  label: z.string().trim().min(1),
});

export const declarativeMatcherSpecSchema = z
  .strictObject({
    slug: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1),
    noiseTier: z.enum(["precise", "normal", "noisy"]),
    filePatterns: z.array(z.string().trim().min(1)).min(1),
    patterns: z.array(patternSchema).min(1),
    examples: z.array(z.string().min(1)).min(1),
    closesSurfaceIds: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((spec, context) => {
    for (const [index, filePattern] of spec.filePatterns.entries()) {
      if (isBroadGlob(filePattern)) {
        issue(
          context,
          "GLOB_BREADTH",
          ["filePatterns", index],
          "file pattern matches every file",
        );
      }
    }
    if (
      spec.closesSurfaceIds === undefined ||
      spec.closesSurfaceIds.length === 0
    ) {
      issue(
        context,
        "MISSING_SURFACE_IDS",
        ["closesSurfaceIds"],
        "at least one coverage surface identifier is required",
      );
    }

    const compiled: RegExp[] = [];
    for (const [index, pattern] of spec.patterns.entries()) {
      const { source, flags } = parsedRegex(pattern.regex);
      if (!["", "i", "m", "im"].includes(flags)) {
        issue(
          context,
          "INVALID_FLAGS",
          ["patterns", index, "regex"],
          "only i, m, and im flags are allowed",
        );
        continue;
      }
      let regex: RegExp;
      try {
        regex = new RegExp(source, flags);
      } catch {
        issue(
          context,
          "INVALID_REGEX",
          ["patterns", index, "regex"],
          "regular expression is invalid",
        );
        continue;
      }
      if (regex.test("")) {
        issue(
          context,
          "EMPTY_STRING_MATCH",
          ["patterns", index, "regex"],
          "regular expression must not match the empty string",
        );
        continue;
      }
      if (hasRedosRisk(source)) {
        issue(
          context,
          "REDOS_RISK",
          ["patterns", index, "regex"],
          "regular expression has a risky quantified shape",
        );
        continue;
      }
      compiled.push(regex);
    }

    for (const [index, example] of spec.examples.entries()) {
      if (!compiled.some((regex) => regex.test(example))) {
        issue(
          context,
          "EXAMPLE_UNMATCHED",
          ["examples", index],
          "example is not matched by a declared pattern",
        );
      }
    }
  });

export const declarativeMatcherSpecsSchema = z
  .array(declarativeMatcherSpecSchema)
  .superRefine((specs, context) => {
    const seen = new Set<string>();
    for (const [index, spec] of specs.entries()) {
      if (seen.has(spec.slug)) {
        issue(
          context,
          "SLUG_COLLISION",
          [index, "slug"],
          `duplicate matcher slug ${spec.slug}`,
        );
      }
      seen.add(spec.slug);
    }
  });

export type DeclarativeMatcherSpec = z.infer<
  typeof declarativeMatcherSpecSchema
>;

export interface DeclarativeMatcher extends Matcher {
  readonly closesSurfaceIds: readonly string[];
}

function parseSpecs(inputs: readonly unknown[]): DeclarativeMatcherSpec[] {
  try {
    return declarativeMatcherSpecsSchema.parse(inputs);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const message =
      error.issues[0]?.message ?? "declarative matcher is invalid";
    const match = /^\[([A-Z_]+)\]\s*(.*)$/.exec(message);
    const code = match?.[1] as DeclarativeMatcherErrorCode | undefined;
    if (code !== undefined && errorCodes.has(code)) {
      throw new DeclarativeMatcherError(code, match?.[2] ?? message);
    }
    throw error;
  }
}

function calleeFromMatch(match: string, fallback: string): string {
  return (
    /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(match)?.[1] ??
    fallback
  );
}

export function compileDeclarativeMatchers(
  inputs: readonly unknown[],
): DeclarativeMatcher[] {
  return parseSpecs(inputs).map((spec) => {
    const patterns = spec.patterns.map((pattern) => {
      const { source, flags } = parsedRegex(pattern.regex);
      return {
        regex: new RegExp(source, `${flags}g`),
        label: pattern.label,
      };
    });
    return {
      slug: spec.slug,
      description: spec.description,
      noiseTier: spec.noiseTier,
      filePatterns: [...spec.filePatterns],
      examples: [...spec.examples],
      closesSurfaceIds: [...spec.closesSurfaceIds!],
      match(content): CandidateMatch[] {
        const matches: CandidateMatch[] = [];
        for (const pattern of patterns) {
          pattern.regex.lastIndex = 0;
          for (const match of content.matchAll(pattern.regex)) {
            const position = match.index;
            const matchedText = extractCallText(content, position);
            matches.push(
              candidateFromText({
                slug: spec.slug,
                label: pattern.label,
                content,
                position,
                matchedText,
                callee: calleeFromMatch(match[0], spec.slug),
              }),
            );
          }
        }
        return matches;
      },
    };
  });
}
