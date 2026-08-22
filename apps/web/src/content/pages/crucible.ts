// Markdown twin of the /crucible route (src/app/crucible/page.tsx, plus the feature wall in
// src/components/sections/crucible-showcase.tsx). Keep this file in sync with those pages.

import { REPO_URL } from "@/lib/site";

export const markdown = `# Crucible: every layer, measured and right-sized.

Coming soon · by rightmodeler

The analytics and optimization suite for your AI agents. See what every layer costs, how fast it runs, and where it fails, while Crucible keeps your model stack right-sized, continuously.

Join the waitlist with your email address to get early access. One note when it opens, no spam.

## TL;DR

Crucible watches your agents in production: cost per layer, speed per step, failures as they happen. And because it runs the rightmodeler proof loop continuously, it does not just show you problems, it right-sizes the stack that caused them.

## What Crucible gives you

### The instruments

- **Cost, by layer**
  One invoice becomes a map: spend per agent, per step, per model.
- **Speed, by step**
  p50 and p95 per step, so the slow layer stops hiding in an aggregate.
- **Failures, as they happen**
  Failed tools, silent retries, and quality regressions surface in a passive feed.

### Always on

- **Your keys, your routes**
  BYO keys, or route through OpenRouter, the AI Gateway, or LiteLLM.
- **Connected over MCP**
  Reads the traces you already have. No new SDK, no re-instrumentation.
- **Continuously right-sized**
  Every new trace is audited as it arrives, and each audit reports its own evidence, sample size, and abstentions.

## Available today

Crucible is in active development. The engine behind it, the rightmodeler CLI, is on npm and GitHub now.

View on GitHub: ${REPO_URL}

## FAQ

### What is Crucible?

Crucible is the analytics and optimization suite for AI agents, by rightmodeler. It shows what every layer of your agent system costs, how fast it runs, and where it fails, and it runs the rightmodeler proof loop continuously so your model stack stays right-sized as new traces arrive.

### When can I use it?

Crucible is in active development. Join the waitlist and we'll send an early-access note when it opens. The engine behind it, the rightmodeler CLI, is on npm and GitHub now.

### How does it connect?

Over MCP, using the tracing you already emit, with no new SDK. You keep your own API keys and can route through OpenRouter, the Vercel AI Gateway, or LiteLLM.

### Is it a gateway?

No. Crucible reads your traces passively and never sits in your request path. Your traffic keeps flowing through your own keys and routes; Crucible watches, measures, and reports.
`;
