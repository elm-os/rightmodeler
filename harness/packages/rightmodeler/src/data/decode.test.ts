import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  codexAdapter,
  parseTraceRecords,
  TraceParseError,
  traceAdapters,
} from "./adapters.js";
import { detectFormat } from "./adapters/shared.js";
import { decodeText, readTraceFile } from "./decode.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rightmodeler-decode-"));
  temporaryDirectories.push(path);
  return path;
}

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

describe("readTraceFile", () => {
  it("reads a compressed Codex rollout into the same runs as the plain file", async () => {
    const plain = fileURLToPath(
      new URL("../../../../fixtures/traces/codex.jsonl", import.meta.url),
    );
    const compressed = join(await temporaryDirectory(), "rollout.jsonl.zst");
    await writeFile(compressed, zstdCompressSync(readFileSync(plain)));
    const runs = async (path: string) =>
      codexAdapter.adaptWithReport(
        parseTraceRecords(decodeText(await readTraceFile(path))),
      );

    const expected = await runs(plain);

    expect(expected.runs.length).toBeGreaterThan(0);
    expect(await runs(compressed)).toEqual(expected);
  });

  it("refuses a compressed trace that decompresses past the limit", async () => {
    const directory = await temporaryDirectory();
    const atLimit = join(directory, "at-limit.jsonl.zst");
    const overLimit = join(directory, "over-limit.jsonl.zst");
    await Promise.all([
      writeFile(atLimit, zstdCompressSync(Buffer.alloc(1024, " "))),
      writeFile(overLimit, zstdCompressSync(Buffer.alloc(1025, " "))),
    ]);

    await expect(readTraceFile(atLimit, 1024)).resolves.toHaveLength(1024);
    const refusal = await readTraceFile(overLimit, 1024).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(TraceParseError);
    expect((refusal as Error).message).toContain(
      "Trace input decompresses to more than 1024 bytes",
    );
    expect((refusal as Error).message).toContain(overLimit);
  });
});
