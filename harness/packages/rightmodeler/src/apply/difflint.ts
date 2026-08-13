import { scanSource, type SourceLexicalScan } from "./lex.js";

export type DiffViolationKind =
  | "comment_change"
  | "disallowed_model"
  | "lockfile_change"
  | "non_model_change"
  | "unswapped_file"
  | "whitespace_change";

export interface DiffViolation {
  readonly path: string;
  readonly line: number;
  readonly kind: DiffViolationKind;
}

export interface DiffLintResult {
  readonly pass: boolean;
  readonly violations: readonly DiffViolation[];
}

interface ChangedLine {
  readonly line: number;
  readonly beforeLine: number;
  readonly afterLine: number;
  readonly before: string;
  readonly after: string;
}

interface ModelToken {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function changedLines(
  beforeLines: readonly string[],
  afterLines: readonly string[],
  prefix: number,
): ChangedLine[] {
  const changes: ChangedLine[] = [];
  const lookahead = 64;
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      beforeIndex += 1;
      afterIndex += 1;
      continue;
    }

    let deletionCount = 0;
    for (
      let offset = 1;
      offset <= lookahead && beforeIndex + offset < beforeLines.length;
      offset += 1
    ) {
      if (beforeLines[beforeIndex + offset] === afterLines[afterIndex]) {
        deletionCount = offset;
        break;
      }
    }
    let insertionCount = 0;
    for (
      let offset = 1;
      offset <= lookahead && afterIndex + offset < afterLines.length;
      offset += 1
    ) {
      if (beforeLines[beforeIndex] === afterLines[afterIndex + offset]) {
        insertionCount = offset;
        break;
      }
    }

    if (
      deletionCount > 0 &&
      (insertionCount === 0 || deletionCount <= insertionCount)
    ) {
      for (let offset = 0; offset < deletionCount; offset += 1) {
        changes.push({
          line: prefix + afterIndex + 1,
          beforeLine: prefix + beforeIndex + offset + 1,
          afterLine: prefix + afterIndex + 1,
          before: beforeLines[beforeIndex + offset]!,
          after: "",
        });
      }
      beforeIndex += deletionCount;
      continue;
    }
    if (insertionCount > 0) {
      for (let offset = 0; offset < insertionCount; offset += 1) {
        changes.push({
          line: prefix + afterIndex + offset + 1,
          beforeLine: prefix + beforeIndex + 1,
          afterLine: prefix + afterIndex + offset + 1,
          before: "",
          after: afterLines[afterIndex + offset]!,
        });
      }
      afterIndex += insertionCount;
      continue;
    }

    changes.push({
      line: prefix + afterIndex + 1,
      beforeLine: prefix + beforeIndex + 1,
      afterLine: prefix + afterIndex + 1,
      before: beforeLines[beforeIndex] ?? "",
      after: afterLines[afterIndex] ?? "",
    });
    if (beforeIndex < beforeLines.length) beforeIndex += 1;
    if (afterIndex < afterLines.length) afterIndex += 1;
  }
  return changes;
}

