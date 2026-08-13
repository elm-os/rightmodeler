import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterEach, describe, expect, it } from "vitest";

import { buildSwapDiff, type SwapDiffFile } from "./diff.js";
import { formatWithHostFormatter } from "./format.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/diff-cases", import.meta.url),
);
const monorepoNodeModules = fileURLToPath(
  new URL("../../../../../node_modules", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureDiff(path: string): Promise<{
  root: string;
  file: SwapDiffFile;
}> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-format-"));
  temporaryDirectories.push(root);
  await cp(fixture, root, { recursive: true });
  await symlink(monorepoNodeModules, join(root, "node_modules"), "dir");
  const stepRecord = scan(root, createMatcherRegistry(), "project").find(
    ({ callSite }) => callSite.path === path,
  )!;
  const [result] = buildSwapDiff({
    repoDir: root,
    projectId: "project",
    swaps: [{ stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" }],
  });
  expect(result).not.toHaveProperty("reason");
  return { root, file: result as SwapDiffFile };
}

describe("formatWithHostFormatter", () => {
  it("returns files unchanged with a note when no formatter is configured", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");

    await expect(
      formatWithHostFormatter({
        repoDir: root,
        conventions: { formatter: { kind: null, configPath: null } },
        files: [file],
      }),
    ).resolves.toEqual({ files: [file], note: "no_formatter" });
  });

  it("accepts the captured convention shape for no formatter", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");

    await expect(
      formatWithHostFormatter({
        repoDir: root,
        conventions: { formatter: { kind: null, configPath: null } },
        files: [file],
      }),
    ).resolves.toEqual({ files: [file], note: "no_formatter" });
  });

  it("returns files unchanged when the configured formatter is absent", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");
    await unlink(join(root, "node_modules"));

    await expect(
      formatWithHostFormatter({
        repoDir: root,
        conventions: { formatter: { kind: "prettier", configPath: null } },
        files: [file],
      }),
    ).resolves.toEqual({ files: [file], note: "formatter_unavailable" });
  });

  it("pins the npx Prettier fallback to the host lockfile version", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");
    await unlink(join(root, "node_modules"));
    await writeFile(root + "/pnpm-lock.yaml", "  prettier@3.9.4:\n");
    const bin = join(root, "bin");
    const executable = join(bin, "npx");
    await mkdir(bin);
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] !== "--yes" || args[1] !== "--package=prettier@3.9.4" || args[2] !== "prettier" || args[3] !== "--stdin-filepath" || !args[4].endsWith("src/string.ts")) process.exit(2);\nprocess.stdin.pipe(process.stdout);\n',
    );
    await chmod(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      const result = await formatWithHostFormatter({
        repoDir: root,
        conventions: { formatter: { kind: "prettier", configPath: null } },
        files: [file],
      });
      expect(result).toEqual({ files: [file], note: "formatted" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("rejects a non-semver yarn.lock version before invoking npx", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");
    await unlink(join(root, "node_modules"));
    await writeFile(
      join(root, "yarn.lock"),
      'prettier@^3.0.0:\n  version "../../evil"\n',
    );
    const bin = join(root, "bin");
    const marker = join(root, "npx-invoked");
    const executable = join(bin, "npx");
    await mkdir(bin);
    await writeFile(
      executable,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");\n`,
    );
    await chmod(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      await expect(
        formatWithHostFormatter({
          repoDir: root,
          conventions: {
            formatter: { kind: "prettier", configPath: null },
          },
          files: [file],
        }),
      ).resolves.toEqual({ files: [file], note: "formatter_unavailable" });
      await expect(readFile(marker)).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("uses a valid semver from yarn.lock for the npx fallback", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");
    await unlink(join(root, "node_modules"));
    await writeFile(
      join(root, "yarn.lock"),
      'prettier@^3.0.0:\n  version "3.9.4-alpha.1+build.2"\n',
    );
    const bin = join(root, "bin");
    const executable = join(bin, "npx");
    await mkdir(bin);
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[1] !== "--package=prettier@3.9.4-alpha.1+build.2") process.exit(2);\nprocess.stdin.pipe(process.stdout);\n',
    );
    await chmod(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      await expect(
        formatWithHostFormatter({
          repoDir: root,
          conventions: {
            formatter: { kind: "prettier", configPath: null },
          },
          files: [file],
        }),
      ).resolves.toEqual({ files: [file], note: "formatted" });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("passes a clean swap through the host repository's Prettier binary", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: {
        formatter: { kind: "prettier", configPath: ".prettierrc" },
      },
      files: [file],
    });

    expect(result.blocker).toBeUndefined();
    expect(result.note).toBe("formatted");
    expect(result.files[0]?.after).toBe(file.after);
  });

  it("allows formatter whitespace changes on the swapped line", async () => {
    const { root, file } = await fixtureDiff("src/string.ts");
    const after = file.after
      .replace(
        '{ model: "acme/small-1", prompt }',
        "{model: 'acme/small-1', prompt}",
      )
      .replace(
        "  return generateText({model: 'acme/small-1', prompt});",
        "  return generateText({model: 'acme/small-1', prompt})",
      );
    const candidate = {
      ...file,
      after,
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        after: hunk.after
          .replace(
            '{ model: "acme/small-1", prompt }',
            "{model: 'acme/small-1', prompt}",
          )
          .replace(
            "  return generateText({model: 'acme/small-1', prompt});",
            "  return generateText({model: 'acme/small-1', prompt})",
          ),
      })),
    };

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: { formatter: { kind: "prettier", configPath: null } },
      files: [candidate],
    });

    expect(result.blocker).toBeUndefined();
    expect(result.files[0]?.after).toBe(file.after);
    expect(result.files[0]?.hunks[0]?.after).toBe(file.hunks[0]?.after);
  });

  it("allows Prettier to add a trailing comma on the swapped line", async () => {
    const { root } = await fixtureDiff("src/string.ts");
    const before =
      'const result = generateText({\n  model: "acme/large-1"\n});\n';
    const after =
      'const result = generateText({\n  model: "acme/small-1"\n});\n';
    const file: SwapDiffFile = {
      path: "src/comma.ts",
      before,
      after,
      hunks: [
        {
          line: 2,
          before: '  model: "acme/large-1"',
          after: '  model: "acme/small-1"',
          replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
        },
      ],
    };

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: { formatter: { kind: "prettier", configPath: null } },
      files: [file],
    });

    expect(result.blocker).toBeUndefined();
    expect(result.files[0]?.after).toContain('model: "acme/small-1",');
  });

  it("uses the original relative path for Prettier overrides", async () => {
    const { root } = await fixtureDiff("src/string.ts");
    await writeFile(
      join(root, ".prettierrc"),
      JSON.stringify({
        overrides: [
          { files: "src/override.ts", options: { singleQuote: true } },
        ],
      }),
    );
    const before = 'const MODEL = "acme/large-1";\n';
    const after = 'const MODEL = "acme/small-1";\n';
    const file: SwapDiffFile = {
      path: "src/override.ts",
      before,
      after,
      hunks: [
        {
          line: 1,
          before: before.trimEnd(),
          after: after.trimEnd(),
          replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
        },
      ],
    };

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: { formatter: { kind: "prettier", configPath: null } },
      files: [file],
    });

    expect(result.blocker).toBeUndefined();
    expect(result.files[0]?.after).toBe("const MODEL = 'acme/small-1';\n");
  });

  it("blocks formatter drift outside the model token's line", async () => {
    const { root, file } = await fixtureDiff("src/misformatted.ts");

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: { formatter: { kind: "prettier", configPath: null } },
      files: [file],
    });

    expect(result.blocker).toEqual({
      path: "src/misformatted.ts",
      line: 1,
      reason: "formatter_conflict",
    });
    expect(result.files).toEqual([file]);
  });

  it("runs ruff format on only the temporary copy of a changed file", async () => {
    const { root, file } = await fixtureDiff("src/string.py");
    const executable = join(root, ".venv/bin/ruff");
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconst [kind, file] = process.argv.slice(2);\nif (kind !== "format" || !file.includes(".rightmodeler-format-") || !file.endsWith("string.py")) process.exit(2);\n',
    );
    await chmod(executable, 0o755);

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: { formatter: { kind: "ruff", configPath: null } },
      files: [file],
    });

    expect(result).toEqual({ files: [file], note: "formatted" });
  });

  it("returns a named blocker when the host formatter fails", async () => {
    const { root, file } = await fixtureDiff("src/string.py");
    const executable = join(root, ".venv/bin/ruff");
    await mkdir(join(root, ".venv/bin"), { recursive: true });
    await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(1);\n");
    await chmod(executable, 0o755);

    const result = await formatWithHostFormatter({
      repoDir: root,
      conventions: { formatter: { kind: "ruff", configPath: null } },
      files: [file],
    });

    expect(result).toEqual({
      files: [file],
      blocker: {
        path: "src/string.py",
        line: 1,
        reason: "formatter_failed",
      },
    });
  });

  it("blocks a formatter reformat of the swapped line", async () => {
    const first = await fixtureDiff("src/string.ts");
    const candidate: SwapDiffFile = {
      path: "src/first.ts",
      before: 'const MODEL="acme/large-1"\n',
      after: 'const MODEL="acme/small-1"\n',
      hunks: [
        {
          line: 1,
          before: 'const MODEL="acme/large-1"',
          after: 'const MODEL="acme/small-1"',
          replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
        },
      ],
    };

    const result = await formatWithHostFormatter({
      repoDir: first.root,
      conventions: {
        formatter: { kind: "prettier", configPath: null },
      },
      files: [candidate],
    });

    expect(result.files).toEqual([candidate]);
    expect(result.note).toBeUndefined();
    expect(result.blocker).toEqual({
      path: "src/first.ts",
      line: 1,
      reason: "formatter_conflict",
    });
  });

  it("runs gofmt with argv on only the temporary changed file", async () => {
    const { root } = await fixtureDiff("src/string.ts");
    const bin = join(root, "bin");
    const executable = join(bin, "gofmt");
    await mkdir(bin);
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconst [flag, file] = process.argv.slice(2);\nif (flag !== "-w" || !file.includes(".rightmodeler-format-") || !file.endsWith("model.go")) process.exit(2);\n',
    );
    await chmod(executable, 0o755);
    const before = 'package fixture\n\nconst MODEL_ID = "acme/large-1"\n';
    const after = 'package fixture\n\nconst MODEL_ID = "acme/small-1"\n';
    const file: SwapDiffFile = {
      path: "model.go",
      before,
      after,
      hunks: [
        {
          line: 3,
          before: 'const MODEL_ID = "acme/large-1"',
          after: 'const MODEL_ID = "acme/small-1"',
          replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
        },
      ],
    };
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      const result = await formatWithHostFormatter({
        repoDir: root,
        conventions: { formatter: { kind: "gofmt", configPath: null } },
        files: [file],
      });
      expect(result).toEqual({ files: [file], note: "formatted" });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
