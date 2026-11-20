import { getAllPosts } from "@/content/blog";
import { BSIDE, IAM360 } from "@/content/case-studies";
import { getAllIntegrations } from "@/content/integrations";
import { getAllComparisons } from "@/content/vs";
import { TRACE_SOURCES } from "@/lib/product-facts";
import {
  CRUCIBLE_REPO_URL,
  DOCS_URL,
  docsFileUrl,
  NPM_PACKAGE_URL,
  REPO_URL,
  RUN_COMMAND,
  SITE_NAME,
  SITE_URL,
  SKILL_COMMAND,
} from "@/lib/site";

// The llms.txt blockquote. Stands alone: the thesis, what exists today, the human's part, and the
// never-in-the-request-path caveat. It travels without the site, so it never says a bare "safe".
const SUMMARY = `rightmodeler is working toward production AI systems that maintain and optimize themselves, starting with an open-source framework that validates swaps to cheaper or newer models on your own traces and opens each one that clears every release gate as a draft pull request. We think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work. We are solving it first for production AI systems, where a new model ships every few weeks and each one restarts the same manual job. The shortcuts teams take instead do not hold up. Blind swaps fail quietly. Routers don't work in production, in our opinion, because a runtime router picks a model per request with a policy that was not validated on your workload, adds a hop and a dependency to the request path, and can send the same input to different models, so behavior is harder to reproduce, audit and roll back; a gateway that serves the model you pin is a different thing. General benchmarks aren't your workload. Frontier everywhere costs too much. What holds up is one pinned model per step, validated on your own traces and changed through code review. The rightmodeler CLI (on npm as rightmodeler, MIT licensed; start with ${RUN_COMMAND} on the traces you already have) replays the recorded steps on cheaper or newer candidate models from your provider's live catalog and has a judge from a different vendor, or your own evaluator, grade every answer against the output you accepted. Replay sends recorded text conversations: cases whose conversation carries tool calls, tool definitions or non-text parts are left out of the replay sample today, and the run says how many. A swap must clear every release gate: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin. A swap that clears every gate becomes a draft pull request that changes only model identifiers, with the evidence attached; watch follows it through review and CI, and rollback opens a pull request that restores the exact pre-swap files. A coding-agent skill drives the same CLI. rightmodeler agent (same repository, self-hosted today; the hosted version has a waitlist) is the maintenance loop, on a schedule: a weekly catalog and price check that flags cheaper new or repriced models, a daily drift check on new traces whose proposals a person approves, one regression replay for each merged swap set, and follow-up on swap pull requests as review and CI report back. On your word it replays new candidates; once a replay clears every gate, it opens the draft pull request. It never merges and carries no merge capability. rightmodeler takes the work out of the loop, not the judgment: today a person sets the policy, gives the agent the word before it replays a new candidate, and decides whether each draft pull request merges. The CLI and the agent run offline, beside your app, on your machine or in CI, never in the request path. Crucible, open source and self-hosted, adds observability and analytics for AI agents and MCP servers, and rightmodeler replays its traces.`;

