export interface SourceStringToken {
  readonly fullStart: number;
  readonly fullEnd: number;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

export interface SourceLexicalScan {
  readonly mask: string;
  readonly keyMask: string;
  readonly strings: readonly SourceStringToken[];
  readonly stringAt: ReadonlyMap<number, SourceStringToken>;
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

export function scanSource(content: string): SourceLexicalScan {
  let mask = "";
  let keyMask = "";
  let index = 0;
  let line = 1;
  const strings: SourceStringToken[] = [];
  const comments = new Map<number, string>();

  const recordComment = (text: string, startLine: number): void => {
    for (const part of text.split("\n")) {
      comments.set(startLine, `${comments.get(startLine) ?? ""}${part}`);
      startLine += 1;
    }
  };
  const appendMasked = (text: string): void => {
    const masked = text.replace(/[^\n]/g, " ");
    mask += masked;
    keyMask += masked;
  };

  while (index < content.length) {
    const character = content[index]!;
    const next = content[index + 1];
    if (character === "/" && next === "/") {
      const start = index;
      while (index < content.length && content[index] !== "\n") index += 1;
      const text = content.slice(start, index);
      recordComment(text, line);
      appendMasked(text);
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
      appendMasked(text);
      continue;
    }
    if (character === "/" && regexStartsAt(content, index)) {
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
        appendMasked(content.slice(start, index));
        continue;
      }
      index = start;
    }
    if (character === "#") {
      const start = index;
      while (index < content.length && content[index] !== "\n") index += 1;
      const text = content.slice(start, index);
      recordComment(text, line);
      appendMasked(text);
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
      const text = content.slice(fullStart, fullEnd);
      const value = content.slice(start, end);
      strings.push({ fullStart, fullEnd, start, end, value });
      mask += text.replace(/[^\n]/g, " ");
      keyMask += ["model", "model_name"].includes(value)
        ? text
        : text.replace(/[^\n]/g, " ");
      continue;
    }
    mask += character;
    keyMask += character;
    if (character === "\n") line += 1;
    index += 1;
  }

  return {
    mask,
    keyMask,
    strings,
    stringAt: new Map(strings.map((string) => [string.fullStart, string])),
    lineStarts: [
      0,
      ...[...content.matchAll(/\n/g)].map((match) => match.index + 1),
    ],
    comments,
  };
}
