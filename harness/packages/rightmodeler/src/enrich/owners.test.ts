import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveOwners } from "./owners.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

async function temporaryRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rightmodeler-owners-"));
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

describe("resolveOwners", () => {
  it("uses the last matching CODEOWNERS rule and preserves team, user, and email owners", async () => {
    const repoDir = await temporaryRepository();
    await mkdir(join(repoDir, ".github"));
    await writeFile(
      join(repoDir, ".github", "CODEOWNERS"),
      [
        "* @fallback",
        "/src/** @elm-os/platform platform@example.com",
        "/src/private/* @private-owner @elm-os/private",
      ].join("\n"),
    );
    await writeFile(join(repoDir, "CODEOWNERS"), "* @ignored\n");

    await expect(
      resolveOwners({
        repoDir,
        filePaths: ["src/public.ts", "src/private/key.ts"],
      }),
    ).resolves.toEqual([
      {
        path: "src/public.ts",
        owners: [
          { handle: "@elm-os/platform", source: "codeowners" },
          { handle: "platform@example.com", source: "codeowners" },
        ],
      },
      {
        path: "src/private/key.ts",
        owners: [
          { handle: "@private-owner", source: "codeowners" },
          { handle: "@elm-os/private", source: "codeowners" },
        ],
      },
    ]);
  });

  it("returns a named reason when neither CODEOWNERS nor blame resolves an owner", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(join(repoDir, "CODEOWNERS"), "/src/** @source-owner\n");

    await expect(
      resolveOwners({ repoDir, filePaths: ["docs/guide.md"] }),
    ).resolves.toEqual([
      {
        path: "docs/guide.md",
        owners: [],
        reason: "no_codeowners_match_or_blame",
      },
    ]);
  });

  it("matches basename, anchored, direct-child, directory, and double-star patterns", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(
      join(repoDir, "CODEOWNERS"),
      [
        "*.md @markdown-owner",
        "/root/** @root-owner",
        "docs/* @direct-docs-owner",
        "apps/ @apps-owner",
        "/apps/github @github-owner",
        "**/logs @logs-owner",
        "*.rb @ruby-owner",
        "***/*.rb @invalid-owner",
      ].join("\n"),
    );

    const resolutions = await resolveOwners({
      repoDir,
      filePaths: [
        "nested/guide.md",
        "root/file.ts",
        "docs/top.ts",
        "docs/nested/deep.ts",
        "packages/apps/index.ts",
        "apps/github/workflow.ts",
        "services/logs/output.txt",
        "lib/task.rb",
      ],
    });

    expect(resolutions).toEqual([
      {
        path: "nested/guide.md",
        owners: [{ handle: "@markdown-owner", source: "codeowners" }],
      },
      {
        path: "root/file.ts",
        owners: [{ handle: "@root-owner", source: "codeowners" }],
      },
      {
        path: "docs/top.ts",
        owners: [{ handle: "@direct-docs-owner", source: "codeowners" }],
      },
      {
        path: "docs/nested/deep.ts",
        owners: [],
        reason: "no_codeowners_match_or_blame",
      },
      {
        path: "packages/apps/index.ts",
        owners: [{ handle: "@apps-owner", source: "codeowners" }],
      },
      {
        path: "apps/github/workflow.ts",
        owners: [{ handle: "@github-owner", source: "codeowners" }],
      },
      {
        path: "services/logs/output.txt",
        owners: [{ handle: "@logs-owner", source: "codeowners" }],
      },
      {
        path: "lib/task.rb",
        owners: [{ handle: "@ruby-owner", source: "codeowners" }],
      },
    ]);
  });

  it("falls back to ranked git blame authors for a committed file", async () => {
    const [resolution] = await resolveOwners({
      repoDir: repositoryRoot,
      filePaths: ["harness/docs/Architecture.md"],
    });

    expect(resolution).toEqual({
      path: "harness/docs/Architecture.md",
      owners: [
        {
          handle: "aharish4@asu.edu",
          source: "blame",
        },
      ],
    });
  });
});