// Product overview in Markdown for llms-context.txt (indented code block avoids backticks here).
const OVERVIEW = `## What it is

${SITE_NAME} is a validation framework for model swaps: it validates swaps to cheaper or newer models on your production traces, the model calls your production app already recorded, and opens each one that clears every release gate as a draft pull request. It is built for production AI systems, and it is where we start toward production AI that maintains and optimizes itself.

## Why it exists

We think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work. We are solving it first for production AI systems, where a new model ships every few weeks and each one restarts the same manual job: notice it, pull real traces, build a replay, grade the outputs, write it up so it survives review, migrate, and do it again.

The shortcuts teams take instead do not hold up:

- Blind swaps fail quietly. A cheaper model drops into a step in thirty seconds. When it fails, nothing throws: the JSON still parses and is wrong on the edge cases.
- Routers don't work in production. This is our opinion, for three reasons: a runtime router picks a model per request with a policy that was not validated on your workload; it adds a hop and a dependency to the request path; and the same input can take different models, so behavior is harder to reproduce, audit and roll back. A gateway that serves the model you pin is a different thing, and ${SITE_NAME} replays through gateways.
- General benchmarks aren't your workload. A leaderboard ranks models on someone else's tasks. It cannot tell you whether a cheaper model matches the outputs you already accepted.
- Frontier everywhere costs too much. The most expensive model on every step feels safe until the bill compounds, call by call, on steps nobody has measured.

What holds up: one pinned model per step, validated on your own traces and changed through code review.

The mission is a direction, not a description of the product today: production AI systems that maintain and optimize themselves, earning each step of autonomy with evidence.

## What you can use today

- The ${SITE_NAME} CLI (on npm as rightmodeler, MIT licensed, available now). ${RUN_COMMAND} finds the traces you already have, such as Claude Code and Codex sessions on disk, or asks for a file, and runs free through shortlist before any provider key is needed. It replays the recorded steps on cheaper candidate models from your provider's live catalog: by default up to three released in the last 90 days, or models you name with --candidate that cost less than the recorded model. A judge from a different vendor, or your own evaluator, grades every answer against the output you accepted. Replay sends recorded text conversations: cases whose conversation carries tool calls, tool definitions or non-text parts are left out of the replay sample today, and the run says how many. Codex sessions are read as traces: a Codex turn that called no tools can enter the replay sample, sent with only that turn's user messages (no developer messages, base instructions or earlier turns), and a turn that called tools, as most Codex coding turns do, is left out. A swap that clears every release gate becomes a draft pull request that changes only model identifiers, with the evidence attached. The watch command follows that pull request through review and CI, and the rollback command opens a pull request that restores the exact pre-swap files. Braintrust, Langfuse, LangSmith, or promptfoo can score the replays instead of the built-in judge, curated datasets can seed the case set, and results can be exported back to Braintrust or Langfuse. A coding-agent skill (${SKILL_COMMAND}) gives Claude Code and Codex-class agents the runbook to drive the same CLI end to end.
- ${SITE_NAME} agent (open source, MIT, in the same repository; self-hosted today, and the hosted version has a waitlist): the maintenance loop, on a schedule. It runs a weekly catalog and price check that flags cheaper new or repriced models, a daily drift check on new traces whose proposals a person approves, one regression replay for each merged swap set, and follow-up on swap pull requests as review and CI report back. On your word it replays new candidates; once a replay clears every gate, it opens the draft pull request. It never merges and carries no merge capability. You build it from the repository and run it on a long-lived Node 24 host with your own GitHub App or token and model credentials.

## Crucible

Crucible (open source under the MIT license at ${CRUCIBLE_REPO_URL}) is self-hosted observability and analytics for AI agents and MCP servers, built in Rust and engineered for speed and throughput. Use it for agents only, MCP servers only, or both, with an agent's tool calls linked to the server-side MCP spans through trace context.

It is one Rust binary that ingests OpenTelemetry traces (OTLP over HTTP and gRPC) and serves a web UI, a REST API and an MCP server that coding agents can query. Telemetry is stored in a single-node ClickHouse (26.3 or newer), and Postgres (15 or newer) is the control plane. Instrumentation: OTLP from any OpenTelemetry SDK; spans from OpenInference, OpenLLMetry, the Vercel AI SDK, MLflow and Pydantic AI, mapped as they arrive; SDKs for TypeScript, Python, Go and Rust, with agent helpers and an MCP server wrapper; and a proxy that records an MCP server's calls with no code changes and forwards its traffic unchanged.

It covers traces, spans, sessions and users, with a timeline and an agent graph; cost, tokens and latency; full-text search; MCP call records; alerts to Slack, email and signed webhooks; a read-only SQL workspace isolated by ClickHouse; exports; retention and deletion requests; and organizations, projects, roles and API keys. Crucible acknowledges a span only after it is written to a write-ahead log and synced to disk, sends each batch to ClickHouse with a deduplication token so a retry never stores a span twice, and is tested with deterministic simulation and formal models. Crucible is self-hosted only.

crucible export writes traces as OpenTelemetry JSON, which the rightmodeler CLI replays to validate cheaper or newer models, and coding agents can ask Crucible about their runs over its MCP server.

## What safe means

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

The cases are split in two. The shortlist half only screens candidates; the lower-bound test against your quality floor runs on the held-out half, adjusted for the number of candidates. A tool that finds a swap every time is not measuring anything, so ${SITE_NAME} also tells you when not to switch.

## What a person still does today

A person sets the policy (the quality floor, which models are allowed, an optional spend cap), gives the agent the word before it replays a new candidate, and decides whether each draft pull request merges. Rolling back is one command that opens another pull request. ${SITE_NAME} takes the work out of the loop, not the judgment: today, the final yes stays yours. That is deliberate: autonomy is earned with evidence, and validation is how ${SITE_NAME} earns it.

## Where it runs

The CLI and the agent run offline, beside your app, on your machine or in CI. Nothing sits in the request path, there is no ${SITE_NAME} server and no telemetry, and it is not a runtime gateway. End-to-end confirmation runs your app in a sandbox, apart from production. That sandbox keeps your model key out but has ordinary network access, so point your app's tools at test fixtures, not production services.

## Get started

Start with the traces you already have:

    ${RUN_COMMAND}

Source: ${REPO_URL} (open source, MIT licensed)`;

