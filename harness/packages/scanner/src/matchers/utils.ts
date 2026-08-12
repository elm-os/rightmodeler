import type { CandidateMatch, Matcher, NoiseTier } from "../types.js";

interface CallMatcherOptions {
  slug: string;
  description: string;
  noiseTier: NoiseTier;
  filePatterns: readonly string[];
  examples: readonly string[];
  pattern: RegExp;
  fileAnchor?: RegExp;
  label: string;
  needsStructuredOutput?: boolean;
  needsTools?: boolean;
}

function maskNonCode(content: string, includeHashComments: boolean): string {
  let masked = "";
  let index = 0;
  while (index < content.length) {
    const character = content[index]!;
    const next = content[index + 1];
    if (character === '"' || character === "'" || character === "`") {
      const delimiterLength =
        includeHashComments &&
        character !== "`" &&
        content[index + 1] === character &&
        content[index + 2] === character
          ? 3
          : 1;
      const delimiter = character.repeat(delimiterLength);
      masked += " ".repeat(delimiterLength);
      index += delimiterLength;
      while (index < content.length) {
        if (content.startsWith(delimiter, index)) {
          masked += " ".repeat(delimiterLength);
          index += delimiterLength;
          break;
        }
        const stringCharacter = content[index]!;
        masked += stringCharacter === "\n" ? "\n" : " ";
        index += 1;
        if (stringCharacter === "\\" && index < content.length) {
          masked += content[index] === "\n" ? "\n" : " ";
          index += 1;
        }
      }
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      masked += "  ";
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        masked += content[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < content.length) {
        masked += "  ";
        index += 2;
      }
      continue;
    }
    if (includeHashComments && character === "#") {
      while (index < content.length && content[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }
    masked += character;
    index += 1;
  }
  return masked;
}

export function enclosingSymbol(content: string, position: number): string {
  const prefix = content.slice(0, position);
  const declaration =
    /(?:\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+|\b(?:async\s+)?def\s+|\bclass\s+|\b(?:export\s+)?const\s+)([A-Za-z_$][\w$]*)/gm;
  let nearest = "<module>";
  for (const match of prefix.matchAll(declaration)) nearest = match[1]!;
  return nearest;
}

export function extractCallText(content: string, position: number): string {
  const open = content.indexOf("(", position);
  if (open === -1) return content.slice(position, position + 240);
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < content.length; index += 1) {
    const character = content[index]!;
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return content.slice(position, index + 1);
    }
  }
  return content.slice(position, position + 240);
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

export function argumentKeys(callText: string): string[] {
  const open = callText.indexOf("(");
  const close = callText.lastIndexOf(")");
  if (open === -1 || close <= open) return [];
  let argumentsText = callText.slice(open + 1, close).trim();
  let separator = "=";
  if (argumentsText.startsWith("{")) {
    const objectClose = argumentsText.lastIndexOf("}");
    if (objectClose === -1) return [];
    argumentsText = argumentsText.slice(1, objectClose);
    separator = ":";
  }
  const keys = splitTopLevel(argumentsText)
    .map((part) => {
      const keyed = new RegExp(
        `^\\s*(?:["']([A-Za-z_$][\\w$-]*)["']|([A-Za-z_$][\\w$-]*))\\s*${separator}`,
      ).exec(part);
      if (keyed !== null) return keyed[1] ?? keyed[2];
      if (separator === ":") {
        return /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)?.[1];
      }
      return undefined;
    })
    .filter((key): key is string => key !== undefined);
  return [...new Set(keys)].sort();
}

export function extractModelId(text: string): string | undefined {
  const model =
    /\b(?:model|model_name)\s*[:=]\s*(?:[A-Za-z_$][\w$]*\s*\(\s*)?["']?([A-Za-z0-9][A-Za-z0-9._:/-]*)["']?/.exec(
      text,
    );
  if (model !== null) return model[1];
  return /\b[A-Z][A-Z0-9_]*MODEL(?:_ID|_NAME)?\s*=\s*["']?([^\s"']+)/.exec(
    text,
  )?.[1];
}

function displaySnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function candidateFromText(params: {
  slug: string;
  label: string;
  content: string;
  position: number;
  matchedText: string;
  callee: string;
  needsStructuredOutput?: boolean;
  needsTools?: boolean;
}): CandidateMatch {
  const symbol = enclosingSymbol(params.content, params.position);
  const keys = argumentKeys(params.matchedText);
  // Fingerprint v0: nearest preceding function/class/def/const name plus the callee and sorted visible top-level argument keys; line numbers are display-only.
  const normalizedCallShape = {
    callee: params.callee,
    argumentKeys: keys,
    enclosing: symbol,
  };
  return {
    slug: params.slug,
    label: params.label,
    snippet: displaySnippet(params.matchedText),
    enclosingSymbolPath: symbol,
    normalizedCallShape,
    needsTools: params.needsTools === true || keys.includes("tools"),
    needsStructuredOutput: params.needsStructuredOutput === true,
    modelId: extractModelId(params.matchedText),
    line: params.content.slice(0, params.position).split("\n").length,
  };
}

export function createCallMatcher(options: CallMatcherOptions): Matcher {
  return {
    slug: options.slug,
    description: options.description,
    noiseTier: options.noiseTier,
    filePatterns: options.filePatterns,
    examples: options.examples,
    match(content, filePath) {
      if (
        options.fileAnchor !== undefined &&
        !options.fileAnchor.test(content)
      ) {
        return [];
      }
      const searchable = maskNonCode(content, filePath.endsWith(".py"));
      const flags = options.pattern.flags.replaceAll("g", "");
      const pattern = new RegExp(options.pattern.source, `${flags}g`);
      const matches: CandidateMatch[] = [];
      for (const match of searchable.matchAll(pattern)) {
        const position = match.index;
        const matchedText = extractCallText(content, position);
        const callee = match.groups?.callee ?? match[0].replace(/\s*\($/, "");
        matches.push(
          candidateFromText({
            slug: options.slug,
            label: options.label,
            content,
            position,
            matchedText,
            callee,
            needsStructuredOutput: options.needsStructuredOutput,
            needsTools: options.needsTools,
          }),
        );
      }
      return matches;
    },
  };
}
