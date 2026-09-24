// Markdown twin of the /crucible route (src/app/crucible/page.tsx, plus the feature wall in
// src/components/sections/crucible-showcase.tsx). Keep this file in sync with those pages.

import { REPO_URL } from "@/lib/site";

export const markdown = `# Crucible: every layer, measured and right-sized.

In development · by rightmodeler

The analytics and optimization suite we are building for your AI agents: what every layer costs, how fast it runs, and where it fails, with your model stack kept right-sized, continuously.

Join the waitlist with your email address. One note when it opens, no spam.

## TL;DR

Crucible is being built to watch your agents in production: cost per layer, speed per step, failures as they happen. It will run the rightmodeler proof loop continuously, so the step behind a cost spike comes with measured evidence for the model it could run on.

## What Crucible will give you

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

## Available today: the CLI

Crucible itself is in active development. The engine behind it, the rightmodeler CLI, is on npm and GitHub now.

View on GitHub: ${REPO_URL}

## FAQ

### What is Crucible?

Crucible is the analytics and optimization suite for AI agents that rightmodeler is building. It is designed to show what every layer of your agent system costs, how fast it runs, and where it fails, and to run the rightmodeler proof loop continuously so your model stack stays right-sized as new traces arrive.

### When can I use it?

Crucible is in active development. Join the waitlist and we'll send an early-access note when it opens. The engine behind it, the rightmodeler CLI, is on npm and GitHub now.

### How does it connect?

It is designed to connect over MCP, using the tracing you already emit, with no new SDK. You will keep your own API keys and can route through OpenRouter, the Vercel AI Gateway, or LiteLLM.

### Is it a gateway?

No. Crucible is designed to read your traces passively and never sit in your request path. Your traffic keeps flowing through your own keys and routes; Crucible will watch, measure, and report.
`;
