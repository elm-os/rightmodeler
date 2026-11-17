// Mirrors app/integrations/[slug]/page.tsx section for section: keep the two in step.

import type { IntegrationData } from "@/content/integrations/types";
import { REPO_URL, RUN_COMMAND, SITE_URL, SKILL_COMMAND } from "@/lib/site";

// A <placeholder> in prose parses as an HTML tag and drops out of the rendered twin; code lines stay literal.
const prose = (text: string) => text.replace(/</g, "\\<");

export function renderIntegrationMarkdown(data: IntegrationData): string {
  const lines = [
    `# ${data.h1}`,
    "",
    `Integration · ${data.name}`,
    "",
    prose(data.lede),
    "",
    data.categoryLabel,
    "",
    `Official site: ${data.website}`,
    "",
    `**TL;DR** ${prose(data.tldr)}`,
    "",
  ];

  if (data.steps.length > 0) {
    lines.push(`## How it works with ${data.name}`, "");
    for (const step of data.steps) {
      lines.push(
        `### ${step.label}: ${prose(step.title)}`,
        "",
        prose(step.body),
        "",
      );
    }
  }

  lines.push("## Setup", "", prose(data.setup.intro), "");
  for (const entry of data.setup.commands) {
    lines.push(`    ${entry.comment}`, `    ${entry.command}`, "");
  }
  lines.push(
    "    # or let your coding agent drive it",
    `    ${SKILL_COMMAND}`,
    "",
  );

  if (data.reads.length > 0) {
    lines.push(
      `## What rightmodeler reads from ${data.name}`,
      "",
      "Every run is folded into one per-step schema, the same one the replay and the judge run on.",
      "",
      `_normalized schema ← ${data.name}_`,
      "",
    );
    lines.push("| Normalized field | Source field |", "| --- | --- |");
    for (const row of data.reads)
      lines.push(`| ${prose(row.field)} | ${prose(row.source)} |`);
    lines.push("");
    if (data.detection)
      lines.push(`autodetected by: ${prose(data.detection)}`, "");
  }

  if (data.useCases.length > 0) {
    lines.push("## Use cases", "");
    for (const useCase of data.useCases) {
      lines.push(`### ${prose(useCase.title)}`, "", prose(useCase.body), "");
    }
  }

  if (data.limits.length > 0) {
    lines.push("## The honest part", "");
    for (const limit of data.limits) lines.push(`- ${prose(limit)}`);
    lines.push("");
  }

  if (data.faq.length > 0) {
    lines.push("## Frequently asked questions", "");
    for (const entry of data.faq)
      lines.push(`### ${prose(entry.q)}`, "", prose(entry.a), "");
  }

  if (data.cta === "crucible") {
    lines.push(
      "## Crucible will add the instruments.",
      "",
      "The self-hosted rightmodeler agent runs the maintenance loop on a schedule today. Crucible, the analytics and optimization suite in development, is designed to track cost per layer, speed per step, and failures as they happen.",
      "",
      `Join the Crucible waitlist: ${SITE_URL}/crucible`,
    );
  } else {
    lines.push(
      "## Start with the traces you already have.",
      "",
      `The CLI runs from npx, nothing to install, and validates cheaper models on your ${
        data.reads.length > 0 ? `traces from ${data.name}` : "own traces"
      }.`,
      "",
      `View on GitHub: ${REPO_URL}`,
      "",
      `    ${RUN_COMMAND}`,
    );
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
