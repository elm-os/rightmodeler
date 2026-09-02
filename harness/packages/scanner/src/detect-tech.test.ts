import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectTech } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("detectTech", () => {
  it("does not read manifests under ignored directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-detect-ignore-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "vendor/sdk"), { recursive: true });
    await Promise.all([
      writeFile(
        join(root, "vendor/sdk/package.json"),
        '{"dependencies":{"openai":"1"}}',
      ),
      writeFile(join(root, "package.json"), "{}"),
    ]);

    expect(detectTech(root)).toEqual({
      aiDependencies: [],
      languages: ["javascript"],
    });
  });

  it("skips a package.json it cannot parse and reads one with a byte order mark", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-detect-parse-"));
    temporaryDirectories.push(root);
    await Promise.all([mkdir(join(root, "a")), mkdir(join(root, "b"))]);
    await Promise.all([
      writeFile(
        join(root, "a/package.json"),
        '\uFEFF{"dependencies":{"openai":"1"}}',
      ),
      writeFile(join(root, "b/package.json"), "// generated\n{}"),
    ]);

    expect(detectTech(root).aiDependencies).toEqual([
      {
        language: "javascript",
        name: "openai",
        manifestPath: "a/package.json",
      },
    ]);
  });

  it("ignores prose outside the dependency tables of pyproject.toml", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-detect-prose-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\nname = "myapp"\ndescription = "Chat with openai, anthropic and more"\ndependencies = ["httpx>=0.27"]\n',
    );

    expect(detectTech(root)).toEqual({
      aiDependencies: [],
      languages: ["python"],
    });
  });

  it("reads project dependency arrays, optional dependencies and poetry tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-detect-tables-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "pyproject.toml"),
      '[project]\ndependencies = [\n  "openai[realtime]>=1.0",\n  "langchain-openai>=0.3",\n]\n\n[project.optional-dependencies]\neval = ["anthropic"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nlitellm = { version = "^1.0" }\n',
    );

    expect(detectTech(root).aiDependencies.map(({ name }) => name)).toEqual([
      "anthropic",
      "langchain",
      "litellm",
      "openai",
    ]);
  });

  it("takes the leading token of each requirements.txt line", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rightmodeler-detect-requirements-"),
    );
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "requirements.txt"),
      '-r base.txt\n--index-url https://example.test/simple\n# openai in a comment\nopenai[realtime]>=1.0  # pinned\nlitellm==1.2\nhttpx>=0.27; extra == "anthropic"\n',
    );

    expect(detectTech(root).aiDependencies.map(({ name }) => name)).toEqual([
      "litellm",
      "openai",
    ]);
  });

  it("canonicalizes framework distribution names", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rightmodeler-detect-frameworks-"),
    );
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "requirements.txt"),
      "crewai-tools>=1\nautogen-ext[openai]>=0.4\nlangchain_openai>=0.3\n",
    );

    expect(detectTech(root).aiDependencies.map(({ name }) => name)).toEqual([
      "autogen",
      "crewai",
      "langchain",
    ]);
  });
});