const PAGES: { path: string; title: string; description: string }[] = [
  {
    path: "/how-it-works",
    title: "How it works",
    description:
      "Run rightmodeler from your terminal, coding agent, CI or the self-hosted agent. It validates cheaper or newer models on your traces and opens a draft PR for review.",
  },
  {
    path: "/use-cases/reduce-llm-costs",
    title: "Reduce LLM costs",
    description:
      "Frontier everywhere costs too much. rightmodeler validates cheaper or newer models on your production traces and opens a draft PR when a swap clears every gate.",
  },
  {
    path: "/case-study",
    title: "Case studies",
    description:
      "Two studies of per-workload model assignment: projected savings and a measured 100% pass rate on a 20-query benchmark at B:Side, and modeled savings at iAM360.",
  },
  {
    path: "/case-study/bside",
    title: `${BSIDE.company} case study`,
    description: BSIDE.description,
  },
  {
    path: "/case-study/iam360",
    title: `${IAM360.company} case study`,
    description: IAM360.description,
  },
  {
    path: "/integrations",
    title: "Integrations",
    description: `Everything the validation loop touches: the ${TRACE_SOURCES.length} trace formats rightmodeler reads, where cheaper or newer candidates replay, what grades them, and where the pull request lands.`,
  },
  {
    path: "/vs",
    title: "rightmodeler vs alternatives",
    description:
      "rightmodeler validates swaps to cheaper or newer models on your own traces. See where it ends and gateways, observability, evals, routers, benchmarks, and coding agents begin.",
  },
  {
    path: "/manifesto",
    title: "Software should maintain itself.",
    description:
      "We think the human work in the loop is the bottleneck. The case against blind swaps, runtime routers, general benchmarks and frontier bills, and for validation.",
  },
  {
    path: "/glossary",
    title: "Glossary",
    description:
      "Plain definitions for validating a swap to a cheaper or newer model: release gates, the quality floor, held-out cases, abstention, cascade risk, and what safe means.",
  },
  {
    path: "/agent",
    title: "rightmodeler agent",
    description:
      "rightmodeler agent flags cheaper models weekly, validates a swap on your traces when you say go, and opens a draft pull request once it clears every gate.",
  },
  {
    path: "/crucible",
    title: "Crucible: open-source agent and MCP observability",
    description:
      "Crucible is open-source, self-hosted observability and analytics for AI agents and MCP servers: one Rust binary, built for speed and throughput, that ingests OpenTelemetry traces.",
  },
  {
    path: "/about",
    title: "About",
    description:
      "rightmodeler is working toward production AI that maintains and optimizes itself, starting with open-source validation of cheaper or newer model swaps on your traces.",
  },
  {
    path: "/contact",
    title: "Contact",
    description:
      "Reach the rightmodeler team: email for questions and licensing, GitHub issues for bugs and feature requests, the feedback form for product input, and a security policy for vulnerability reports.",
  },
  {
    path: "/feedback",
    title: "Feedback",
    description:
      "Tell the rightmodeler team what to build, what broke, and what the agent should handle next. We read everything.",
  },
  {
    path: "/privacy",
    title: "Privacy policy",
    description:
      "How rightmodeler handles your information: what this site collects (very little), how it is used, where it lives, and how to reach us.",
  },
  {
    path: "/terms",
    title: "Terms of service",
    description:
      "Read the rightmodeler website terms, including pre-release product changes, illustrative figures, repository licensing, and acceptable use.",
  },
];