function changedContentLines(before: string, after: string): ChangedLine[] {
  const allBeforeLines = before.split("\n");
  const allAfterLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < allBeforeLines.length &&
    prefix < allAfterLines.length &&
    allBeforeLines[prefix] === allAfterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < allBeforeLines.length - prefix &&
    suffix < allAfterLines.length - prefix &&
    allBeforeLines[allBeforeLines.length - suffix - 1] ===
      allAfterLines[allAfterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const beforeLines = allBeforeLines.slice(
    prefix,
    allBeforeLines.length - suffix,
  );
  const afterLines = allAfterLines.slice(prefix, allAfterLines.length - suffix);
  return changedLines(beforeLines, afterLines, prefix);
}

function lineForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function valueAfter(
  content: string,
  scan: SourceLexicalScan,
  start: number,
  allowWrapper: boolean,
): ModelToken | null {
  let index = start;
  while (/\s/.test(content[index] ?? "")) index += 1;
  if (allowWrapper) {
    const wrapper = /^[A-Za-z_$][\w$]*\s*\(\s*/.exec(scan.mask.slice(index));
    if (wrapper !== null) index += wrapper[0].length;
  }
  const string = scan.stringAt.get(index);
  if (string !== undefined) {
    const line = lineForOffset(scan.lineStarts, string.start);
    const start = scan.lineStarts[line - 1]!;
    return {
      line,
      start: string.start - start,
      end: string.end - start,
      value: string.value,
    };
  }
  const value = /^[A-Za-z0-9][A-Za-z0-9._:/-]*/.exec(content.slice(index))?.[0];
  if (value === undefined) return null;
  const line = lineForOffset(scan.lineStarts, index);
  const lineStartOffset = scan.lineStarts[line - 1]!;
  return {
    line,
    start: index - lineStartOffset,
    end: index - lineStartOffset + value.length,
    value,
  };
}

function modelTokens(content: string, scan: SourceLexicalScan): ModelToken[] {
  const tokens: ModelToken[] = [];
  const addAfterMatches = (pattern: RegExp, allowWrapper: boolean): void => {
    for (const match of scan.mask.matchAll(pattern)) {
      const token = valueAfter(
        content,
        scan,
        match.index + match[0].length,
        allowWrapper,
      );
      if (token !== null) tokens.push(token);
    }
  };
  addAfterMatches(/\b(?:model|model_name)\s*[:=]/g, true);
  addAfterMatches(
    /\b(?:(?:OPENAI|ANTHROPIC|LITELLM|LANGCHAIN|AI|LLM)_MODEL(?:_ID|_NAME)?|MODEL_(?:ID|NAME))\s*[:=]/g,
    false,
  );
  addAfterMatches(/\bconst\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=;\n]+)?\s*=/g, false);
  addAfterMatches(/^[ \t]*[A-Z][A-Z0-9_]*(?:\s*:\s*[^=\n]+)?\s*=/gm, false);

  for (const key of scan.strings.filter(({ value }) =>
    ["model", "model_name"].includes(value),
  )) {
    let index = key.fullEnd;
    while (/\s/.test(content[index] ?? "")) index += 1;
    if (scan.mask[index] !== ":" && scan.mask[index] !== "=") continue;
    const token = valueAfter(content, scan, index + 1, true);
    if (token !== null) tokens.push(token);
  }

  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = `${token.line}:${token.start}:${token.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokensOnLine(
  tokens: readonly ModelToken[],
  line: number,
): ModelToken[] {
  return tokens
    .filter((token) => token.line === line)
    .sort((left, right) => left.start - right.start);
}

function withoutTokens(line: string, tokens: readonly ModelToken[]): string {
  let result = line;
  for (const token of [...tokens].reverse()) {
    result = `${result.slice(0, token.start)}<model>${result.slice(token.end)}`;
  }
  return result.replace(/(["'])<model>\1/g, '"<model>"').replace(/\s/g, "");
}

function sameLineShape(before: string, after: string): boolean {
  return before === after || after === `${before};` || after === `${before},`;
}

function isLockfile(path: string): boolean {
  return /(?:^|\/)(?:[^/]+\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.sum)$/.test(
    path,
  );
}

function lintChangedLine(
  change: ChangedLine,
  beforeTokens: readonly ModelToken[],
  afterTokens: readonly ModelToken[],
  beforeComments: ReadonlyMap<number, string>,
  afterComments: ReadonlyMap<number, string>,
  allowedPairs: Map<string, number>,
): { violation?: DiffViolationKind } {
  if (
    (beforeComments.get(change.beforeLine) ?? "") !==
    (afterComments.get(change.afterLine) ?? "")
  ) {
    return { violation: "comment_change" };
  }
  if (change.before.replace(/\s/g, "") === change.after.replace(/\s/g, "")) {
    return { violation: "whitespace_change" };
  }

  const beforeLineTokens = tokensOnLine(beforeTokens, change.beforeLine);
  const afterLineTokens = tokensOnLine(afterTokens, change.afterLine);
  if (
    beforeLineTokens.length === 0 ||
    beforeLineTokens.length !== afterLineTokens.length ||
    !sameLineShape(
      withoutTokens(change.before, beforeLineTokens),
      withoutTokens(change.after, afterLineTokens),
    )
  ) {
    return { violation: "non_model_change" };
  }

  const replacements: string[] = [];
  for (let index = 0; index < beforeLineTokens.length; index += 1) {
    const from = beforeLineTokens[index]!.value;
    const to = afterLineTokens[index]!.value;
    if (from === to) continue;
    const pair = `${from}\0${to}`;
    const alreadyUsed = replacements.filter((used) => used === pair).length;
    if ((allowedPairs.get(pair) ?? 0) <= alreadyUsed) {
      return { violation: "disallowed_model" };
    }
    replacements.push(pair);
  }
  for (const pair of replacements) {
    allowedPairs.set(pair, allowedPairs.get(pair)! - 1);
  }
  return replacements.length === 0 ? { violation: "non_model_change" } : {};
}

export function lintSwapDiff({
  files,
}: {
  readonly files: readonly {
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly replacements: readonly {
      readonly from: string;
      readonly to: string;
    }[];
  }[];
}): DiffLintResult {
  const violations: DiffViolation[] = [];

  for (const file of files) {
    const changes = changedContentLines(file.before, file.after);
    if (changes.length === 0) continue;
    if (isLockfile(file.path)) {
      violations.push({
        path: file.path,
        line: changes[0]!.line,
        kind: "lockfile_change",
      });
      continue;
    }
    if (file.replacements.length === 0) {
      violations.push({
        path: file.path,
        line: changes[0]!.line,
        kind: "unswapped_file",
      });
      continue;
    }

    const allowedPairs = new Map<string, number>();
    for (const { from, to } of file.replacements) {
      const pair = `${from}\0${to}`;
      allowedPairs.set(pair, (allowedPairs.get(pair) ?? 0) + 1);
    }
    const beforeScan = scanSource(file.before);
    const afterScan = scanSource(file.after);
    const beforeTokens = modelTokens(file.before, beforeScan);
    const afterTokens = modelTokens(file.after, afterScan);
    const fileViolations: DiffViolation[] = [];
    for (const change of changes) {
      const result = lintChangedLine(
        change,
        beforeTokens,
        afterTokens,
        beforeScan.comments,
        afterScan.comments,
        allowedPairs,
      );
      if (result.violation !== undefined) {
        fileViolations.push({
          path: file.path,
          line: change.line,
          kind: result.violation,
        });
      }
    }
    violations.push(...fileViolations);
  }

  return { pass: violations.length === 0, violations };
}
