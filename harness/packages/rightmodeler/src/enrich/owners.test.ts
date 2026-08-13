import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveOwners } from "./owners.js";

const execFileAsync = promisify(execFile);
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

async function git(repoDir: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", repoDir, ...args]);
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

  it("lets a later CODEOWNERS rule without owners clear an earlier owner", async () => {
    const repoDir = await temporaryRepository();
    await writeFile(
      join(repoDir, "CODEOWNERS"),
      ["/apps/ @octocat", "/apps/github"].join("\n"),
    );

    await expect(
      resolveOwners({ repoDir, filePaths: ["apps/github/client.ts"] }),
    ).resolves.toEqual([
      {
        path: "apps/github/client.ts",
        owners: [],
        reason: "codeowners_rule_without_owners",
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

    expect(resolution?.path).toBe("harness/docs/Architecture.md");
    expect(resolution?.owners.length).toBeGreaterThan(0);
    expect(resolution?.owners.every(({ source }) => source === "blame")).toBe(
      true,
    );
  });

  it("bounds concurrent blame commands and memoizes repeated paths", async () => {
    const repoDir = await temporaryRepository();
    await git(repoDir, ["init", "-b", "main"]);
    await mkdir(join(repoDir, "src"));
    const paths = Array.from({ length: 6 }, (_, index) => `src/${index}.ts`);
    await Promise.all(
      paths.map((path, index) =>
        writeFile(join(repoDir, path), `export const value = ${index};\n`),
      ),
    );
    await git(repoDir, ["add", "--", "src"]);
    await git(repoDir, [
      "-c",
      "user.name=Fixture Author",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "Add fixtures",
    ]);
    const tracePath = join(repoDir, "trace.json");
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = tracePath;

    try {
      await resolveOwners({ repoDir, filePaths: [...paths, paths[0]!] });
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previousTrace;
    }

    const events = (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            time: string;
          },
      )
      .filter(({ event }) => event === "start" || event === "exit")
      .sort((left, right) => left.time.localeCompare(right.time));
    expect(events.filter(({ event }) => event === "start")).toHaveLength(6);

    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
      active += event.event === "start" ? 1 : -1;
      maximumActive = Math.max(maximumActive, active);
    }
    expect(maximumActive).toBeLessThanOrEqual(4);
  });
});
