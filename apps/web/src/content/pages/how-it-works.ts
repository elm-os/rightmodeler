// Markdown twin of the /how-it-works route (src/app/how-it-works/page.tsx). Keep the two in sync.
import { TRACE_SOURCES } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND, SKILL_COMMAND } from "@/lib/site";

export const markdown = `# How rightmodeler works

How it works

rightmodeler's validation loop does the hand work of checking a cheaper or newer model: replaying your traces, grading every answer, and writing up the evidence. Run it from your terminal, your coding agent, or on a schedule. Today, the final yes stays yours.

**Run it**

## Pick your surface. Same loop underneath.

### From your terminal

One command, nothing to install. It finds the traces Claude Code and Codex already left on disk, or asks for a file, and runs free through shortlist. Add a provider only when you want the replay, and estimate projects that spend first.

    # needs Node 24 or newer
    ${RUN_COMMAND}

### The first run

    $ ${RUN_COMMAND}

    How should rightmodeler call models? Replay sends your recorded calls to cheaper models, and a judge model from another vendor grades each answer.
    1. My plans, through the CLIs signed in on this machine
    2. An API key for a model provider or gateway
    Choose [1]:

    Found trace files:
    1. Claude Code session, about 26 model calls, 2 hours ago
    2. OpenTelemetry GenAI export, about 37 model calls, yesterday
    Choose a trace file [1]:

    scan: completed · ingest: completed · corpus: completed
    shortlist: completed

It finds your traces, runs free through shortlist, and asks before anything spends.

### From your coding agent

One install gives Claude Code and Codex-class agents the runbook to drive the whole loop: plan preview, staged runs, boundary resumes, and an apply dry run before any pull request opens.

    # for Claude Code and Codex-class agents
    ${SKILL_COMMAND}

### In CI, on a schedule

The same command runs unattended. Every event streams as JSON lines, and the exit code is the verdict, so a weekly job can validate, stop at a named boundary, and resume.

    exits 0 no recommendation · 1 recommendation · 2 needs input · 3 budget reached

### On a schedule, self-hosted

Clone the repo, build it, and run the agent on a long-lived Node 24 host with your own GitHub App and model credentials. It runs a weekly catalog and price check that flags cheaper new or repriced models, a daily drift check on new traces whose proposals a person approves, and one regression replay for each merged swap set. On your word it replays a new candidate, and once the replay clears every gate it opens the draft pull request. It never merges. The hosted version has a waitlist.

[Meet the agent](/agent)

**TL;DR** rightmodeler validates cheaper or newer models on the traces you already have. It replays the recorded steps on cheaper or newer candidates and has a judge from a different vendor, or your own evaluator, grade every answer against **the outputs you accepted**. A swap becomes a draft pull request only when it clears every release gate; when the evidence is thin, it abstains.

## Where traces come from.

Traces are the logs your AI tools already write: the models called, their inputs, and their outputs. If you use Claude Code or Codex, those logs are already on disk, and init finds them automatically. If your app logs to an observability tool like Langfuse, Braintrust, LangSmith, Helicone, or W&B Weave, export a file and point init at it. You never have to produce anything new.

[See every supported source](/integrations)

    in ▸ raw traces

## 01 Detect

Point it at the traces you already emit. rightmodeler autodetects the format across ${TRACE_SOURCES.length} sources and folds every run into one per-step schema, with no new SDK and no re-instrumentation.

    reads ${TRACE_SOURCES.join(" · ")}  →  1 per-step schema

## 02 Validate

It replays the recorded steps on cheaper or newer candidate models, and a judge from a different vendor, or your own evaluator, grades every answer against the output you accepted. Replay sends recorded text conversations: cases whose conversation carries tool calls, tool definitions or non-text parts are left out of the replay sample today, and the run says how many. A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

    checks shortlist screen · held-out lower bound vs quality floor · end-to-end confirmation  →  every gate cleared, or no swap

## 03 Review

A swap that clears every gate becomes a draft pull request that changes only model identifiers, with the evidence attached, and you review it like any other change. The watch command follows it through review and CI, and if you change your mind after merging, one command opens the pull request that restores the exact pre-swap files. Never a live intercept. Today, the final yes stays yours.

    applies cleared swaps arrive as a draft pull request · watch follows review and CI · rollback opens a byte-exact restore

    out ▸ report · draft pull request

## How to read the evidence.

A judge from a different vendor scores both answer orders, or the evaluator you name grades the replays: Braintrust, Langfuse, LangSmith, or promptfoo, whose assertions can be deterministic checks such as is-json or regex. The shortlist half only screens candidates on their pass rate; the cheapest one that passes is replayed on held-out cases, where a 95% statistical lower bound on its agreement, not a point estimate, must reach your quality floor, adjusted for how many candidates competed. Failed and excluded cases count against the candidate. There are no confidence tiers: the sample size shows how much evidence stands behind each result. The evidence applies only to the prompts, inputs, and runs evaluated. It measures agreement with what you shipped, not ground-truth correctness.

## Not observability. Not a runtime gateway.

rightmodeler works offline on runs you already shipped. It validates cheaper or newer models step by step against the outputs you accepted, and only a swap that clears every gate becomes a draft pull request, which changes model identifiers and nothing else and waits for you to review and merge. Your observability tool keeps recording, any gateway keeps serving live traffic, and rightmodeler never sits in the request path.

[View on GitHub](${REPO_URL}) · [Crucible, open-source observability](/crucible)

## FAQ

### What do I need to run it?

Node 24 or newer, and the traces your AI tools already write. If you use Claude Code or Codex in your project, init finds their traces automatically. A provider key is only needed when you replay, and "npx rightmodeler estimate --base-url \\<provider>/v1" projects that spend first with zero paid calls.

### Which traces are supported?

${TRACE_SOURCES.length} formats, autodetected: ${TRACE_SOURCES.slice(0, -1).join(", ")}, and ${TRACE_SOURCES.at(-1)}. rightmodeler folds them all into one per-step schema, so you point it at the traces you already emit, with no new instrumentation.

### Does it touch production?

No. It is built for production AI systems and validates on the traces your app already recorded, but it runs offline beside your app, on your machine or in CI, and produces a report, plus a draft pull request when a swap clears every gate. It never sits in your request path, routes live traffic, or adds latency; it is not a runtime gateway. Swaps that feed later model steps are confirmed by running your app in a sandbox, apart from production. That sandbox has ordinary network access, so point your app's tools at test fixtures, not production services.

### Do you store my data?

It runs locally on your own traces and your own replay provider key. Replays call your selected provider, OpenRouter, the Vercel AI Gateway, or a LiteLLM proxy, using your key; there is no rightmodeler server holding your traces.

### Can I use my existing eval framework?

Yes. Braintrust, Langfuse, LangSmith, and promptfoo can score the replays instead of the built-in judge, and a reachable configured evaluator is always preferred. You can also build the case set from a curated dataset you already maintain, and push trials and verdicts back to Braintrust or Langfuse when the run completes.

### Can my coding agent run it?

Yes. One install adds a runbook that Claude Code and Codex-class agents follow to drive the whole loop: plan preview, staged runs with resumable boundaries, and an apply dry run before any pull request opens. The runbook drives the same CLI through npx.
`;
