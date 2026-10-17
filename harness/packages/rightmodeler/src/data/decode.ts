// Windows PowerShell 5.1 writes files as UTF-16LE with a byte order mark, and Windows editors
// often start UTF-8 files with one. Both marks are dropped.
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder(
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8",
  ).decode(bytes);
}
