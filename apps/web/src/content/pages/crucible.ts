// Markdown twin of the /crucible route (src/app/crucible/page.tsx, plus the feature wall in
// src/components/sections/crucible-showcase.tsx). Keep this file in sync with those pages.

import { REPO_URL } from "@/lib/site";

export const markdown = `# Crucible: every layer will be measured and right-sized.

In development · by rightmodeler

The analytics and optimization suite we are building for production AI systems: what every layer costs, how fast it runs, and where it fails. Software cannot maintain what it cannot see. The self-hosted agent runs the maintenance loop on a schedule today; Crucible will add the instruments.

Join the waitlist with your email address. One note when it opens, no spam.

## TL;DR

Crucible is being built to read the traces your production AI systems already emit: cost per layer, speed per step, **failures as they happen**. It will run the rightmodeler validation loop continuously, on top of the self-hosted agent's schedule, so the step behind a cost spike comes with measured evidence for a cheaper model it could run on.

## What Crucible will give you

### The instruments

- **Cost, by layer**
  One invoice will become a map: spend per agent, per step, per model.
- **Speed, by step**
  p50 and p95 per step, so the slow layer will stop hiding in an aggregate.
- **Failures, as they happen**
  Failed tools, silent retries, and quality regressions will surface in a passive feed.

### Always on

- **Your keys, your gateway**
  Will replay on your keys, direct or via OpenRouter, the Vercel AI Gateway, or LiteLLM.
- **Connected over MCP**
  Will read the traces you already have. No new SDK, no re-instrumentation.
- **Continuously right-sized**
  Will validate cheaper or newer model swaps as traces arrive, on top of the agent's schedule, with evidence and abstentions.

## Available today: the CLI and the agent

Crucible itself is in development. The validation framework it will build on, the rightmodeler CLI, is on npm now, and the self-hosted agent runs it on a schedule today.

View on GitHub: ${REPO_URL}

## FAQ

### What is Crucible?

Crucible is the analytics and optimization suite for production AI systems that rightmodeler is building. It is designed to show what every layer costs, how fast it runs, and where it fails, and to add continuous right-sizing on top of the self-hosted agent's schedule, validating swaps to cheaper or newer models as new traces arrive. It will be a step toward production AI that maintains itself.

### When can I use it?

Not yet. Crucible is in development; join the waitlist and we will send one note when it opens. Today you can run the rightmodeler CLI from npm and self-host the agent, which runs the maintenance loop on a schedule and replays new candidates on your word.

### How does it connect?

It is designed to connect over MCP, using the tracing you already emit, with no new SDK. You will keep your own API keys, and its replays will be able to go through OpenRouter, the Vercel AI Gateway, or LiteLLM.

### Is it a gateway?

No. Crucible is designed to read your traces passively and never sit in your request path. Your traffic keeps flowing through your own keys and providers; Crucible will read the traces it leaves, measure, and report.
`;
