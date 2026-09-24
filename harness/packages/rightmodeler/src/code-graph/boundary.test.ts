import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesRoot = fileURLToPath(new URL("../../..", import.meta.url));
const specifierPattern = /\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g;

async function typescriptFiles(
  directory: string,
): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(directory, { recursive: true });
  const files = entries
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(directory, entry));
  return Promise.all(
    files.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
}

function specifiers(text: string): string[] {
  return [...text.matchAll(specifierPattern)].map(
    (match) => (match[1] ?? match[2])!,
  );
}

describe("code graph boundary", () => {
  it("keeps the code graph module away from evidence and store writers", async () => {
    const codeGraph = await typescriptFiles(join(sourceRoot, "code-graph"));
    const allowed =
      /^node:|^zod$|^@rightmodeler\/core$|^\.\.\/enrich\/index\.js$|^\.\.\/report\/format\.js$|^\.\/[a-z-]+\.js$/;

    expect(codeGraph.length).toBeGreaterThan(0);
    for (const { path, text } of codeGraph) {
      expect(
        specifiers(text).filter((specifier) => !allowed.test(specifier)),
        path,
      ).toEqual([]);
      expect(text, path).not.toMatch(
        /\b(putImmutable|putMutable|compareAndSwap|appendLifecycleEvent|writeCheckpoint|FsStore)\b/,
      );
    }
    for (const name of ["core", "kernel", "replay", "scanner", "executor"]) {
      const root = join(packagesRoot, name, "src");
      const entries = await readdir(root, { recursive: true });
      for (const entry of entries.filter((file) => file.endsWith(".ts"))) {
        expect(
          await readFile(join(root, entry), "utf8"),
          `${name}/src/${entry}`,
        ).not.toMatch(/code-graph|codeGraph/);
      }
    }
  });

  it("is imported only by the pipeline, the CLI and the apply orchestrator", async () => {
    const importers = (await typescriptFiles(sourceRoot))
      .map(({ path, text }) => ({
        path: relative(sourceRoot, path).split(sep).join("/"),
        text,
      }))
      .filter(
        ({ path, text }) =>
          !path.startsWith("code-graph/") &&
          specifiers(text).some((specifier) =>
            specifier.includes("code-graph/"),
          ),
      )
      .map(({ path }) => path);

    expect(
      importers.filter(
        (path) =>
          !["pipeline.ts", "cli.ts", "apply/orchestrator.ts"].includes(path),
      ),
    ).toEqual([]);
    expect(importers).toContain("pipeline.ts");
  });
});
