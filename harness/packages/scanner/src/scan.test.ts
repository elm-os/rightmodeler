import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMatcherRegistry,
  scan,
  scanRepository,
  type CandidateMatch,
  type Matcher,
} from "./index.js";

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
    const records = scan(demoApp, createMatcherRegistry(), "demo-project");

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
          'import { generateText } from "ai";\nexport async function summarize() { return generateText({ prompt, model: "acme/large-1", system: instructions }) }',
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
    const before = scan(root, registry, "demo-project").find(
      ({ callSite }) => callSite.matcherSlug === "js-ai-sdk-generate-text",
    )!;
    const filePath = join(root, "src/summarize.ts");
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, `\n${content}`);
    const after = scan(root, registry, "demo-project").find(
      ({ callSite }) => callSite.matcherSlug === "js-ai-sdk-generate-text",
    )!;

    expect(after.callSite.line).toBe(before.callSite.line + 1);
    expect(after.stepId).toBe(before.stepId);
  });

  it("keeps identity stable across differently named roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-roots-"));
    temporaryDirectories.push(parent);
    const firstRoot = join(parent, "demo-app");
    const secondRoot = join(parent, "demo-app-clone");
    await Promise.all([
      cp(demoApp, firstRoot, { recursive: true }),
      cp(demoApp, secondRoot, { recursive: true }),
    ]);
    const registry = createMatcherRegistry();

    const firstIds = scan(firstRoot, registry, "same-project").map(
      ({ stepId }) => stepId,
    );
    const secondIds = scan(secondRoot, registry, "same-project").map(
      ({ stepId }) => stepId,
    );

    expect(secondIds).toEqual(firstIds);
  });

  it("does not read files outside the registered file patterns", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-filter-"));
    temporaryDirectories.push(root);
    const binaryPath = join(root, "artifact.bin");
    await writeFile(binaryPath, "unreadable");
    await chmod(binaryPath, 0o000);

    expect(scan(root, createMatcherRegistry(), "demo-project")).toEqual([]);
  });

  it("skips build output, virtual environments, vendored trees and the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-ignore-"));
    temporaryDirectories.push(root);
    const paths = [
      "src/app.ts",
      ".next/server/chunks/app.js",
      "vendor/sdk/index.js",
      "venv/lib/python3.12/site-packages/litellm/main.py",
      ".rightmodeler/config/models.json",
    ];
    await Promise.all(
      paths.map((path) => mkdir(join(root, path, ".."), { recursive: true })),
    );
    await Promise.all([
      writeFile(
        join(root, "src/app.ts"),
        'import { generateText } from "ai";\ngenerateText({ model: "acme/large-1", prompt })',
      ),
      writeFile(
        join(root, ".next/server/chunks/app.js"),
        'import { generateText } from "ai";\ngenerateText({ model: "acme/large-1", prompt })',
      ),
      writeFile(
        join(root, "vendor/sdk/index.js"),
        'import { generateText } from "ai";\ngenerateText({ model: "acme/large-1", prompt })',
      ),
      writeFile(
        join(root, "venv/lib/python3.12/site-packages/litellm/main.py"),
        'import litellm\nlitellm.completion(model="acme/large-1", messages=[])',
      ),
      writeFile(
        join(root, ".rightmodeler/config/models.json"),
        '{"ai":{"primary":{"model":"acme/large-1"}}}',
      ),
    ]);

    expect(
      scan(root, createMatcherRegistry(), "p").map(
        ({ callSite }) => callSite.path,
      ),
    ).toEqual(["src/app.ts"]);
  });

  it("keeps scanning when a matcher throws and reports the skipped file", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-skip-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await Promise.all([
      writeFile(
        join(root, "src/a.ts"),
        'import { generateText } from "ai";\nexplode();\ngenerateText({ model: "acme/large-1", prompt })',
      ),
      writeFile(
        join(root, "src/b.ts"),
        'import { generateText } from "ai";\ngenerateText({ model: "acme/large-1", prompt })',
      ),
    ]);
    const plugin: Matcher = {
      slug: "plugin-explode",
      description: "Exploding plugin",
      noiseTier: "normal",
      filePatterns: ["**/*.ts"],
      examples: ["pluginCall()"],
      match(content): CandidateMatch[] {
        if (content.includes("explode")) throw new Error("boom");
        if (content !== "pluginCall()") return [];
        return [
          {
            slug: this.slug,
            label: "plugin",
            snippet: content,
            enclosingSymbolPath: "<module>",
            normalizedCallShape: {
              callee: "pluginCall",
              argumentKeys: [],
              enclosing: "<module>",
            },
            needsTools: false,
            needsStructuredOutput: false,
            line: 1,
          },
        ];
      },
    };

    const result = scanRepository(root, createMatcherRegistry([plugin]), "p");

    expect(result.records.map(({ callSite }) => callSite.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(result.skipped).toEqual([
      {
        path: "src/a.ts",
        matcherSlug: "plugin-explode",
        reason: "boom",
      },
    ]);
  });

  it("masks each file once and hands the masked text to every matcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-mask-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/a.ts"),
      "// generateText(\nconst x = pluginCall();\n",
    );
    let suppliedMask: string | undefined;
    const plugin: Matcher = {
      slug: "plugin-mask",
      description: "Masked text plugin",
      noiseTier: "normal",
      filePatterns: ["**/*.ts"],
      examples: ["pluginCall()"],
      match(content, _path, searchable): CandidateMatch[] {
        suppliedMask = searchable;
        if (content !== "pluginCall()") return [];
        return [
          {
            slug: this.slug,
            label: "plugin",
            snippet: content,
            enclosingSymbolPath: "<module>",
            normalizedCallShape: {
              callee: "pluginCall",
              argumentKeys: [],
              enclosing: "<module>",
            },
            needsTools: false,
            needsStructuredOutput: false,
            line: 1,
          },
        ];
      },
    };

    scan(root, createMatcherRegistry([plugin]), "p");

    expect(suppliedMask).toBe("                \nconst x = pluginCall();\n");
  });

  async function scanSource(source: string) {
    const root = await mkdtemp(join(tmpdir(), "rightmodeler-scanner-ai-sdk-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), source);
    return scan(root, createMatcherRegistry(), "p");
  }

  it("records the literal telemetry functionId as the trace key", async () => {
    const records = await scanSource(
      [
        'import { generateText } from "ai";',
        "export async function summarize(prompt) {",
        '  return generateText({ model: "acme/large-1", prompt, telemetry: { functionId: "summarize" } });',
        "}",
        "export async function triage(prompt) {",
        "  return generateText({ model: \"acme/large-1\", prompt, experimental_telemetry: { metadata: { a: 1 }, functionId: 'triage' } });",
        "}",
      ].join("\n"),
    );

    expect(records.map(({ traceKey }) => traceKey)).toEqual([
      "summarize",
      "triage",
    ]);
  });

  it("records no trace key for a variable or template functionId", async () => {
    const records = await scanSource(
      [
        'import { generateText } from "ai";',
        "export async function summarize(prompt, name) {",
        '  return generateText({ model: "acme/large-1", prompt, telemetry: { functionId: name } });',
        "}",
        "export async function triage(prompt, kind) {",
        '  return generateText({ model: "acme/large-1", prompt, telemetry: { functionId: `triage-${kind}` } });',
        "}",
      ].join("\n"),
    );

    expect(records).toHaveLength(2);
    expect(records.map((record) => "traceKey" in record)).toEqual([
      false,
      false,
    ]);
  });

  it("marks a structured output request as structured", async () => {
    const records = await scanSource(
      [
        'import { generateText, Output } from "ai";',
        "export async function extract(prompt) {",
        '  return generateText({ model: "acme/large-1", prompt, output: Output.object({ schema }) });',
        "}",
        "export async function answer(prompt) {",
        '  return generateText({ model: "acme/large-1", prompt, output: Output.text() });',
        "}",
      ].join("\n"),
    );

    expect(
      records.map(({ capabilityRequirements }) => capabilityRequirements),
    ).toEqual([["structured_output"], []]);
  });

  it("finds streamObject calls", async () => {
    const records = await scanSource(
      'import { streamObject } from "ai";\nstreamObject({ model: "acme/large-1", schema, prompt });\n',
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      callSite: { matcherSlug: "js-ai-sdk-stream-object", line: 2 },
      currentModel: "acme/large-1",
      capabilityRequirements: ["structured_output"],
    });
  });
});
