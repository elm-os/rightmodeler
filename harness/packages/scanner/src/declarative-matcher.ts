import { z } from "zod";

import { candidateFromText, extractCallText } from "./matchers/utils.js";
import type { CandidateMatch, Matcher } from "./types.js";

const declarativeMatcherErrorCodes = [
  "INVALID_SPEC",
  "INVALID_REGEX",
  "INVALID_FLAGS",
  "EMPTY_STRING_MATCH",
  "REDOS_RISK",
  "GLOB_BREADTH",
  "PATH_TRAVERSAL",
  "MATCH_EXPLOSION",
  "SLUG_COLLISION",
  "EXAMPLE_UNMATCHED",
  "MISSING_SURFACE_IDS",
] as const;

export type DeclarativeMatcherErrorCode =
  (typeof declarativeMatcherErrorCodes)[number];

function issue(
  context: z.RefinementCtx,
  code: DeclarativeMatcherErrorCode,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({
    code: "custom",
    path,
    message,
    params: { code },
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
  const separatedQuantifier =
    /(\[[^\]]+\]|\\[wWdDsS]|\\.|[A-Za-z0-9_])(\*|\+|\{\d+(?:,\d*)?\})(?=(\\[^A-Za-z0-9]|[A-Za-z0-9_]))/g;
  const simplified = source.replace(
    separatedQuantifier,
    (quantifiedAtom, atom: string, _quantifier: string, boundary: string) => {
      const boundaryCharacter = boundary.startsWith("\\")
        ? boundary.slice(1)
        : boundary;
      return new RegExp(`^(?:${atom})$`).test(boundaryCharacter)
        ? quantifiedAtom
        : atom;
    },
  );
  const nestedQuantifier =
    /\((?:[^()]|\([^()]*\))*?(?:[*+]|\{\d+(?:,\d*)?\})(?:[^()]|\([^()]*\))*\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/;
  if (nestedQuantifier.test(simplified.replace(/\s+/g, ""))) return true;

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

const matchExplosionSample = Array.from(
  { length: 64 },
  (_, index) =>
    `const client${index} = createClient(); client${index}.chat.completions.create({ model: "sample" });`,
).join("\n");
const matchExplosionCandidatesPerKilobyte = 25;

function hasMatchExplosion(regex: RegExp): boolean {
  const probe = new RegExp(regex.source, `${regex.flags}g`);
  const kilobytes = Buffer.byteLength(matchExplosionSample, "utf8") / 1024;
  let candidates = 0;
  for (const _match of matchExplosionSample.matchAll(probe)) {
    candidates += 1;
    if (candidates / kilobytes > matchExplosionCandidatesPerKilobyte) {
      return true;
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
    closesSurfaceIds: z.array(z.string().trim().min(1)).min(1),
  })
  .superRefine((spec, context) => {
    for (const [index, filePattern] of spec.filePatterns.entries()) {
      if (filePattern.includes("..")) {
        issue(
          context,
          "PATH_TRAVERSAL",
          ["filePatterns", index],
          "file pattern must not contain path traversal",
        );
      }
      if (isBroadGlob(filePattern)) {
        issue(
          context,
          "GLOB_BREADTH",
          ["filePatterns", index],
          "file pattern matches every file",
        );
      }
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
      if (hasMatchExplosion(regex)) {
        issue(
          context,
          "MATCH_EXPLOSION",
          ["patterns", index, "regex"],
          "regular expression produces more than 25 candidates per KB",
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

export interface DeclarativeMatcherRejection {
  readonly slug: string;
  readonly code: DeclarativeMatcherErrorCode;
  readonly message: string;
}

export interface DeclarativeMatcherCompilation {
  readonly matchers: readonly DeclarativeMatcher[];
  readonly rejections: readonly DeclarativeMatcherRejection[];
}

function inputSlug(input: unknown): string {
  if (typeof input !== "object" || input === null || !("slug" in input)) {
    return "<invalid>";
  }
  return typeof input.slug === "string" && input.slug.length > 0
    ? input.slug
    : "<invalid>";
}

function isErrorCode(value: unknown): value is DeclarativeMatcherErrorCode {
  return declarativeMatcherErrorCodes.some((code) => code === value);
}

function rejectionCode(
  issueValue: z.ZodError["issues"][number],
): DeclarativeMatcherErrorCode {
  if (issueValue.code === "custom" && isErrorCode(issueValue.params?.code)) {
    return issueValue.params.code;
  }
  if (issueValue.path[0] === "closesSurfaceIds") {
    return "MISSING_SURFACE_IDS";
  }
  return "INVALID_SPEC";
}

function calleeFromMatch(match: string, fallback: string): string {
  return (
    /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(match)?.[1] ??
    fallback
  );
}

export function compileDeclarativeMatchers(
  inputs: readonly unknown[],
): DeclarativeMatcherCompilation {
  const matchers: DeclarativeMatcher[] = [];
  const rejections: DeclarativeMatcherRejection[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const parsed = declarativeMatcherSpecSchema.safeParse(input);
    if (!parsed.success) {
      const slug = inputSlug(input);
      rejections.push(
        ...parsed.error.issues.map((issueValue) => ({
          slug,
          code: rejectionCode(issueValue),
          message: issueValue.message,
        })),
      );
      continue;
    }
    const spec = parsed.data;
    if (seen.has(spec.slug)) {
      rejections.push({
        slug: spec.slug,
        code: "SLUG_COLLISION",
        message: `duplicate matcher slug ${spec.slug}`,
      });
      continue;
    }
    seen.add(spec.slug);
    const patterns = spec.patterns.map((pattern) => {
      const { source, flags } = parsedRegex(pattern.regex);
      return {
        regex: new RegExp(source, `${flags}g`),
        label: pattern.label,
      };
    });
    matchers.push({
      slug: spec.slug,
      description: spec.description,
      noiseTier: spec.noiseTier,
      filePatterns: [...spec.filePatterns],
      examples: [...spec.examples],
      closesSurfaceIds: [...spec.closesSurfaceIds],
      match(content): CandidateMatch[] {
        const matches: CandidateMatch[] = [];
        for (const pattern of patterns) {
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
    });
  }

  return { matchers, rejections };
}
