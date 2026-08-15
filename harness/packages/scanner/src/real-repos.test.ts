import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMatcherRegistry,
  detectTech,
  evaluateCoverage,
  scan,
} from "./index.js";

const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/real-repos", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fileUniverse(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  await visit(root);
  return files.sort();
}

const fixtures = [
  {
    name: "vercel-ai-chatbot",
    expected: [
      ["app/actions.ts", "js-ai-sdk-generate-text"],
      ["app/api/chat/route.ts", "js-ai-sdk-stream-text"],
      ["lib/ai/tools/weather.ts", "js-vercel-ai-tool-call"],
    ],
    redHerrings: ["tests/chat.mock.ts"],
    coverage: true,
  },
  {
    name: "langgraph-swarm-py",
    expected: [
      ["src/agents.py", "py-langchain-chat-model"],
      ["src/workflow.py", "py-langgraph-node"],
    ],
    redHerrings: ["tests/test_mocks.py"],
    coverage: true,
  },
  {
    name: "openai-go",
    expected: [["cmd/chat/main.go", "go-openai-chat"]],
    redHerrings: ["internal/chat_mock.go"],
    coverage: false,
  },
] as const;

describe("representative open-source repository scans", () => {
  for (const fixture of fixtures) {
    it(`finds every ${fixture.name} call site without red-herring matches`, async () => {
      const root = join(fixtureRoot, fixture.name);
      const records = scan(root, createMatcherRegistry(), fixture.name);
      const found = records.map(({ callSite }) => [
        callSite.path,
        callSite.matcherSlug,
      ]);

      expect(found).toEqual(fixture.expected);
      expect(records).toHaveLength(fixture.expected.length);
      expect(
        records.filter(({ callSite }) =>
          fixture.redHerrings.some((path) => path === callSite.path),
        ),
      ).toEqual([]);

      if (fixture.coverage) {
        const detectedTech = detectTech(root);
        expect(detectedTech.aiDependencies.length).toBeGreaterThan(0);
        expect(
          evaluateCoverage({
            stepRecords: records,
            fileUniverse: await fileUniverse(root),
            detectedTech,
          }),
        ).toEqual({ pass: true, failures: [] });
      }
    });
  }

  it("keeps a new matcher identity stable when lines move", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-real-repo-"));
    temporaryDirectories.push(root);
    await cp(join(fixtureRoot, "vercel-ai-chatbot"), root, {
      recursive: true,
    });
    const registry = createMatcherRegistry();
    const before = scan(root, registry, "identity-project").find(
      ({ callSite }) => callSite.matcherSlug === "js-vercel-ai-tool-call",
    )!;
    const filePath = join(root, "lib/ai/tools/weather.ts");
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, `\n${content}`);
    const after = scan(root, registry, "identity-project").find(
      ({ callSite }) => callSite.matcherSlug === "js-vercel-ai-tool-call",
    )!;

    expect(after.callSite.line).toBe(before.callSite.line + 1);
    expect(after.stepId).toBe(before.stepId);
  });
});
