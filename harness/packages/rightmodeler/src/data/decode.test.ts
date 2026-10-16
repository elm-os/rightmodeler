import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { traceAdapters } from "./adapters.js";
import { detectFormat } from "./adapters/shared.js";
import { decodeText } from "./decode.js";

function windowsPowerShellBytes(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text.replaceAll("\n", "\r\n"), "utf16le"),
  ]);
}

describe("decodeText", () => {
  const text = '{"model":"acme/large-1","output":"café"}\n';

  it("reads UTF-16LE with its byte order mark, as Windows PowerShell 5.1 writes it", () => {
    expect(decodeText(windowsPowerShellBytes(text))).toBe(
      text.replaceAll("\n", "\r\n"),
    );
  });

  it("drops a UTF-8 byte order mark and keeps plain UTF-8 as it is", () => {
    const bytes = Buffer.from(text);
    expect(
      decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])),
    ).toBe(text);
    expect(decodeText(bytes)).toBe(text);
  });

  it.each(["otel-genai.json", "openai.jsonl"])(
    "detects %s rewritten by Windows PowerShell 5.1 like the original",
    (name) => {
      const original = readFileSync(
        new URL(`../../../../fixtures/traces/${name}`, import.meta.url),
        "utf8",
      );

      expect(
        detectFormat(
          decodeText(windowsPowerShellBytes(original)),
          traceAdapters,
        ).name,
      ).toBe(detectFormat(original, traceAdapters).name);
    },
  );
});