const DEVELOPER_RESOURCES = `- [CLI documentation](${DOCS_URL}): Command reference, getting started, exit codes, evaluators, and end-to-end confirmation in a sandbox (Mode B). Ships with the npm package.
- [Getting started](${docsFileUrl("getting-started.md")}): Install, point it at traces, and read the first report.
- [Command reference](${docsFileUrl("commands.md")}): Every command and flag, generated from the CLI itself.
- [Exit codes](${docsFileUrl("exit-codes.md")}): What each exit status means, for scripting and CI.
- [Evaluators](${docsFileUrl("evaluators.md")}): Scoring replays with Braintrust, Langfuse, LangSmith, or promptfoo instead of the built-in judge.
- [Coding-agent skill](${REPO_URL}/blob/main/skills/rightmodeler/SKILL.md): The runbook that lets Claude Code and Codex-class agents drive the CLI end to end. Install with ${SKILL_COMMAND}
- [npm package](${NPM_PACKAGE_URL}): The published CLI. Run it with ${RUN_COMMAND}
- [Source repository](${REPO_URL}): The pipeline, the agent, and the schemas. MIT licensed.`;

const pageLinks = PAGES.map(
  (page) => `- [${page.title}](${SITE_URL}${page.path}): ${page.description}`,
).join("\n");

const integrationLinks = getAllIntegrations()
  .map(
    (integration) =>
      `- [${SITE_NAME} + ${integration.name}](${SITE_URL}/integrations/${integration.slug}): ${integration.description}`,
  )
  .join("\n");

const vsLinks = getAllComparisons()
  .map(
    (comparison) =>
      `- [${SITE_NAME} vs ${comparison.name}](${SITE_URL}/vs/${comparison.slug}): ${comparison.description}`,
  )
  .join("\n");

// llmstxt.org layout: H1, blockquote, a non-heading line, link sections. "## Optional" is reserved.
export function buildLlmsTxt(): string {
  const postLinks = getAllPosts()
    .map(
      (post) =>
        `- [${post.meta.title}](${SITE_URL}/blog/${post.meta.slug}): ${post.meta.description}`,
    )
    .join("\n");

  return `# ${SITE_NAME}

> ${SUMMARY}

${SITE_NAME} is an open-source developer tool from ELM-OS for teams running production AI systems. This file indexes the site for language models; for a curated product overview, annotated page index, and complete blog archive in one file, see the Optional section.

## Product

- [${SITE_NAME}](${SITE_URL}): Home. Why the human work in the loop is the bottleneck, how rightmodeler validates cheaper or newer model swaps and opens draft pull requests, and the first command to run.
- [GitHub repository](${REPO_URL}): Source code and the pipeline you run on your own traces. Open source under the MIT license.

## Developer resources

${DEVELOPER_RESOURCES}

## Pages

${pageLinks}

## Integrations

${integrationLinks}

## Comparisons

${vsLinks}

## Blog

- [Blog index](${SITE_URL}/blog): All posts.
${postLinks}

## Optional

- [Curated site context](${SITE_URL}/llms-context.txt): Product overview, annotated page and integration index, and complete blog posts in one Markdown file.
`;
}

// Intentionally not described as a page-by-page mirror of the rendered site.
export function buildLlmsContext(): string {
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

## Developer resources

${DEVELOPER_RESOURCES}

## Page index

${pageLinks}

## Integration index

${integrationLinks}

## Comparison index

${vsLinks}

---

## Complete blog archive

${sections}
`;
}
