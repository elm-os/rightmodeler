// Builders for the LLM-facing text endpoints (/llms.txt and /llms-full.txt), following the
// llmstxt.org convention. Generated from the same site constants and post registry the rest of the
// app uses, so they stay in sync as posts are added. The route handlers serve the output as
// text/plain; charset=utf-8.

import { getAllPosts } from "@/content/blog";
import { SITE_NAME, SITE_URL, REPO_URL, RUN_COMMAND } from "@/lib/site";

// One-paragraph summary for the llms.txt blockquote. Stands alone: an LLM should grasp the whole
// platform (skill, agent, Crucible) and the key caveat (the skill is a report, not a gateway).
const SUMMARY =
  "rightmodeler keeps AI agents on the right model at every step. The rightmodeler skill, free on GitHub, replays your real agent traces through cheaper models and proves which swaps are safe, with evidence and confidence on every call. rightmodeler agent, coming soon, watches new model releases and opens evidence-backed model-swap pull requests in your repo. Crucible, in early access, is the analytics and optimization suite that shows what every layer of your agent system costs, how fast it runs, and where it fails, and keeps your stack right-sized continuously. The skill is a report you run on your own traces, not a runtime gateway.";

// Product overview in Markdown for llms-full.txt (indented code block avoids backticks in this file).
const OVERVIEW = `## What it is

${SITE_NAME} is the model layer for teams running multi-agent LLM systems. New models ship every few weeks, and the gap between the right model and the default one is real money. ${SITE_NAME} answers one question with evidence, at every step of your stack: which model belongs here?

Three offerings:

- The ${SITE_NAME} skill (available now): an audit you run on your own traces. It replays your real agent traces through cheaper candidate models, judges each output against what you already shipped, and produces a per-step recommendation report with evidence and confidence on every call. It is a report, not a runtime gateway; it never sits in your request path.
- ${SITE_NAME} agent (coming soon): the same proof loop, continuous. It watches new model releases, replays them against your traces, and when a swap clears your quality floor and preferences it opens a pull request in your repo with the evidence attached. Model migrations become code review.
- Crucible (early access): the analytics and optimization suite for your agents. Cost per layer, speed per step, failed tool calls and regressions as they happen, connected over MCP, while it keeps your model stack right-sized continuously.

## How the proof works

- Replay your real agent traces through candidate models.
- Judge each output against what you already shipped in production, using reference-based and judge-based evaluation.
- Abstain when the evidence is weak. A tool that always finds savings is not measuring anything, so ${SITE_NAME} also tells you when not to switch.

## Get started

Run the skill on your own traces:

    ${RUN_COMMAND}

Source: ${REPO_URL}`;

// Marketing / SEO pages, listed so language models can discover and cite them alongside the posts.
const PAGES: { path: string; title: string; description: string }[] = [
  {
    path: "/how-it-works",
    title: "How it works",
    description:
      "Detect, prove, fix: how rightmodeler replays your traces through cheaper models, judges each output against what you already shipped, and applies the safe swaps.",
  },
  {
    path: "/use-cases/reduce-llm-costs",
    title: "Reduce LLM costs",
    description:
      "Cut your agent's model bill without guessing: prove which steps can move to cheaper models on your own traces.",
  },
  {
    path: "/case-study",
    title: "Case studies",
    description:
      "How real teams right-sized their AI stacks with rightmodeler: per-workload routing policies, dramatically lower inference cost, and quality bars that hold.",
  },
  {
    path: "/case-study/bside",
    title: "Case study: B:Side Assist",
    description:
      "How rightmodeler right-sized AssistAI's 11 AI layers with a per-workload routing policy: 70.8% lower projected inference cost, 53.3% faster responses, 114.3% higher throughput, and a measured 100% quality pass rate.",
  },
  {
    path: "/case-study/iam360",
    title: "Case study: iAM360",
    description:
      "How iAM360 used rightmodeler's routing and evidence framework to cut modeled AI cost per request by 56-57%, while upgrading its hardest coaching paths from Terra to Sol.",
  },
  {
    path: "/manifesto",
    title: "Manifesto",
    description:
      "Prove it, don't guess: the case for evidence-backed model downgrading.",
  },
  {
    path: "/glossary",
    title: "Glossary",
    description:
      "Plain definitions for the model-downgrade vocabulary: quality floor, cascade risk, abstain, LLM-as-judge, and more.",
  },
  {
    path: "/agent",
    title: "rightmodeler agent (coming soon)",
    description:
      "The autonomous agent that watches new model releases, replays them against your real traces, and opens evidence-backed model-swap pull requests in your repo.",
  },
  {
    path: "/crucible",
    title: "Crucible (coming soon)",
    description:
      "The analytics and optimization suite for AI agents: cost per layer, speed per step, failures as they happen, and continuous right-sizing, connected over MCP.",
  },
  {
    path: "/about",
    title: "About",
    description: "What rightmodeler is and the mission behind it.",
  },
  {
    path: "/feedback",
    title: "Feedback",
    description:
      "Send the team feedback: what to build, what broke, and what the agent should handle next.",
  },
  {
    path: "/privacy",
    title: "Privacy policy",
    description:
      "What the site collects (very little), how it is used, and how to reach us.",
  },
  {
    path: "/terms",
    title: "Terms of service",
    description:
      "The terms that govern use of the rightmodeler website, in plain English.",
  },
];

const pageLinks = PAGES.map(
  (page) => `- [${page.title}](${SITE_URL}${page.path}): ${page.description}`,
).join("\n");

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

## Pages

${pageLinks}

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

## Pages

${pageLinks}

---

${sections}
`;
}
