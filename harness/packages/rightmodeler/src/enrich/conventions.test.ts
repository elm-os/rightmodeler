import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { captureConventions } from "./conventions.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

async function temporaryRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-conventions-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("captureConventions", () => {
  it("captures includes, pointers, nested instructions, ownership, templates, formatting, and commit style from the demo fixture", async () => {
    const conventions = await captureConventions({
      repoDir: join(repositoryRoot, "harness/fixtures/demo-app"),
    });

    expect(conventions.version).toBe("1");
    expect(conventions.instructionFiles.map(({ path }) => path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "config/AGENTS.md",
      "docs/fixture-conventions.md",
    ]);
    expect(
      conventions.instructionFiles.find(
        ({ path }) => path === "docs/fixture-conventions.md",
      )?.content,
    ).toContain("Use conventional commit subjects");
    expect(conventions.prTemplate).toContain("Describe the model swap");
    expect(conventions.codeowners).toBe("CODEOWNERS");
    expect(conventions.formatter).toEqual({
      kind: "prettier",
      configPath: ".prettierrc",
    });
    expect(conventions.commitConvention.style).toBe("conventional");
    expect(conventions.commitConvention.inferredFrom.length).toBeGreaterThan(0);
    expect(conventions).toHaveProperty("branchPrefix");
    expect(conventions.warnings).toEqual([]);
  });

  it("captures the pointer convention and nested instructions without inventing a formatter in the LangGraph fixture", async () => {
    const conventions = await captureConventions({
      repoDir: join(repositoryRoot, "harness/fixtures/langgraph-app"),
    });

    expect(conventions.instructionFiles.map(({ path }) => path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "docs/AGENTS.md",
      "docs/fixture-conventions.md",
    ]);
    expect(
      conventions.instructionFiles.find(({ path }) => path === "CLAUDE.md")
        ?.content,
    ).toBe("@AGENTS.md\n");
    expect(conventions.prTemplate).toContain("Describe the model swap");
    expect(conventions.codeowners).toBe("CODEOWNERS");
    expect(conventions.formatter).toEqual({ kind: null, configPath: null });
    expect(conventions.commitConvention.style).toBe("conventional");
    expect(conventions.warnings).toEqual([]);
  });

  it("returns a named warning for an unreadable include", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(join(repoDir, "AGENTS.md"), "@include missing.md\n");

    const conventions = await captureConventions({ repoDir });

    expect(conventions.warnings).toContainEqual({
      name: "instruction_include_unreadable",
      path: "missing.md",
      includedFrom: "AGENTS.md",
    });
  });

  it("returns a named warning for cyclic instruction pointers", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(join(repoDir, "AGENTS.md"), "@CLAUDE.md\n");
    await writeFile(join(repoDir, "CLAUDE.md"), "@AGENTS.md\n");

    const conventions = await captureConventions({ repoDir });

    expect(conventions.warnings).toContainEqual({
      name: "instruction_include_cycle",
      path: "AGENTS.md",
      includedFrom: "CLAUDE.md",
    });
  });
});
