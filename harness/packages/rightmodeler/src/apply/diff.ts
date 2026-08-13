import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeStepId, type StepRecord } from "@rightmodeler/core";
import {
  createMatcherRegistry,
  type CandidateMatch,
} from "@rightmodeler/scanner";

const pipelineProjectId = "project";

export interface SwapRequest {
  readonly stepRecord: StepRecord;
  readonly fromModel: string;
  readonly toModel: string;
}

export interface SwapDiffHunk {
  readonly line: number;
  readonly before: string;
  readonly after: string;
  readonly replacements: readonly {
    readonly from: string;
    readonly to: string;
  }[];
}

export interface SwapDiffFile {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly hunks: readonly SwapDiffHunk[];
}

export interface SwapDiffFailure {
  readonly path: string;
  readonly reason: "stale_location";
}

export type SwapDiffResult = SwapDiffFile | SwapDiffFailure;

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly from: string;
  readonly to: string;
}

interface ValueSpan {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

function lineStart(content: string, line: number): number {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) return -1;
    start = newline + 1;
  }
  return start;
}

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function lineText(content: string, line: number): string {
  const start = lineStart(content, line);
  if (start === -1) return "";
  const end = content.indexOf("\n", start);
  return content
    .slice(start, end === -1 ? content.length : end)
    .replace(/\r$/, "");
}

