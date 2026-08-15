import { readdir, readFile } from "node:fs/promises";

import { ABSTAIN_REASONS } from "@rightmodeler/kernel";
import { describe, expect, it } from "vitest";

const harnessesUrl = new URL(
  "../../../../../skills/rightmodeler/reference/harnesses/",
  import.meta.url,
);
const templateUrl = new URL("_template.md", harnessesUrl);
const evidenceUrl = new URL(
  "../../../../../skills/rightmodeler/reference/evidence.md",
  import.meta.url,
);

const sections = [
  "Live docs first",
  "Where the model id is bound",
  "Correlation forwarding",
  "Base URL override",
  "Side-effect mocking",
  "Entry point",
  "Coupling detection",
] as const;

const referenceFiles = [
  "autogen.md",
  "crewai.md",
  "dspy.md",
  "go-openai.md",
  "index.md",
  "java-langchain4j.md",
  "langchain-js.md",
  "langchain-py.md",
  "langgraph.md",
  "litellm-proxy.md",
  "mastra.md",
  "raw-anthropic.md",
  "raw-openai.md",
  "ruby-openai.md",
  "vercel-ai-sdk.md",
] as const;

describe("harness skill references", () => {
  it("ships every reference and follows the template section order", async () => {
    const template = await readFile(templateUrl, "utf8");
    const templateHeadings = [...template.matchAll(/^## (.+)$/gm)].map(
      ([, heading]) => heading,
    );
    const files = (await readdir(harnessesUrl))
      .filter((file) => file.endsWith(".md") && file !== "_template.md")
      .sort();

    expect(files).toEqual(referenceFiles);
    expect(templateHeadings).toEqual(sections);

    for (const file of files) {
      const markdown = await readFile(new URL(file, harnessesUrl), "utf8");
      const headings = [...markdown.matchAll(/^## (.+)$/gm)].map(
        ([, heading]) => heading,
      );

      expect(headings, file).toEqual(sections);
      expect(markdown.split("\n").length, file).toBeGreaterThanOrEqual(60);
      expect(markdown.split("\n").length, file).toBeLessThanOrEqual(120);

      const liveDocsStart = markdown.indexOf("## Live docs first");
      const nextSection = markdown.indexOf(
        "## Where the model id is bound",
        liveDocsStart,
      );
      const liveDocs = markdown.slice(liveDocsStart, nextSection);
      expect(liveDocs, file).toMatch(/https:\/\/\S+/);
    }
  });
});

describe("evidence skill reference", () => {
  it("names every abstention reason exported by the kernel", async () => {
    const markdown = await readFile(evidenceUrl, "utf8");

    for (const reason of ABSTAIN_REASONS) {
      expect(markdown, reason).toContain(`\`${reason}\``);
    }
  });
});
