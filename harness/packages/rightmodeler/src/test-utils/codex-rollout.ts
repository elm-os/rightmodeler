import { readFile } from "node:fs/promises";

// The Codex fixture records /synthetic/project as its working directory, and discovery keeps
// only the sessions recorded in the repository it searches for.
export async function codexRollout(cwd: string): Promise<string> {
  const [meta, ...rest] = (
    await readFile(
      new URL("../../../../fixtures/traces/codex.jsonl", import.meta.url),
      "utf8",
    )
  ).split("\n");
  const record = JSON.parse(meta!) as { payload: { cwd: string } };
  record.payload.cwd = cwd;
  return [JSON.stringify(record), ...rest].join("\n");
}
