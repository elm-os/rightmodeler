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

interface StringToken {
  readonly fullStart: number;
  readonly fullEnd: number;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface ModelToken {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface LexicalScan {
  readonly mask: string;
  readonly strings: readonly StringToken[];
  readonly stringAt: ReadonlyMap<number, StringToken>;
  readonly lineStarts: readonly number[];
  readonly comments: ReadonlyMap<number, string>;
}

function regexStartsAt(content: string, index: number): boolean {
  let previous = index - 1;
  while (previous >= 0 && /\s/.test(content[previous]!)) previous -= 1;
  if (previous < 0 || "([{:,;=!?&|+-*%^~<>".includes(content[previous]!)) {
    return true;
  }
  return /\b(?:case|return|throw|yield)\s*$/.test(content.slice(0, index));
}

function linearChangedLines(
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

function changedLines(before: string, after: string): ChangedLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] ===
      afterLines[afterLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);
  if (beforeMiddle.length * afterMiddle.length > 1_000_000) {
    return linearChangedLines(beforeMiddle, afterMiddle, prefix);
  }
  const distances = Array.from({ length: beforeMiddle.length + 1 }, () =>
    Array<number>(afterMiddle.length + 1).fill(0),
  );
  for (let index = 0; index <= beforeMiddle.length; index += 1) {
    distances[index]![0] = index;
  }
  for (let index = 0; index <= afterMiddle.length; index += 1) {
    distances[0]![index] = index;
  }
  for (
    let beforeIndex = 1;
    beforeIndex <= beforeMiddle.length;
    beforeIndex += 1
  ) {
    for (
      let afterIndex = 1;
      afterIndex <= afterMiddle.length;
      afterIndex += 1
    ) {
      const substitution =
        distances[beforeIndex - 1]![afterIndex - 1]! +
        (beforeMiddle[beforeIndex - 1] === afterMiddle[afterIndex - 1] ? 0 : 1);
      distances[beforeIndex]![afterIndex] = Math.min(
        substitution,
        distances[beforeIndex - 1]![afterIndex]! + 1,
        distances[beforeIndex]![afterIndex - 1]! + 1,
      );
    }
  }

  const reversed: ChangedLine[] = [];
  let beforeIndex = beforeMiddle.length;
  let afterIndex = afterMiddle.length;
  while (beforeIndex > 0 || afterIndex > 0) {
    if (
      beforeIndex > 0 &&
      afterIndex > 0 &&
      beforeMiddle[beforeIndex - 1] === afterMiddle[afterIndex - 1]
    ) {
      beforeIndex -= 1;
      afterIndex -= 1;
      continue;
    }
    if (
      beforeIndex > 0 &&
      afterIndex > 0 &&
      distances[beforeIndex]![afterIndex] ===
        distances[beforeIndex - 1]![afterIndex - 1]! + 1
    ) {
      reversed.push({
        line: prefix + afterIndex,
        beforeLine: prefix + beforeIndex,
        afterLine: prefix + afterIndex,
        before: beforeMiddle[beforeIndex - 1]!,
        after: afterMiddle[afterIndex - 1]!,
      });
      beforeIndex -= 1;
      afterIndex -= 1;
      continue;
    }
    if (
      afterIndex > 0 &&
      (beforeIndex === 0 ||
        distances[beforeIndex]![afterIndex] ===
          distances[beforeIndex]![afterIndex - 1]! + 1)
    ) {
      reversed.push({
        line: prefix + afterIndex,
        beforeLine: prefix + beforeIndex + 1,
        afterLine: prefix + afterIndex,
        before: "",
        after: afterMiddle[afterIndex - 1]!,
      });
      afterIndex -= 1;
      continue;
    }
    reversed.push({
      line: prefix + afterIndex + 1,
      beforeLine: prefix + beforeIndex,
      afterLine: prefix + afterIndex + 1,
      before: beforeMiddle[beforeIndex - 1]!,
      after: "",
    });
    beforeIndex -= 1;
  }
  return reversed.reverse();
}

function lexicalScan(content: string): LexicalScan {
  let mask = "";
  let index = 0;
  let line = 1;
  const strings: StringToken[] = [];
  const comments = new Map<number, string>();

  const recordComment = (text: string, startLine: number): void => {
    for (const part of text.split("\n")) {
      comments.set(startLine, `${comments.get(startLine) ?? ""}${part}`);
      startLine += 1;
    }
  };

  while (index < content.length) {
    const character = content[index]!;
    const next = content[index + 1];
    if (character === "/" && next === "/") {
      const start = index;
      while (index < content.length && content[index] !== "\n") index += 1;
      const text = content.slice(start, index);
      recordComment(text, line);
      mask += " ".repeat(text.length);
      continue;
    }
    if (character === "/" && next === "*") {
      const start = index;
      const startLine = line;
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        if (content[index] === "\n") line += 1;
        index += 1;
      }
      if (index < content.length) index += 2;
      const text = content.slice(start, index);
      recordComment(text, startLine);
      mask += text.replace(/[^\n]/g, " ");
      continue;
    }
    if (character === "/") {
      if (regexStartsAt(content, index)) {
        const start = index;
        index += 1;
        let inClass = false;
        while (index < content.length) {
          if (content[index] === "\\") {
            index += 2;
            continue;
          }
          if (content[index] === "[") inClass = true;
          else if (content[index] === "]") inClass = false;
          else if (content[index] === "/" && !inClass) break;
          if (content[index] === "\n") break;
          index += 1;
        }
        if (content[index] === "/") {
          index += 1;
          while (/[A-Za-z]/.test(content[index] ?? "")) index += 1;
          mask += content.slice(start, index).replace(/[^\n]/g, " ");
          continue;
        }
        index = start;
      }
    }
    if (character === "#") {
      const start = index;
      while (index < content.length && content[index] !== "\n") index += 1;
      const text = content.slice(start, index);
      recordComment(text, line);
      mask += " ".repeat(text.length);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const fullStart = index;
      const delimiterLength =
        character !== "`" &&
        content[index + 1] === character &&
        content[index + 2] === character
          ? 3
          : 1;
      const delimiter = character.repeat(delimiterLength);
      index += delimiterLength;
      const start = index;
      while (index < content.length && !content.startsWith(delimiter, index)) {
        if (content[index] === "\n") line += 1;
        if (content[index] === "\\" && index + 1 < content.length) index += 1;
        index += 1;
      }
      const end = index;
      if (index < content.length) index += delimiterLength;
      const fullEnd = index;
      strings.push({
        fullStart,
        fullEnd,
        start,
        end,
        value: content.slice(start, end),
      });
      mask += content.slice(fullStart, fullEnd).replace(/[^\n]/g, " ");
      continue;
    }
    mask += character;
    if (character === "\n") line += 1;
    index += 1;
  }
  return {
    mask,
    strings,
    stringAt: new Map(strings.map((string) => [string.fullStart, string])),
    lineStarts: [
      0,
      ...[...content.matchAll(/\n/g)].map((match) => match.index + 1),
    ],
    comments,
  };
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
  scan: LexicalScan,
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

function modelTokens(content: string, scan: LexicalScan): ModelToken[] {
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
  if (before === after) return true;
  for (const punctuation of [";", ","]) {
    const beforeWithout = before.endsWith(punctuation)
      ? before.slice(0, -1)
      : before;
    const afterWithout = after.endsWith(punctuation)
      ? after.slice(0, -1)
      : after;
    if (
      beforeWithout === afterWithout &&
      (before.endsWith(punctuation) || after.endsWith(punctuation))
    ) {
      return true;
    }
  }
  return false;
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
): { violation?: DiffViolationKind; replacements: number } {
  if (
    (beforeComments.get(change.beforeLine) ?? "") !==
    (afterComments.get(change.afterLine) ?? "")
  ) {
    return { violation: "comment_change", replacements: 0 };
  }
  if (change.before.replace(/\s/g, "") === change.after.replace(/\s/g, "")) {
    return { violation: "whitespace_change", replacements: 0 };
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
    return { violation: "non_model_change", replacements: 0 };
  }

  const replacements: string[] = [];
  for (let index = 0; index < beforeLineTokens.length; index += 1) {
    const from = beforeLineTokens[index]!.value;
    const to = afterLineTokens[index]!.value;
    if (from === to) continue;
    const pair = `${from}\0${to}`;
    const alreadyUsed = replacements.filter((used) => used === pair).length;
    if ((allowedPairs.get(pair) ?? 0) <= alreadyUsed) {
      return { violation: "disallowed_model", replacements: 0 };
    }
    replacements.push(pair);
  }
  for (const pair of replacements) {
    allowedPairs.set(pair, allowedPairs.get(pair)! - 1);
  }
  return replacements.length === 0
    ? { violation: "non_model_change", replacements: 0 }
    : { replacements: replacements.length };
}

export function lintSwapDiff({
  files,
  allowedModels,
}: {
  readonly files: readonly {
    readonly path: string;
    readonly before: string;
    readonly after: string;
  }[];
  readonly allowedModels: {
    readonly from: readonly string[];
    readonly to: readonly string[];
  };
}): DiffLintResult {
  const violations: DiffViolation[] = [];
  const allowedPairs = new Map<string, number>();
  for (const [index, from] of allowedModels.from.entries()) {
    const pair = `${from}\0${allowedModels.to[index] ?? ""}`;
    allowedPairs.set(pair, (allowedPairs.get(pair) ?? 0) + 1);
  }

  for (const file of files) {
    const changes = changedLines(file.before, file.after);
    if (changes.length === 0) continue;
    if (isLockfile(file.path)) {
      violations.push({
        path: file.path,
        line: changes[0]!.line,
        kind: "lockfile_change",
      });
      continue;
    }

    const beforeScan = lexicalScan(file.before);
    const afterScan = lexicalScan(file.after);
    const beforeTokens = modelTokens(file.before, beforeScan);
    const afterTokens = modelTokens(file.after, afterScan);
    const fileViolations: DiffViolation[] = [];
    let replacements = 0;
    for (const change of changes) {
      const result = lintChangedLine(
        change,
        beforeTokens,
        afterTokens,
        beforeScan.comments,
        afterScan.comments,
        allowedPairs,
      );
      replacements += result.replacements;
      if (result.violation !== undefined) {
        fileViolations.push({
          path: file.path,
          line: change.line,
          kind: result.violation,
        });
      }
    }
    if (
      replacements === 0 &&
      fileViolations.length > 0 &&
      fileViolations.every(({ kind }) => kind === "non_model_change")
    ) {
      violations.push({
        path: file.path,
        line: fileViolations[0]!.line,
        kind: "unswapped_file",
      });
    } else {
      violations.push(...fileViolations);
    }
  }

  return { pass: violations.length === 0, violations };
}
