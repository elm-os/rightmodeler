// /vs/[slug] as Markdown, generated from the same JSON the page renders from, so a comparison can
// never say one thing in HTML and another in Markdown. One case per block type in
// vs-page.schema.json; scripts/markdown.test.mjs fails if the schema grows a type this misses.

import type { VsBlock, VsPageData, VsSide } from "@/content/vs/types";

function side(part: VsSide | undefined): string[] {
  if (!part) return [];
  return [
    `**${part.heading}**`,
    "",
    ...part.items.map((item) => `- ${item}`),
    "",
  ];
}

function block(item: VsBlock): string[] {
  switch (item.type) {
    case "tldr":
      return [item.body ?? "", ""];

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
          `Use: ${entry.winner}`,
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
      const left = item.leftLabel ?? "Theirs";
      const right = item.rightLabel ?? "rightmodeler";
      lines.push(`| | ${left} | ${right} |`, "| --- | --- | --- |");
      for (const row of item.rows ?? []) {
        lines.push(`| ${row.dimension} | ${row.theirs} | ${row.ours} |`);
      }
      lines.push("");
      if (item.caption) lines.push(`_${item.caption}_`, "");
      return lines;
    }

    case "stack": {
      const lines = [`## ${item.heading ?? "Using both"}`, ""];
      if (item.intro) lines.push(item.intro, "");
      for (const paragraph of item.paragraphs ?? []) lines.push(paragraph, "");
      for (const entry of item.commands ?? []) {
        lines.push("```bash", `# ${entry.comment}`, entry.command, "```", "");
      }
      return lines;
    }

    case "prose": {
      const lines = [`## ${item.heading ?? ""}`.trimEnd(), ""];
      if (item.intro) lines.push(item.intro, "");
      for (const paragraph of item.paragraphs ?? []) lines.push(paragraph, "");
      return lines;
    }

    case "definitions": {
      const lines = [`## ${item.heading ?? "Definitions"}`, ""];
      if (item.intro) lines.push(item.intro, "");
      for (const term of item.terms ?? [])
        lines.push(`- **${term.term}**: ${term.def}`);
      lines.push("");
      return lines;
    }

    case "faq": {
      const lines = ["## FAQ", ""];
      for (const entry of item.items ?? []) {
        lines.push(`### ${entry.q}`, "", entry.a, "");
      }
      return lines;
    }

    default:
      // Fail closed, matching the posture of check-vs.test.mjs: an unhandled block would
      // silently drop content from the Markdown representation.
      throw new Error(`render-vs: unhandled block type "${item.type}"`);
  }
}

export function renderVsMarkdown(data: VsPageData): string {
  const lines = [`# ${data.h1}`, "", data.lede, ""];
  for (const entry of data.blocks) lines.push(...block(entry));
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
