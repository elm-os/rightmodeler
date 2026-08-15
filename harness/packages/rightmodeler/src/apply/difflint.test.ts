import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterEach, describe, expect, it } from "vitest";

import { buildSwapDiff, type SwapDiffFile } from "./diff.js";
import { lintSwapDiff } from "./difflint.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/diff-cases", import.meta.url),
);
const temporaryDirectories: string[] = [];
const allowedModels = {
  from: ["acme/large-1"],
  to: ["acme/small-1"],
};

function lint({
  files,
  allowedModels: models = allowedModels,
}: {
  readonly files: readonly {
    readonly path: string;
    readonly before: string;
    readonly after: string;
  }[];
  readonly allowedModels?: {
    readonly from: readonly string[];
    readonly to: readonly string[];
  };
}) {
  const replacements = models.from.map((from, index) => ({
    from,
    to: models.to[index] ?? "",
  }));
  return lintSwapDiff({
    files: files.map((file) => ({ ...file, replacements })),
  });
}

function lintFiles(
  files: readonly {
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly replacements: readonly {
      readonly from: string;
      readonly to: string;
    }[];
  }[],
) {
  return lintSwapDiff({ files });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function greenFixtureDiffs(): Promise<SwapDiffFile[]> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-difflint-"));
  temporaryDirectories.push(root);
  await cp(fixture, root, { recursive: true });
  const records = scan(root, createMatcherRegistry(), "project").filter(
    ({ callSite }) =>
      [
        "src/string.ts",
        "src/string.py",
        "config/models.yaml",
        "src/constant.ts",
        "src/constant.py",
      ].includes(callSite.path),
  );
  const results = buildSwapDiff({
    repoDir: root,
    projectId: "project",
    swaps: records.map((stepRecord) => ({
      stepRecord,
      fromModel: "acme/large-1",
      toModel: "acme/small-1",
    })),
  });
  expect(results.every((result) => !("reason" in result))).toBe(true);
  return results as SwapDiffFile[];
}

