import { constants } from "node:buffer";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

import { TraceParseError } from "./adapters/shared.js";

// Windows PowerShell 5.1 writes files as UTF-16LE with a byte order mark, and Windows editors
// often start UTF-8 files with one. Both marks are dropped.
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder(
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8",
  ).decode(bytes);
}

// Codex compresses older session rollouts to .jsonl.zst. decodeText turns a trace into one
// string, so decompression stops at the longest string Node.js can hold, and a small file
// cannot expand without bound in memory.
export async function readTraceFile(
  path: string,
  limit = constants.MAX_STRING_LENGTH,
): Promise<Buffer> {
  const bytes = await readFile(path);
  if (!path.endsWith(".jsonl.zst")) return bytes;
  try {
    return zstdDecompressSync(bytes, { maxOutputLength: limit });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") {
      throw error;
    }
    throw new TraceParseError(
      `Trace input decompresses to more than ${limit} bytes, the longest string Node.js can hold: ${path}`,
      { cause: error },
    );
  }
}
