// One case per block type in vs-page.schema.json: scripts/markdown.test.mjs fails if one is missed.
// The site origin, run command and repo URL are passed in, not imported, so the Node tests can load this module as is.

import type { VsBlock, VsPageData, VsSide } from "@/content/vs/types";

// A <placeholder> in prose parses as an HTML tag and drops out of the rendered twin; code lines stay literal.
const prose = (text: string) => text.replace(/</g, "\\<");

function side(part: VsSide | undefined): string[] {
  if (!part) return [];
  return [
    `## ${part.heading}`,
    "",
    ...part.items.map((item) => `- ${item}`),
    "",
  ];
}

function block(
  item: VsBlock,
  name: string,
  setupGuide: string | undefined,
  siteUrl: string,
): string[] {
  switch (item.type) {
    case "tldr":
      return [`**TL;DR** ${item.body ?? ""}`, ""];

    case "positioning":
    case "contrast":
    case "fork":
      return [...side(item.left), ...side(item.right)];

    case "scenarios": {
      const lines = [`## ${item.heading ?? "Scenarios"}`, ""];
      if (item.intro) lines.push(item.intro, "");
      for (const entry of item.scenarios ?? []) {
        lines.push(
          `### ${entry.scenario}`,
          "",
          `the right hire: ${
            entry.winner === "ours"
              ? "rightmodeler"
              : entry.winner === "both"
                ? "both, together"
                : name
          }`,
          "",
          entry.why,
          "",
        );
      }
      return lines;
    }

    case "table": {
      const lines = [`## ${item.heading ?? "Comparison"}`, ""];
      if (item.intro) lines.push(item.intro, "");
      if (item.caption) lines.push(`_${item.caption}_`, "");
      const left = item.leftLabel ?? "Theirs";
      const right = item.rightLabel ?? "rightmodeler";
      lines.push(`| | ${left} | ${right} |`, "| --- | --- | --- |");
      for (const row of item.rows ?? []) {
        lines.push(`| ${row.dimension} | ${row.theirs} | ${row.ours} |`);
      }
      lines.push("");
      return lines;
    }

    case "stack": {
      const lines = [`## ${item.heading ?? "Using both"}`, ""];
      if (item.intro) lines.push(item.intro, "");
      for (const paragraph of item.paragraphs ?? []) lines.push(paragraph, "");
      for (const entry of item.commands ?? []) {
        lines.push(`    ${entry.comment}`, `    ${entry.command}`, "");
      }
      if (setupGuide) lines.push(setupGuide, "");
      return lines;
    }

    case "prose": {
      const lines = [`## ${item.heading ?? ""}`.trimEnd(), ""];
      if (item.intro) lines.push(item.intro, "");
      for (const paragraph of item.paragraphs ?? [])
        lines.push(`- ${paragraph}`);
      lines.push("");
      return lines;
    }

    case "definitions": {
      const lines = [`## ${item.heading ?? "Definitions"}`, ""];
      if (item.intro) lines.push(item.intro, "");
      for (const term of item.terms ?? [])
        lines.push(
          term.slug
            ? `- **[${term.term}](${siteUrl}/glossary#${term.slug})**: ${term.def}`
            : `- **${term.term}**: ${term.def}`,
        );
      lines.push("");
      return lines;
    }

    case "faq": {
      const lines = ["## Frequently asked questions", ""];
      for (const entry of item.items ?? []) {
        lines.push(`### ${entry.q}`, "", entry.a, "");
      }
      return lines;
    }

    default:
      // Fail closed: an unhandled block would silently drop out of the Markdown representation.
      throw new Error(`render-vs: unhandled block type "${item.type}"`);
  }
}

// Mirrors the band that closes every comparison page; the button and command come in from the caller.
function cta(
  links: { runCommand: string; repoUrl: string } | undefined,
): string[] {
  return [
    "## Start with the traces you already have.",
    "",
    "The CLI runs from npx, nothing to install, and validates cheaper or newer models on your own traces.",
    ...(links
      ? ["", `View on GitHub: ${links.repoUrl}`, "", `    ${links.runCommand}`]
      : []),
  ];
}

export function renderVsMarkdown(
  data: VsPageData,
  siteUrl: string,
  links?: { runCommand: string; repoUrl: string },
): string {
  const lines = [
    `# ${data.h1}`,
    "",
    `Comparison · ${data.name}`,
    "",
    data.lede,
    "",
    data.verdictLabel,
    "",
    `Official site: ${data.website}`,
    "",
  ];
  // Mirrors the page: a stack section ends with the integration's setup guide when one exists.
  const setupGuide = data.integrationSlug
    ? `Setup guide: ${siteUrl}/integrations/${data.integrationSlug}`
    : undefined;
  for (const entry of data.blocks)
    lines.push(...block(entry, data.name, setupGuide, siteUrl));
  lines.push("", ...cta(links));
  return lines
    .map((line) => (line.startsWith("    ") ? line : prose(line)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
