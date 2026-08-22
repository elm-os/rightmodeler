// Markdown twin of the /how-it-works route (src/app/how-it-works/page.tsx). Keep the two in sync.
import { TRACE_SOURCES } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND, SKILL_COMMAND } from "@/lib/site";

export const markdown = `# How rightmodeler works

Run it from your terminal, your coding agent, or on autopilot. The same loop everywhere, measured on the traces you already have.

**Run it**

## Pick your surface. Same loop underneath.

### From your terminal

One command, nothing to install. It finds the traces Claude Code and Codex already left on disk, or asks for a file, and runs free through shortlist. Add a provider only when you want the replay, and estimate projects that spend first.

    # needs Node 24 or newer
    ${RUN_COMMAND}

### The first run

    $ ${RUN_COMMAND}

    Found trace files:
    1. Claude Code session, about 26 model calls, 2 hours ago
    2. OpenTelemetry GenAI export, about 37 model calls, yesterday
    Choose a trace file [1]:

    scan: completed · ingest: completed · corpus: completed
    shortlist: completed

    Replay calls cheaper models through any OpenAI-compatible endpoint, such as OpenRouter or the Vercel AI Gateway.
    Provider base URL:

It finds your traces, runs free through shortlist, and asks before anything spends.

### From your coding agent

One install gives Claude Code and Codex-class agents the runbook to drive the whole loop: plan preview, staged runs, boundary resumes, and an apply dry run before anything ships.

    # for Claude Code and Codex-class agents
    ${SKILL_COMMAND}

### In CI, on a schedule

The same command runs unattended. Every event streams as JSON lines, and the exit code is the verdict, so a weekly job can audit, stop at a named boundary, and resume.

    exits 0 no recommendation · 1 recommendation · 2 needs input · 3 budget reached

### On autopilot, self-hosted

Clone the repo, build it, and start the agent on a Node 24 host. New model releases, price drops, and drift arrive as pull requests with the evidence attached. A hosted version is on the waitlist.

[Meet the agent](/agent)

**TL;DR** rightmodeler replays your real agent traces through cheaper models, judges each output against **what you already shipped**, then reports the evidence, sample size, and abstentions for your review.

## Where traces come from.

Traces are the logs your AI tools already write: the models called, their inputs, and their outputs. If you use Claude Code or Codex, those logs are already on disk, and init finds them automatically. If your app logs to an observability tool like Langfuse, Braintrust, LangSmith, Helicone, or W&B Weave, export a file and point init at it. You never have to produce anything new.

[See every supported source](/integrations)

    in ▸ raw traces

## 01 Detect

Point it at the traces you already emit. rightmodeler autodetects the format across ${TRACE_SOURCES.length} sources and folds every run into one per-step schema, with no new SDK and no re-instrumentation.

    reads ${TRACE_SOURCES.join(" · ")}  →  1 per-step schema

## 02 Measure

It replays each step through cheaper candidates on your real inputs and measures every output against what you accepted. Each candidate gets a cost delta, reference-agreement score, and evidence count, and it abstains when the evidence is weak.

    scores cost · agreement · evidence count  →  recommendation + confidence · abstain on thin evidence

## 03 Review

You review the plan, and the CLI ships only the swaps you approve as a pull request with the evidence attached. It then watches CI on that PR, and if you change your mind, one command opens the pull request that restores the exact pre-swap state. Never a live intercept. You decide what to change, and when.

    applies approved swaps arrive as a pull request · watch reconciles CI · rollback restores byte-exact

    out ▸ signed report

## How to read confidence.

Hard checks run before a model judge. When judgment is needed, a cross-family judge scores both output orders. Every rate is a statistical lower bound, not a point estimate, and a shortlist winner must clear your quality floor again on held-out cases before it is recommended. Evidence counts show what earned the confidence band, and the evidence type limits how high that band can go. Confidence applies only to the prompt, inputs, and runs evaluated. It measures agreement with what you shipped, not proof of correctness.

## Not observability. Not a runtime gateway.

Observability only shows you problems; a gateway hijacks live traffic. rightmodeler measures candidates on runs you already shipped, then applies only the edits you approve.

[View on GitHub](${REPO_URL}) · [Crucible (coming soon)](/crucible)

## FAQ

### What do I need to run it?

Node 24 or newer, and the traces your AI tools already write. If you use Claude Code or Codex in your project, init finds their traces automatically. A provider key is only needed when you replay, and "npx rightmodeler estimate --base-url <provider>/v1" projects that spend first with zero paid calls.

### Which traces are supported?

${TRACE_SOURCES.length} formats, autodetected: ${TRACE_SOURCES.slice(0, -1).join(", ")}, and ${TRACE_SOURCES.at(-1)}. rightmodeler folds them all into one per-step schema, so you point it at the traces you already emit, with no new instrumentation.

### Does it touch production?

No. rightmodeler replays your past traces offline and produces a report plus a repo edit. It never sits in your request path, routes live traffic, or adds latency. It is not a runtime gateway.

### Do you store my data?

It runs locally on your own traces and your own replay provider key. Replays call your selected provider, OpenRouter, the Vercel AI Gateway, or a LiteLLM proxy, using your key; there is no rightmodeler server holding your traces.

### Can I use my existing eval framework?

Yes. Braintrust, Langfuse, LangSmith, and promptfoo can score the replays instead of the built-in judge, and a reachable configured evaluator is always preferred. You can also build the case set from a curated dataset you already maintain, which raises how much the audit can certify, and push trials and verdicts back to your platform when the run completes.

### Can my coding agent run it?

Yes. One install adds a runbook that Claude Code and Codex-class agents follow to drive the whole loop: plan preview, staged runs with resumable boundaries, and an apply dry run before anything ships. The runbook drives the same CLI through npx.
`;