function callEnd(content: string, start: number): number {
  const searchable = maskNonCode(content);
  const open = searchable.indexOf("(", start);
  if (open === -1) return -1;
  let depth = 0;
  for (let index = open; index < searchable.length; index += 1) {
    const character = searchable[index]!;
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function maskNonCode(content: string): string {
  let masked = "";
  let index = 0;
  while (index < content.length) {
    const character = content[index]!;
    const next = content[index + 1];
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
      const valueStart = index;
      while (index < content.length) {
        if (content.startsWith(delimiter, index)) {
          index += delimiterLength;
          break;
        }
        if (content[index] === "\\") index += 1;
        index += 1;
      }
      const fullText = content.slice(fullStart, index);
      const value = content.slice(
        valueStart,
        Math.max(valueStart, index - delimiterLength),
      );
      masked +=
        delimiterLength === 1 && ["model", "model_name"].includes(value)
          ? fullText
          : fullText.replace(/[^\n]/g, " ");
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
    if (character === "#") {
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

function trimRange(content: string, range: TextRange): TextRange {
  let start = range.start;
  let end = range.end;
  while (/\s/.test(content[start] ?? "")) start += 1;
  while (end > start && /\s/.test(content[end - 1] ?? "")) end -= 1;
  return { start, end };
}

function regexStartsAt(
  content: string,
  index: number,
  lowerBound: number,
): boolean {
  let previous = index - 1;
  while (previous >= lowerBound && /\s/.test(content[previous]!)) previous -= 1;
  if (
    previous < lowerBound ||
    "([{:,;=!?&|+-*%^~<>".includes(content[previous]!)
  ) {
    return true;
  }
  return /\b(?:case|return|throw|yield)\s*$/.test(
    content.slice(lowerBound, index),
  );
}

function splitTopLevel(
  content: string,
  start: number,
  end: number,
): TextRange[] | null {
  const ranges: TextRange[] = [];
  let partStart = start;
  let round = 0;
  let square = 0;
  let curly = 0;
  let index = start;

  while (index < end) {
    const character = content[index]!;
    const next = content[index + 1];
    if (character === '"' || character === "'" || character === "`") {
      const delimiterLength =
        character !== "`" &&
        next === character &&
        content[index + 2] === character
          ? 3
          : 1;
      const delimiter = character.repeat(delimiterLength);
      index += delimiterLength;
      while (index < end && !content.startsWith(delimiter, index)) {
        if (content[index] === "\\") index += 1;
        index += 1;
      }
      if (index >= end) return null;
      index += delimiterLength;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < end && content[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const close = content.indexOf("*/", index + 2);
      if (close === -1 || close >= end) return null;
      index = close + 2;
      continue;
    }
    if (character === "#") {
      while (index < end && content[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && regexStartsAt(content, index, start)) {
      index += 1;
      let inClass = false;
      while (index < end) {
        if (content[index] === "\\") {
          index += 2;
          continue;
        }
        if (content[index] === "[") inClass = true;
        else if (content[index] === "]") inClass = false;
        else if (content[index] === "/" && !inClass) break;
        index += 1;
      }
      if (index >= end) return null;
      index += 1;
      while (/[A-Za-z]/.test(content[index] ?? "")) index += 1;
      continue;
    }

    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    else if (character === "," && round === 0 && square === 0 && curly === 0) {
      ranges.push({ start: partStart, end: index });
      partStart = index + 1;
    }
    if (round < 0 || square < 0 || curly < 0) return null;
    index += 1;
  }
  if (round !== 0 || square !== 0 || curly !== 0) return null;
  ranges.push({ start: partStart, end });
  return ranges;
}

function topLevelModelSpans(
  content: string,
  callStart: number,
  callEndOffset: number,
): ValueSpan[] | null {
  const open = content.indexOf("(", callStart);
  if (open === -1 || callEndOffset <= open + 1) return null;
  const outer = splitTopLevel(content, open + 1, callEndOffset - 1);
  if (outer === null) return null;
  const first = trimRange(
    content,
    outer[0] ?? { start: open + 1, end: open + 1 },
  );
  let parts = outer;
  let separator = "=";
  if (content[first.start] === "{" && content[first.end - 1] === "}") {
    const objectParts = splitTopLevel(content, first.start + 1, first.end - 1);
    if (objectParts === null) return null;
    parts = objectParts;
    separator = ":";
  }

  const spans: ValueSpan[] = [];
  for (const part of parts) {
    const trimmed = trimRange(content, part);
    const keyPattern =
      separator === ":"
        ? /^(?:["'](?:model|model_name)["']|(?:model|model_name))\s*:/
        : /^(?:model|model_name)\s*=/;
    const key = keyPattern.exec(content.slice(trimmed.start, trimmed.end));
    if (key === null) continue;
    const span = valueAfter(content, trimmed.start + key[0].length, true);
    if (span !== null && span.end <= trimmed.end) spans.push(span);
  }
  return spans;
}

function valueAfter(
  content: string,
  start: number,
  allowWrapper: boolean,
): ValueSpan | null {
  let index = start;
  while (/\s/.test(content[index] ?? "")) index += 1;
  if (allowWrapper) {
    const wrapper = /^[A-Za-z_$][\w$]*\s*\(\s*/.exec(content.slice(index));
    if (wrapper !== null) index += wrapper[0].length;
  }
  const quote = content[index];
  if (quote === '"' || quote === "'") {
    const end = content.indexOf(quote, index + 1);
    if (end === -1) return null;
    return { start: index + 1, end, value: content.slice(index + 1, end) };
  }
  const value = /^[A-Za-z0-9][A-Za-z0-9._:/-]*/.exec(content.slice(index))?.[0];
  return value === undefined
    ? null
    : { start: index, end: index + value.length, value };
}

function valueSpansForKeys(
  content: string,
  keyPattern: RegExp,
  allowWrapper: boolean,
): ValueSpan[] {
  const masked = maskNonCode(content);
  const spans: ValueSpan[] = [];
  for (const match of masked.matchAll(keyPattern)) {
    const span = valueAfter(
      content,
      match.index + match[0].length,
      allowWrapper,
    );
    if (span !== null) spans.push(span);
  }
  return spans;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function constantSpans(
  content: string,
  identifier: string,
  expectedValue: string,
  callOffset: number,
  isPython: boolean,
): ValueSpan[] | null {
  const masked = maskNonCode(content);
  const escapedIdentifier = escapeRegExp(identifier);
  const bindingPatterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${escapedIdentifier}\\b`, "g"),
  ];
  if (/^[A-Za-z_][\w]*$/.test(identifier)) {
    bindingPatterns.push(
      new RegExp(`^\\s*${escapedIdentifier}(?:\\s*:\\s*[^=\\n]+)?\\s*=`, "gm"),
    );
  }
  const bindingCount = bindingPatterns.reduce(
    (count, pattern) => count + [...masked.matchAll(pattern)].length,
    0,
  );
  const parameterLists = [
    ...masked.matchAll(/\b(?:async\s+)?(?:function|def)\b[^\n(]*\(([^)]*)\)/g),
    ...masked.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g),
    ...masked.matchAll(/\bcatch\s*\(([^)]*)\)/g),
  ];
  const identifierPattern = new RegExp(`\\b${escapedIdentifier}\\b`);
  const identifierUses = [
    ...masked.matchAll(new RegExp(`\\b${escapedIdentifier}\\b`, "g")),
  ];
  if (
    bindingCount !== 1 ||
    identifierUses.length !== 2 ||
    parameterLists.some((match) => identifierPattern.test(match[1] ?? "")) ||
    new RegExp(`\\b${escapedIdentifier}\\b\\s*=>`).test(masked)
  ) {
    return null;
  }
  const patterns = [
    new RegExp(
      `\\b(?:export\\s+)?const\\s+${escapedIdentifier}(?:\\s*:\\s*[^=;\\n]+)?\\s*=`,
      "g",
    ),
  ];
  if (/^[A-Z][A-Z0-9_]*$/.test(identifier)) {
    patterns.push(
      new RegExp(`^\\s*${escapedIdentifier}(?:\\s*:\\s*[^=\\n]+)?\\s*=`, "gm"),
    );
  }
  const declarations: ValueSpan[] = [];
  const spans: ValueSpan[] = [];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const span = valueAfter(content, match.index + match[0].length, false);
      if (span !== null) declarations.push(span);
      if (span?.value === expectedValue) spans.push(span);
    }
  }
  if (declarations.length !== 1 || spans.length !== 1) return null;

  const declaration = declarations[0]!;
  if (declaration.start >= callOffset) return null;
  if (isPython) {
    const start = content.lastIndexOf("\n", declaration.start - 1) + 1;
    if (/\s/.test(content[start] ?? "")) return null;
  } else {
    const bracesAt = (offset: number): number[] => {
      const stack: number[] = [];
      for (let index = 0; index < offset; index += 1) {
        if (masked[index] === "{") stack.push(index);
        else if (masked[index] === "}") stack.pop();
      }
      return stack;
    };
    const declarationBraces = bracesAt(declaration.start);
    const callBraces = bracesAt(callOffset);
    if (declarationBraces.some((brace, index) => callBraces[index] !== brace)) {
      return null;
    }
  }
  return spans;
}

function locateReplacement(
  content: string,
  candidate: CandidateMatch,
  request: SwapRequest,
): Replacement | null {
  if (
    request.fromModel.length === 0 ||
    request.toModel.length === 0 ||
    request.fromModel.includes("\n") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(request.fromModel) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(request.toModel)
  ) {
    return null;
  }

  const start = lineStart(content, candidate.line);
  if (start === -1) return null;

  let spans: ValueSpan[];
  let callOffset: number | null = null;
  if (candidate.slug.startsWith("cfg-")) {
    const end = content.indexOf("\n", start);
    const line = content.slice(start, end === -1 ? content.length : end);
    spans =
      candidate.slug === "cfg-model-env-var"
        ? valueSpansForKeys(
            line,
            /\b(?:(?:OPENAI|ANTHROPIC|LITELLM|LANGCHAIN|AI|LLM)_MODEL(?:_ID|_NAME)?|MODEL_(?:ID|NAME))\s*[:=]/g,
            false,
          ).map((span) => ({
            ...span,
            start: span.start + start,
            end: span.end + start,
          }))
        : valueSpansForKeys(
            line,
            /(?:\b(?:model|model_name)|["'](?:model|model_name)["'])\s*[:=]/g,
            true,
          ).map((span) => ({
            ...span,
            start: span.start + start,
            end: span.end + start,
          }));
  } else {
    if (
      !candidate.normalizedCallShape.argumentKeys.some((key) =>
        ["model", "model_name"].includes(key),
      )
    ) {
      return null;
    }
    const lineEnd = content.indexOf("\n", start);
    const maskedLine = maskNonCode(
      content.slice(start, lineEnd === -1 ? content.length : lineEnd),
    );
    const calleePattern = new RegExp(
      `\\b${escapeRegExp(candidate.normalizedCallShape.callee)}\\s*\\(`,
      "g",
    );
    const callStarts = [...maskedLine.matchAll(calleePattern)];
    if (callStarts.length !== 1) return null;
    const calleeStart = start + callStarts[0]!.index;
    const end = calleeStart === -1 ? -1 : callEnd(content, calleeStart);
    if (calleeStart === -1 || end === -1) return null;
    const callSpans = topLevelModelSpans(content, calleeStart, end);
    if (callSpans === null) return null;
    spans = callSpans;
    callOffset = calleeStart;
  }

  const direct = spans.filter(
    ({ value }) =>
      value === request.fromModel &&
      ((candidate.modelId === undefined &&
        request.stepRecord.currentModel === null) ||
        (value === candidate.modelId &&
          value === request.stepRecord.currentModel)),
  );
  if (direct.length === 1) {
    return { ...direct[0]!, from: request.fromModel, to: request.toModel };
  }
  if (direct.length > 1) return null;

  if (
    candidate.modelId === undefined ||
    !/^[A-Za-z_$][\w$]*$/.test(candidate.modelId) ||
    request.stepRecord.currentModel !== candidate.modelId
  ) {
    return null;
  }
  if (callOffset === null) return null;
  const constants = constantSpans(
    content,
    candidate.modelId,
    request.fromModel,
    callOffset,
    candidate.slug.startsWith("py-"),
  );
  if (constants === null) return null;
  return {
    ...constants[0]!,
    from: request.fromModel,
    to: request.toModel,
  };
}

function freshCandidate(
  content: string,
  path: string,
  stepRecord: StepRecord,
): CandidateMatch | null {
  const matcher = createMatcherRegistry().getBySlug(
    stepRecord.callSite.matcherSlug,
  );
  if (matcher === undefined) return null;
  const normalizedContent = content.replaceAll("\r\n", "\n");
  const candidates = matcher.match(normalizedContent, path).filter(
    (candidate) =>
      computeStepId({
        projectId: pipelineProjectId,
        normalizedPath: path,
        enclosingSymbolPath: candidate.enclosingSymbolPath,
        normalizedCallShape: candidate.normalizedCallShape,
      }) === stepRecord.stepId,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

export function buildSwapDiff({
  repoDir,
  swaps,
}: {
  readonly repoDir: string;
  readonly swaps: readonly SwapRequest[];
}): SwapDiffResult[] {
  const grouped = new Map<string, SwapRequest[]>();
  for (const swap of swaps) {
    const path = swap.stepRecord.callSite.path;
    grouped.set(path, [...(grouped.get(path) ?? []), swap]);
  }

  const results: SwapDiffResult[] = [];
  for (const [path, fileSwaps] of grouped) {
    let before: string;
    try {
      before = readFileSync(join(repoDir, path), "utf8");
    } catch {
      results.push({ path, reason: "stale_location" });
      continue;
    }

    const replacements: Replacement[] = [];
    let stale = false;
    for (const swap of fileSwaps) {
      const candidate = freshCandidate(before, path, swap.stepRecord);
      const replacement =
        candidate === null ? null : locateReplacement(before, candidate, swap);
      if (replacement === null) {
        stale = true;
        break;
      }
      const duplicate = replacements.find(
        ({ start, end }) =>
          start === replacement.start && end === replacement.end,
      );
      if (
        duplicate !== undefined &&
        (duplicate.from !== replacement.from || duplicate.to !== replacement.to)
      ) {
        stale = true;
        break;
      }
      if (duplicate === undefined) replacements.push(replacement);
    }

    replacements.sort((left, right) => left.start - right.start);
    if (
      stale ||
      replacements.some(
        (replacement, index) =>
          index > 0 && replacement.start < replacements[index - 1]!.end,
      )
    ) {
      results.push({ path, reason: "stale_location" });
      continue;
    }

    let after = before;
    for (const replacement of [...replacements].reverse()) {
      after =
        after.slice(0, replacement.start) +
        replacement.to +
        after.slice(replacement.end);
    }
    const touchedLines = [
      ...new Set(replacements.map(({ start }) => lineNumber(before, start))),
    ].sort((left, right) => left - right);
    results.push({
      path,
      before,
      after,
      hunks: touchedLines.map((line) => ({
        line,
        before: lineText(before, line),
        after: lineText(after, line),
        replacements: replacements
          .filter(({ start }) => lineNumber(before, start) === line)
          .map(({ from, to }) => ({ from, to })),
      })),
    });
  }
  return results;
}
