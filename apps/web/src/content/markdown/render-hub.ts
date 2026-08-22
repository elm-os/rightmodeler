// The four index pages as Markdown, generated from the same registries their routes resolve from.
// Deliberately reuses the annotated-link line format lib/llms.ts already uses, so an agent that
// has read /llms.txt meets the same shape here.

import { getAllPosts } from "@/content/blog";
import { getAllIntegrations } from "@/content/integrations";
import { getAllComparisons } from "@/content/vs";
import { CASE_STUDIES } from "@/content/case-studies";
import { SITE_NAME, SITE_URL } from "@/lib/site";

function link(title: string, path: string, description: string): string {
  return `- [${title}](${SITE_URL}${path}): ${description}`;
}

export function renderBlogIndexMarkdown(): string {
  return [
    "# The rightmodeler blog",
    "",
    "Notes on measuring model decisions: what the evidence supports, what it does not, and what we changed our minds about.",
    "",
    ...getAllPosts().map((post) =>
      link(post.meta.title, `/blog/${post.meta.slug}`, post.meta.description),
    ),
  ].join("\n");
}

export function renderVsIndexMarkdown(): string {
  return [
    "# Different question, different tool",
    "",
    `Honest comparisons with routers, gateways, and eval platforms: what each tool decides, what it measures, and when to use which.`,
    "",
    ...getAllComparisons().map((comparison) =>
      link(
        `${SITE_NAME} vs ${comparison.name}`,
        `/vs/${comparison.slug}`,
        comparison.description,
      ),
    ),
  ].join("\n");
}

export function renderIntegrationsIndexMarkdown(): string {
  return [
    "# Works with the traces you already have",
    "",
    "Every tool rightmodeler works with: the trace formats it reads and the infrastructure it replays through.",
    "",
    ...getAllIntegrations().map((integration) =>
      link(
        `${SITE_NAME} + ${integration.name}`,
        `/integrations/${integration.slug}`,
        integration.description,
      ),
    ),
  ].join("\n");
}

export function renderCaseStudyIndexMarkdown(): string {
  return [
    "# Case studies",
    "",
    "Per-workload routing studies with modeled savings, measured against the outputs each team had already accepted.",
    "",
    ...CASE_STUDIES.map((study) =>
      link(study.title, `/case-study/${study.slug}`, study.description),
    ),
  ].join("\n");
}
