// Builders for the LLM-facing text endpoints (/llms.txt and /llms-full.txt), following the
// llmstxt.org convention. Generated from the same site constants and post registry the rest of the
// app uses, so they stay in sync as posts are added. The route handlers serve the output as
// text/plain; charset=utf-8.

import { SITE_NAME, SITE_URL, REPO_URL, RUN_COMMAND } from "./site";
import { getAllPosts } from "../blog/posts";

// One-paragraph summary for the llms.txt blockquote. Stands alone: an LLM should grasp what
// rightmodeler is and its key caveat (report, not gateway) from this line.
const SUMMARY =
  "Prove which models you can safely downgrade. rightmodeler replays your real agent traces through cheaper models, judges each output against what you already shipped, and produces a recommendation report showing exactly which model swaps are safe, with evidence and confidence on every call. It is a report you run on your own traces, not a runtime gateway.";

// Product overview in Markdown for llms-full.txt (indented code block avoids backticks in this file).
const OVERVIEW = `## What it is

${SITE_NAME} is a developer tool for teams running multi-agent LLM systems. It answers one question with evidence: which steps in your stack can move to a cheaper model without losing quality?

## How it works

- Replay your real agent traces through cheaper candidate models.
- Judge each cheaper output against what you already shipped in production, using reference-based and judge-based evaluation.
- Get a per-step recommendation report: which downgrades hold up, how much they save, and the confidence behind each call.
- It abstains when the evidence is weak. A tool that always finds savings is not measuring anything, so ${SITE_NAME} also tells you when not to switch.

It is a report, not a runtime gateway. It does not sit in your request path, route your traffic, or add a hop to your latency budget. You read the evidence and decide what to swap, and when.

## Get started

Run it on your own traces:

    ${RUN_COMMAND}

Source: ${REPO_URL}`;

// /llms.txt — curated index: H1, blockquote summary, a non-heading context line, then annotated
// link sections. The reserved "## Optional" section points at the full-content file.
export function buildLlmsTxt(): string {
  const postLinks = getAllPosts()
    .map(
      (post) =>
        `- [${post.meta.title}](${SITE_URL}/blog/${post.meta.slug}): ${post.meta.description}`,
    )
    .join("\n");

  return `# ${SITE_NAME}

> ${SUMMARY}

${SITE_NAME} is a developer tool from ELM-OS for teams running multi-agent LLM systems. This file indexes the site for language models; for the complete text of every page in one file, see the Optional section.

## Product

- [${SITE_NAME}](${SITE_URL}): Home. What it does, how the evidence-backed downgrade report works, and the first command to run.
- [GitHub repository](${REPO_URL}): Source code and the pipeline you run on your own traces.

## Blog

- [Blog index](${SITE_URL}/blog): All posts.
${postLinks}

## Optional

- [Full site content](${SITE_URL}/llms-full.txt): Every page and blog post inlined as one Markdown file, for loading the whole corpus at once.
`;
}

// /llms-full.txt — full content: the product overview, then each post's Markdown with a Source line.
export function buildLlmsFull(): string {
  const sections = getAllPosts()
    .map(
      (post) =>
        `Source: ${SITE_URL}/blog/${post.meta.slug}\n\n${post.markdown.trim()}`,
    )
    .join("\n\n---\n\n");

  return `# ${SITE_NAME}

> ${SUMMARY}

Source: ${SITE_URL}

${OVERVIEW}

---

${sections}
`;
}
