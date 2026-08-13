import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMatcherRegistry, scan } from "@rightmodeler/scanner";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSwapDiff,
  type SwapDiffFile,
  type SwapDiffResult,
} from "./diff.js";

const fixture = fileURLToPath(
  new URL("../../../../fixtures/diff-cases", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rightmodeler-diff-"));
  temporaryDirectories.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}

function successful(result: SwapDiffResult | undefined): SwapDiffFile {
  expect(result).toBeDefined();
  expect(result).not.toHaveProperty("reason");
  return result as SwapDiffFile;
}

describe("buildSwapDiff", () => {
  it.each([
    ["src/string.ts", "js-ai-sdk-generate-text"],
    ["src/string.py", "py-openai-chat-completions"],
    ["config/models.yaml", "cfg-litellm-yaml"],
  ])("replaces only the model value in %s", async (path, matcherSlug) => {
    const root = await copyFixture();
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      (record) =>
        record.callSite.path === path &&
        record.callSite.matcherSlug === matcherSlug,
    )!;

    const file = successful(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      })[0],
    );

    expect(file.after).toBe(
      file.before.replace("acme/large-1", "acme/small-1"),
    );
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.replacements).toEqual([
      { from: "acme/large-1", to: "acme/small-1" },
    ]);
  });

  it.each([
    [
      "src/constant.ts",
      'SUMMARY_MODEL = "acme/small-1"',
      "model: SUMMARY_MODEL",
    ],
    ["src/constant.py", 'SUMMARY_LLM = "acme/small-1"', "model=SUMMARY_LLM"],
  ])(
    "replaces a model constant assignment instead of its call-site reference in %s",
    async (path, assignment, reference) => {
      const root = await copyFixture();
      const stepRecord = scan(root, createMatcherRegistry(), "project").find(
        ({ callSite }) => callSite.path === path,
      )!;

      const file = successful(
        buildSwapDiff({
          repoDir: root,
          projectId: "project",
          swaps: [
            { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
          ],
        })[0],
      );

      expect(file.after).toContain(assignment);
      expect(file.after).toContain(reference);
      expect(file.hunks[0]?.line).toBe(1);
    },
  );

  it("freshly relocates a fingerprint and never uses the stored line", async () => {
    const root = await copyFixture();
    const original = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/string.ts",
    )!;
    const path = join(root, "src/string.ts");
    await writeFile(path, `// inserted later\n${await readFile(path, "utf8")}`);
    const stepRecord = {
      ...original,
      callSite: { ...original.callSite, line: 999 },
    };

    const file = successful(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      })[0],
    );

    expect(file.after).toContain("// inserted later");
    expect(file.hunks[0]?.line).toBe(3);
  });

  it("threads the project id into fresh fingerprint matching", async () => {
    const root = await copyFixture();
    const projectId = "acme-repo";
    const stepRecord = scan(root, createMatcherRegistry(), projectId).find(
      ({ callSite }) => callSite.path === "src/string.ts",
    )!;

    const file = successful(
      buildSwapDiff({
        repoDir: root,
        projectId,
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      })[0],
    );

    expect(file.after).toContain('model: "acme/small-1"');
  });

  it("returns the named stale-location failure when the fingerprint diverges", async () => {
    const root = await copyFixture();
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/stale.ts",
    )!;
    const path = join(root, "src/stale.ts");
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace("staleExample", "changedExample"));

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/stale.ts", reason: "stale_location" }]);
  });

  it("does not turn a model mention in a comment into a diff", async () => {
    const root = await copyFixture();
    const records = scan(root, createMatcherRegistry(), "project");

    expect(
      records.some(({ callSite }) => callSite.path === "src/notes.ts"),
    ).toBe(false);
  });

  it.each([
    [
      'generateText({ prompt: \'Use model: "acme/large-1"\', model: "acme/current" })',
    ],
    [
      'generateText({ /* model: "acme/large-1" */ model: "acme/current", prompt })',
    ],
  ])("fails closed on model-shaped text outside code", async (call) => {
    const root = await copyFixture();
    const path = join(root, "src/red-herring.ts");
    await writeFile(
      path,
      `export function redHerring(prompt: string) { return ${call}; }\n`,
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/red-herring.ts",
    )!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/red-herring.ts", reason: "stale_location" }]);
  });

  it.each([
    [
      'generateText({ metadata: { model: "acme/large-1" }, model: "acme/current", prompt })',
    ],
    [
      'generateText({ pattern: /model: "acme\\/large-1"/, model: "acme/current", prompt })',
    ],
  ])("fails closed on a nested or regex model red herring", async (call) => {
    const root = await copyFixture();
    const path = join(root, "src/structured-red-herring.ts");
    await writeFile(
      path,
      `export function redHerring(prompt: string) { return ${call}; }\n`,
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/structured-red-herring.ts",
    )!;
    expect(stepRecord.currentModel).not.toBeNull();

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          {
            stepRecord,
            fromModel: stepRecord.currentModel!,
            toModel: "acme/small-1",
          },
        ],
      }),
    ).toEqual([
      { path: "src/structured-red-herring.ts", reason: "stale_location" },
    ]);
  });

  it("fails closed when two matching callees share one line", async () => {
    const root = await copyFixture();
    const path = join(root, "src/same-line.ts");
    await writeFile(
      path,
      'export function calls(prompt: string, messages: string[]) { generateText({ model: "acme/large-1", prompt }); return generateText({ model: "acme/large-1", messages }); }\n',
    );
    const records = scan(root, createMatcherRegistry(), "project").filter(
      ({ callSite }) => callSite.path === "src/same-line.ts",
    );
    expect(records).toHaveLength(2);
    const stepRecord = records[1]!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/same-line.ts", reason: "stale_location" }]);
  });

  it("supports a quoted model key", async () => {
    const root = await copyFixture();
    const path = join(root, "src/quoted-key.ts");
    await writeFile(
      path,
      'export function quoted(prompt: string) { return generateText({ "model": "acme/large-1", prompt }); }\n',
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/quoted-key.ts",
    )!;

    const file = successful(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      })[0],
    );
    expect(file.after).toContain('"model": "acme/small-1"');
  });

  it("rejects a target that cannot remain one model token", async () => {
    const root = await copyFixture();
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/string.ts",
    )!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: 'bad" model' },
        ],
      }),
    ).toEqual([{ path: "src/string.ts", reason: "stale_location" }]);
  });

  it("resolves a camel-case model constant", async () => {
    const root = await copyFixture();
    const path = join(root, "src/camel-constant.ts");
    await writeFile(
      path,
      'const summaryModel = "acme/large-1";\nexport function camel(prompt: string) { return generateText({ model: summaryModel, prompt }); }\n',
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/camel-constant.ts",
    )!;

    const file = successful(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      })[0],
    );
    expect(file.after).toContain('summaryModel = "acme/small-1"');
  });

  it.each([
    [
      "src/typed-constant.ts",
      'const DEPLOYMENT: string = "acme/large-1";\nexport function typed(prompt: string) { return generateText({ model: DEPLOYMENT, prompt }); }\n',
      'DEPLOYMENT: string = "acme/small-1"',
    ],
    [
      "src/typed-constant.py",
      'DEPLOYMENT: str = "acme/large-1"\n\ndef typed(prompt: str):\n    return client.chat.completions.create(model=DEPLOYMENT, messages=[prompt])\n',
      'DEPLOYMENT: str = "acme/small-1"',
    ],
  ])(
    "resolves a typed constant with an arbitrary name in %s",
    async (path, source, expected) => {
      const root = await copyFixture();
      await writeFile(join(root, path), source);
      const stepRecord = scan(root, createMatcherRegistry(), "project").find(
        ({ callSite }) => callSite.path === path,
      )!;

      const file = successful(
        buildSwapDiff({
          repoDir: root,
          projectId: "project",
          swaps: [
            { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
          ],
        })[0],
      );
      expect(file.after).toContain(expected);
    },
  );

  it("fails closed when a constant reference is shadowed", async () => {
    const root = await copyFixture();
    const path = join(root, "src/shadowed.ts");
    await writeFile(
      path,
      'const summaryModel = "acme/large-1";\nexport function shadow(prompt: string) { const summaryModel = "acme/current"; return generateText({ model: summaryModel, prompt }); }\n',
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/shadowed.ts",
    )!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/shadowed.ts", reason: "stale_location" }]);
  });

  it("fails closed when a parameter shadows a constant", async () => {
    const root = await copyFixture();
    const path = join(root, "src/parameter-shadow.ts");
    await writeFile(
      path,
      'const summaryModel = "acme/large-1";\nexport function shadow(summaryModel: string, prompt: string) { return generateText({ model: summaryModel, prompt }); }\n',
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/parameter-shadow.ts",
    )!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/parameter-shadow.ts", reason: "stale_location" }]);
  });

  it("fails closed when a constant is shared by an unswapped call", async () => {
    const root = await copyFixture();
    const path = join(root, "src/shared-constant.ts");
    await writeFile(
      path,
      'const MODEL = "acme/large-1";\nexport function first(prompt: string) { return generateText({ model: MODEL, prompt }); }\nexport function second(prompt: string) { return generateText({ model: MODEL, prompt }); }\n',
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/shared-constant.ts",
    )!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/shared-constant.ts", reason: "stale_location" }]);
  });

  it("fails closed on a constant declared in another lexical scope", async () => {
    const root = await copyFixture();
    const path = join(root, "src/wrong-scope.ts");
    await writeFile(
      path,
      'function owner() { const MODEL = "acme/large-1"; return MODEL; }\nexport function caller(prompt: string) { return generateText({ model: MODEL, prompt }); }\n',
    );
    const stepRecord = scan(root, createMatcherRegistry(), "project").find(
      ({ callSite }) => callSite.path === "src/wrong-scope.ts",
    )!;

    expect(
      buildSwapDiff({
        repoDir: root,
        projectId: "project",
        swaps: [
          { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
        ],
      }),
    ).toEqual([{ path: "src/wrong-scope.ts", reason: "stale_location" }]);
  });

  it.each([
    ['let activeModel = "acme/large-1";'],
    ['/* const activeModel = "acme/large-1"; */'],
  ])(
    "does not rewrite a mutable or commented assignment",
    async (assignment) => {
      const root = await copyFixture();
      const path = join(root, "src/not-constant.ts");
      await writeFile(
        path,
        `${assignment}\nexport function notConstant(prompt: string) { return generateText({ model: activeModel, prompt }); }\n`,
      );
      const stepRecord = scan(root, createMatcherRegistry(), "project").find(
        ({ callSite }) => callSite.path === "src/not-constant.ts",
      )!;

      expect(
        buildSwapDiff({
          repoDir: root,
          projectId: "project",
          swaps: [
            { stepRecord, fromModel: "acme/large-1", toModel: "acme/small-1" },
          ],
        }),
      ).toEqual([{ path: "src/not-constant.ts", reason: "stale_location" }]);
    },
  );
});
