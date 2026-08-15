import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { makeGitFixture } from "../test-utils/git-fixture.js";
import { captureConventions } from "./conventions.js";

const execFileAsync = promisify(execFile);
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

async function git(repoDir: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args]);
}

async function initializeGitRepository(repoDir: string): Promise<void> {
  await git(repoDir, ["init", "-b", "main"]);
}

async function commit(repoDir: string, subject: string): Promise<void> {
  await git(repoDir, [
    "-c",
    "user.name=Fixture Author",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    subject,
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("captureConventions", () => {
  it("captures includes, pointers, nested instructions, ownership, templates, and formatting from the demo fixture", async () => {
    const root = await temporaryRepository();
    const repoDir = await makeGitFixture(
      root,
      join(repositoryRoot, "harness/fixtures/demo-app"),
      "demo-app",
    );
    const conventions = await captureConventions({
      repoDir,
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
    expect(conventions.warnings).toEqual([]);
  });

  it("captures the pointer convention and nested instructions without inventing a formatter in the LangGraph fixture", async () => {
    const root = await temporaryRepository();
    const repoDir = await makeGitFixture(
      root,
      join(repositoryRoot, "harness/fixtures/langgraph-app"),
      "langgraph-app",
    );
    const conventions = await captureConventions({
      repoDir,
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
    expect(conventions.warnings).toEqual([]);
  });

  it("infers commit and branch conventions from the repository being captured", async () => {
    const repoDir = await temporaryRepository();
    await initializeGitRepository(repoDir);
    await commit(repoDir, "feat: add fixture");
    await commit(repoDir, "fix: adjust fixture");
    await commit(repoDir, "Document fixture behavior");
    await git(repoDir, ["branch", "feature/first"]);
    await git(repoDir, ["branch", "feature/second"]);
    await git(repoDir, ["branch", "maintenance/first"]);
    await git(repoDir, ["branch", "maintenance/second"]);

    const conventions = await captureConventions({ repoDir });

    expect(conventions.commitConvention).toEqual({
      style: "conventional",
      inferredFrom: [
        "Document fixture behavior",
        "fix: adjust fixture",
        "feat: add fixture",
      ],
    });
    expect(conventions.branchPrefix).toBe("feature/");
  });

  it("captures tracked nested AGENTS.md files without walking untracked directories", async () => {
    const repoDir = await temporaryRepository();
    await initializeGitRepository(repoDir);
    await mkdir(join(repoDir, "src"));
    await mkdir(join(repoDir, "build"));
    await writeFile(
      join(repoDir, "src", "AGENTS.md"),
      "Tracked instructions\n",
    );
    await writeFile(
      join(repoDir, "build", "AGENTS.md"),
      "Untracked instructions\n",
    );
    await git(repoDir, ["add", "src/AGENTS.md"]);

    const conventions = await captureConventions({ repoDir });

    expect(conventions.instructionFiles.map(({ path }) => path)).toEqual([
      "src/AGENTS.md",
    ]);
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

  it("does not treat a bare non-markdown @mention as an include", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(join(repoDir, "AGENTS.md"), "@elm-os/platform\n");

    const conventions = await captureConventions({ repoDir });

    expect(conventions.instructionFiles.map(({ path }) => path)).toEqual([
      "AGENTS.md",
    ]);
    expect(conventions.warnings).toEqual([]);
  });

  it("follows instruction includes to a maximum depth of one", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(join(repoDir, "AGENTS.md"), "@B.md\n");
    await writeFile(join(repoDir, "B.md"), "@C.md\n");
    await writeFile(join(repoDir, "C.md"), "Third-level instructions\n");

    const conventions = await captureConventions({ repoDir });

    expect(conventions.instructionFiles.map(({ path }) => path)).toEqual([
      "AGENTS.md",
      "B.md",
    ]);
    expect(conventions.warnings).toEqual([]);
  });
});