describe("lintSwapDiff", () => {
  it("accepts every fixture form and applying its hunks is idempotent", async () => {
    const files = await greenFixtureDiffs();

    for (const file of files) {
      let applied = file.before;
      for (const hunk of file.hunks) {
        applied = applied.replace(hunk.before, hunk.after);
      }
      expect(applied).toBe(file.after);
      let appliedTwice = applied;
      for (const hunk of file.hunks) {
        appliedTwice = appliedTwice.replace(hunk.before, hunk.after);
      }
      expect(appliedTwice).toBe(applied);
      expect(lint({ files: [file], allowedModels })).toEqual({
        pass: true,
        violations: [],
      });
      expect(
        lint({
          files: [{ ...file, before: file.before, after: appliedTwice }],
          allowedModels,
        }),
      ).toEqual({ pass: true, violations: [] });
    }
  });

  it("rejects an added import beside an otherwise valid swap", async () => {
    const [file] = (await greenFixtureDiffs()).filter(
      ({ path }) => path === "src/string.ts",
    );
    const result = lint({
      files: [
        { ...file!, after: `import { track } from "./track";\n${file!.after}` },
      ],
      allowedModels,
    });

    expect(result).toEqual({
      pass: false,
      violations: [
        { path: "src/string.ts", line: 1, kind: "non_model_change" },
      ],
    });
  });

  it("aligns multiple inserted lines and reports their precise positions", async () => {
    const [file] = (await greenFixtureDiffs()).filter(
      ({ path }) => path === "src/string.ts",
    );
    const result = lint({
      files: [
        {
          ...file!,
          after: `import { first } from "./first";\nimport { second } from "./second";\n${file!.after}`,
        },
      ],
      allowedModels,
    });

    expect(result).toEqual({
      pass: false,
      violations: [
        { path: "src/string.ts", line: 1, kind: "non_model_change" },
        { path: "src/string.ts", line: 2, kind: "non_model_change" },
      ],
    });
  });

  it("rejects a comment edit with its actual line", () => {
    const result = lint({
      files: [
        {
          path: "src/comment.ts",
          before:
            'const owner = "platform";\n\n// keep this comment\nconst MODEL_ID = "acme/large-1";\n',
          after:
            'const owner = "platform";\n\n// changed comment\nconst MODEL_ID = "acme/small-1";\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toContainEqual({
      path: "src/comment.ts",
      line: 3,
      kind: "comment_change",
    });
  });

  it("rejects a model-shaped edit inside a multiline comment", () => {
    const result = lint({
      files: [
        {
          path: "src/comment.ts",
          before: '/*\nmodel: "acme/large-1"\n*/\n',
          after: '/*\nmodel: "acme/small-1"\n*/\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/comment.ts", line: 2, kind: "comment_change" },
    ]);
  });

  it.each([
    [
      'const pattern = /model: "acme\\/large-1"/;',
      'const pattern = /model: "acme\\/small-1"/;',
    ],
    ['return /model: "acme\\/large-1"/;', 'return /model: "acme\\/small-1"/;'],
  ])(
    "rejects a model-shaped edit inside a regular expression",
    (before, after) => {
      const result = lint({
        files: [
          {
            path: "src/pattern.ts",
            before: `${before}\n`,
            after: `${after}\n`,
          },
        ],
        allowedModels,
      });

      expect(result.violations).toEqual([
        { path: "src/pattern.ts", line: 1, kind: "non_model_change" },
      ]);
    },
  );

  it("rejects whitespace drift on an untouched line", () => {
    const result = lint({
      files: [
        {
          path: "src/space.ts",
          before:
            'const metadata = { owner: "platform" };\nconst MODEL_ID = "acme/large-1";\n',
          after:
            'const metadata={ owner: "platform" };\nconst MODEL_ID = "acme/small-1";\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toContainEqual({
      path: "src/space.ts",
      line: 1,
      kind: "whitespace_change",
    });
  });

  it("rejects whitespace rewritten inside a neighboring string", () => {
    const result = lint({
      files: [
        {
          path: "src/prompt.ts",
          before: 'x(" a  b ", { model: "acme/large-1" });\n',
          after: 'x("ab", { model: "acme/small-1" });\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/prompt.ts", line: 1, kind: "non_model_change" },
    ]);
  });

  it("rejects reformatting the swapped line", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: 'return generateText({ model: "acme/large-1", prompt });\n',
          after: 'return generateText({model:"acme/small-1",prompt});\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/model.ts", line: 1, kind: "whitespace_change" },
    ]);
  });

  it("rejects re-indenting the swapped Python line", () => {
    const result = lint({
      files: [
        {
          path: "src/model.py",
          before:
            '    return client.chat.completions.create(model="acme/large-1", messages=[prompt])\n',
          after:
            '  return client.chat.completions.create(model="acme/small-1", messages=[prompt])\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/model.py", line: 1, kind: "whitespace_change" },
    ]);
  });

  it("rejects re-indenting a swapped YAML entry", () => {
    const result = lint({
      files: [
        {
          path: "config/models.yaml",
          before: "service:\n  model: acme/large-1\n",
          after: "service:\n    model: acme/small-1\n",
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "config/models.yaml", line: 2, kind: "whitespace_change" },
    ]);
  });

  it("rejects a changed file with no swapped step", () => {
    const result = lintFiles([
      {
        path: "docs/example.ts",
        before: 'const MODEL = "acme/large-1";\n',
        after: 'const MODEL = "acme/small-1";\n',
        replacements: [],
      },
    ]);

    expect(result.violations).toEqual([
      { path: "docs/example.ts", line: 1, kind: "unswapped_file" },
    ]);
  });

  it("rejects an unswapped file even when its model pair is authorized elsewhere", () => {
    const result = lintFiles([
      {
        path: "src/real.ts",
        before: 'const MODEL = "acme/large-1";\n',
        after: 'const MODEL = "acme/small-1";\n',
        replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
      },
      {
        path: "docs/example.ts",
        before: 'const MODEL = "acme/large-1";\n',
        after: 'const MODEL = "acme/small-1";\n',
        replacements: [],
      },
    ]);

    expect(result.violations).toEqual([
      { path: "docs/example.ts", line: 1, kind: "unswapped_file" },
    ]);
  });

  it("does not let one file consume another file's replacement budget", () => {
    const result = lintFiles([
      {
        path: "src/bogus.ts",
        before: 'const MODEL = "acme/large-1";\n',
        after: 'const MODEL = "acme/small-1";\n',
        replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
      },
      {
        path: "src/real.ts",
        before: 'const MODEL = "acme/large-1";\n',
        after: 'const MODEL = "acme/small-1";\n',
        replacements: [{ from: "acme/large-1", to: "acme/small-1" }],
      },
    ]);

    expect(result).toEqual({ pass: true, violations: [] });
  });

  it("rejects non-model prose with model words", () => {
    const result = lint({
      files: [
        {
          path: "src/notes.ts",
          before: "export const note = 'large model';\n",
          after: "export const note = 'small model';\n",
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/notes.ts", line: 1, kind: "disallowed_model" },
    ]);
  });

  it("rejects lockfile churn even when it resembles a model replacement", () => {
    const result = lint({
      files: [
        {
          path: "pnpm-lock.yaml",
          before: "MODEL_ID: acme/large-1\n",
          after: "MODEL_ID: acme/small-1\n",
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "pnpm-lock.yaml", line: 1, kind: "lockfile_change" },
    ]);
  });

  it("rejects a model outside the allowed sets", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: 'const MODEL_ID = "other/large";\n',
          after: 'const MODEL_ID = "acme/small-1";\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toContainEqual({
      path: "src/model.ts",
      line: 1,
      kind: "disallowed_model",
    });
  });

  it("requires corresponding allowed model pairs", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: 'const MODEL_ID = "acme/large-1";\n',
          after: 'const MODEL_ID = "acme/small-2";\n',
        },
      ],
      allowedModels: {
        from: ["acme/large-1", "acme/large-2"],
        to: ["acme/small-1", "acme/small-2"],
      },
    });

    expect(result.violations).toEqual([
      { path: "src/model.ts", line: 1, kind: "disallowed_model" },
    ]);
  });

  it("does not reuse one authorized pair for two replacements", () => {
    const result = lint({
      files: [
        {
          path: "src/models.ts",
          before:
            'const FIRST_MODEL = "acme/large-1";\nconst SECOND_MODEL = "acme/large-1";\n',
          after:
            'const FIRST_MODEL = "acme/small-1";\nconst SECOND_MODEL = "acme/small-1";\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/models.ts", line: 2, kind: "disallowed_model" },
    ]);
  });

  it("accepts a multiline model value and a quoted model key", () => {
    const result = lint({
      files: [
        {
          path: "src/multiline.ts",
          before:
            'generateText({\n  "model":\n    "acme/large-1",\n  prompt,\n});\n',
          after:
            'generateText({\n  "model":\n    "acme/small-1",\n  prompt,\n});\n',
        },
      ],
      allowedModels,
    });

    expect(result).toEqual({ pass: true, violations: [] });
  });

  it("allows a formatter-added trailing comma on the swapped line", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: '  model: "acme/large-1"\n',
          after: '  model: "acme/small-1",\n',
        },
      ],
      allowedModels,
    });

    expect(result).toEqual({ pass: true, violations: [] });
  });

  it.each([
    ['  model: "acme/large-1",\n', '  model: "acme/small-1"\n'],
    ['const MODEL = "acme/large-1";\n', 'const MODEL = "acme/small-1"\n'],
  ])("rejects removing trailing punctuation during a swap", (before, after) => {
    const result = lint({
      files: [{ path: "src/model.ts", before, after }],
    });

    expect(result.violations).toEqual([
      { path: "src/model.ts", line: 1, kind: "non_model_change" },
    ]);
  });

  it("rejects exchanging a statement semicolon for a comma", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: 'const MODEL = "acme/large-1";\n',
          after: 'const MODEL = "acme/small-1",\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/model.ts", line: 1, kind: "non_model_change" },
    ]);
  });

  it("accepts a typed constant whose name does not contain model", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: 'const DEPLOYMENT: string = "acme/large-1";\n',
          after: 'const DEPLOYMENT: string = "acme/small-1";\n',
        },
      ],
      allowedModels,
    });

    expect(result).toEqual({ pass: true, violations: [] });
  });

  it("aligns a large file without materializing a quadratic matrix", () => {
    const unchanged = Array.from(
      { length: 10_000 },
      (_, index) => `export const value${index} = ${index};`,
    );
    const before = [...unchanged, 'const MODEL_ID = "acme/large-1";'].join(
      "\n",
    );
    const after = [
      'import { track } from "./track";',
      ...unchanged,
      'const MODEL_ID = "acme/small-1";',
    ].join("\n");

    const result = lint({
      files: [{ path: "src/large.ts", before, after }],
      allowedModels,
    });

    expect(result.violations).toContainEqual({
      path: "src/large.ts",
      line: 1,
      kind: "non_model_change",
    });
  });

  it("does not treat a mutable assignment as a model constant", () => {
    const result = lint({
      files: [
        {
          path: "src/model.ts",
          before: 'let activeModel = "acme/large-1";\n',
          after: 'let activeModel = "acme/small-1";\n',
        },
      ],
      allowedModels,
    });

    expect(result.violations).toEqual([
      { path: "src/model.ts", line: 1, kind: "non_model_change" },
    ]);
  });
});
