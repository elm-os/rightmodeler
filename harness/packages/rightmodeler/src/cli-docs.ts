import { readFileSync, readdirSync } from "node:fs";

const docsUrl = new URL("../docs/", import.meta.url);

export function docNames(): string[] {
  try {
    return readdirSync(docsUrl)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function readDoc(name: string): string {
  return readFileSync(new URL(`${name}.md`, docsUrl), "utf8");
}
