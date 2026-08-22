// /integrations/[slug] as Markdown, generated from the same JSON the page renders from. The flat
// shape means there is no block dispatch here: every section is a fixed field, and an empty
// array or string hides its section exactly as it does in the page component.

import type { IntegrationData } from "@/content/integrations/types";
import { RUN_COMMAND } from "@/lib/site";

export function renderIntegrationMarkdown(data: IntegrationData): string {
  const lines = [`# ${data.h1}`, "", data.lede, "", data.tldr, ""];

  if (data.steps.length > 0) {
    lines.push(`## How it works with ${data.name}`, "");
    for (const step of data.steps) {
      lines.push(`### ${step.label}: ${step.title}`, "", step.body, "");
    }
  }

  lines.push("## Setup", "", data.setup.intro, "");
  // The standard install command renders first on the page too, from lib/site, so it can never
  // drift between the two representations.
  lines.push("```bash", RUN_COMMAND, "```", "");
  for (const entry of data.setup.commands) {
    lines.push("```bash", `# ${entry.comment}`, entry.command, "```", "");
  }

  if (data.reads.length > 0) {
    lines.push(`## What rightmodeler reads from ${data.name}`, "");
    lines.push("| Normalized field | Source field |", "| --- | --- |");
    for (const row of data.reads)
      lines.push(`| ${row.field} | ${row.source} |`);
    lines.push("");
  }

  if (data.detection) {
    lines.push(
      "## Autodetection",
      "",
      `Detected by: \`${data.detection}\``,
      "",
    );
  }

  if (data.useCases.length > 0) {
    lines.push("## Use cases", "");
    for (const useCase of data.useCases) {
      lines.push(`### ${useCase.title}`, "", useCase.body, "");
    }
  }

  if (data.limits.length > 0) {
    lines.push("## The honest part", "");
    for (const limit of data.limits) lines.push(`- ${limit}`);
    lines.push("");
  }

  if (data.faq.length > 0) {
    lines.push("## FAQ", "");
    for (const entry of data.faq) lines.push(`### ${entry.q}`, "", entry.a, "");
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
