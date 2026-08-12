import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMatcherRegistry, scan } from "./index.js";

const demoApp = fileURLToPath(
  new URL("../../../fixtures/demo-app", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scan", () => {
  it("finds every planted call site with its capability hints", () => {
    const records = scan(demoApp, createMatcherRegistry());

    expect(records.map(({ callSite }) => callSite.matcherSlug).sort()).toEqual([
      "cfg-litellm-yaml",
      "js-ai-sdk-generate-object",
      "js-ai-sdk-generate-text",
      "py-anthropic-messages",
      "py-openai-chat-completions",
    ]);
    expect(
      records.some(({ callSite }) => callSite.path === "src/model-notes.ts"),
    ).toBe(false);
    expect(
      Object.fromEntries(
        records.map((record) => [
          record.callSite.matcherSlug,
          record.capabilityRequirements,
        ]),
      ),
    ).toEqual({
      "cfg-litellm-yaml": [],
      "js-ai-sdk-generate-object": ["structured_output"],
      "js-ai-sdk-generate-text": [],
      "py-anthropic-messages": [],
      "py-openai-chat-completions": ["tools"],
    });
    expect(
      records.every(({ currentModel }) => currentModel === "acme/large-1"),
    ).toBe(true);

    const structured = records.find(
      ({ callSite }) => callSite.matcherSlug === "js-ai-sdk-generate-object",
    );
    const text = records.find(
      ({ callSite }) => callSite.matcherSlug === "js-ai-sdk-generate-text",
    );
    const tools = records.find(
      ({ callSite }) => callSite.matcherSlug === "py-openai-chat-completions",
    );
    expect(structured).toMatchObject({
      currentModel: "acme/large-1",
      capabilityRequirements: ["structured_output"],
      status: "pending",
    });
    expect(tools).toMatchObject({
      currentModel: "acme/large-1",
      capabilityRequirements: ["tools"],
      status: "pending",
    });
    expect(text?.callSite.line).toBe(4);
    expect(
      createMatcherRegistry()
        .getBySlug("js-ai-sdk-generate-text")!
        .match(
          'export async function summarize() { return generateText({ prompt, model: "acme/large-1", system: instructions }) }',
          "src/summarize.ts",
        )[0],
    ).toMatchObject({
      enclosingSymbolPath: "summarize",
      normalizedCallShape: {
        callee: "generateText",
        argumentKeys: ["model", "prompt", "system"],
        enclosing: "summarize",
      },
    });
  });

  it("keeps identity stable when a line is inserted above a call site", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rightmodeler-scanner-identity-"),
    );
    temporaryDirectories.push(root);
    await cp(demoApp, root, { recursive: true });
    const registry = createMatcherRegistry();
    const before = scan(root, registry).find(
      ({ callSite }) => callSite.matcherSlug === "js-ai-sdk-generate-text",
    )!;
    const filePath = join(root, "src/summarize.ts");
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, `\n${content}`);
    const after = scan(root, registry).find(
      ({ callSite }) => callSite.matcherSlug === "js-ai-sdk-generate-text",
    )!;

    expect(after.callSite.line).toBe(before.callSite.line + 1);
    expect(after.stepId).toBe(before.stepId);
  });
});
