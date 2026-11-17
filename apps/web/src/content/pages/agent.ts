// Markdown twin of the /agent route (src/app/agent/page.tsx, plus sections/agent-showcase.tsx and
// sections/agent-pr-card.tsx). Keep it in sync with those files whenever the page copy changes.

import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

export const markdown = `# Stop re-checking models by hand.

Open source · by rightmodeler

rightmodeler agent is the maintenance loop, on a schedule. A weekly catalog and price check flags cheaper new or repriced models and projects what a replay would cost. On your word, it replays the candidate on your production traces and, once the swap clears every gate, opens a draft pull request with the evidence attached. A person says go, and a person merges. Self-host it today from the MIT-licensed repo; the hosted version has a waitlist.

Join the hosted version waitlist with your email address. One note when it opens, no spam.

## How it decides

The draft pull request the agent opens, as rendered on the page. The title bar stamps the card as illustrative:

    rightmodeler agent · pull request                       ${ILLUSTRATIVE_SCORECARD.label}

    swap: summarize step to gpt-5.4-mini

    quality        ${ILLUSTRATIVE_SCORECARD.approved} · floor ${ILLUSTRATIVE_SCORECARD.floor}
    cost/case      $0.0420 → $0.0066 · -84.3%
    list price     $5.00 → $0.75 in · $30.00 → $4.50 out · /1M

    steps/summarize.ts
    -  model: "gpt-5.6",
    +  model: "gpt-5.4-mini",

    85%
    cheaper per token · gpt-5.6 to gpt-5.4-mini · list prices

    ✓ replay: 214 traces    ✓ judge: pass    ✓ cascade: clear

### The deliverable

A diff that changes only model identifiers, with the receipts attached.

### TL;DR

rightmodeler agent rechecks the provider catalog every week for cheaper models. On your word, it does the validation work unattended, and when a swap clears every gate, it opens the evidence and the model edit as a draft pull request in your repo. Today, the final yes stays yours.

### The loop

Notice, replay, judge, open the PR. On a schedule and on your word, inside the policy you set.

### Notice

A weekly schedule rechecks catalog prices and rebuilds the shortlist, so a cheaper model released in the last 90 days gets flagged per step.

### Replay

On your word, candidates replay your recorded calls, and swaps that feed later model steps are confirmed end to end in a sandbox.

### Judge

A judge from a different vendor, or your own evaluator, grades each output against the one you accepted, with your quality floor as the bar.

### Open the PR

A draft pull request that changes only model identifiers, evidence attached, for your review. Thin evidence means no PR.

## You set the policy.

The agent works only inside the policy you set: how closely a cheaper model must match the outputs you accepted, which models it may propose, which evaluator grades the replays, and how much a run may spend. There is no merge setting: the agent opens draft pull requests, and it will never auto-merge.

    quality_floor   ${ILLUSTRATIVE_SCORECARD.floor} · judged against shipped outputs
    max_cost_usd    optional · hard stop when set, uncapped when not
    allow_models    gpt-5.4-mini · gpt-5.4-nano · deepseek-chat
    deny_models     llama-4-nano
    evaluator       braintrust · a judge from a different vendor when unset

illustrative config

### Runs where your work lives.

Self-hosted · Scheduled runs · Your API keys

Nothing sits in your request path. The agent wakes on a schedule, does its work offline, reports back, and goes back to sleep.

### Receipts on every PR.

Each draft pull request carries its evidence: the worst-case lower bound, cost per case before and after, the winning candidate's p50 latency, the sample size and caps, and the replayed case IDs. When a reviewer asks why, the answer is already attached.

### It abstains.

Thin evidence means abstain, and no candidate at your floor means no PR. A tool that always finds a swap is not measuring anything.

### Rollback is one command.

Each applied change records the exact files it touched, before and after. One command, run by a person on a merged swap, opens the pull request that restores the exact pre-swap files, and it refuses if those files have moved on since.

The validation engine behind the agent is the rightmodeler CLI, and you can run it on the traces you already have today with ${RUN_COMMAND}.

View on GitHub: ${REPO_URL}

## FAQ

### What is rightmodeler agent?

The maintenance loop for production AI systems, on a schedule. It takes the noticing, re-pricing, re-checking, and pull-request follow-up off a person's plate. Every week it rechecks the provider catalog for cheaper new or repriced models; on your word, it replays a candidate against your traces, judges each output against what you already shipped, and opens a draft pull request in your repo when the swap clears every gate. A person decides whether it merges.

### When can I use it?

Today, if you self-host: the agent is in the MIT-licensed repo, and you clone it, build it, and run it on a long-lived Node 24 host with your own GitHub App and model credentials. The hosted version has a waitlist; join it and we will send one note when it opens.

### Does it merge changes on its own?

No. The agent opens draft pull requests; merging stays with you, and it carries no merge capability at all. It can close a swap pull request whose CI failure repeats, but it never merges, deploys, or swaps a model on its own. That is deliberate: autonomy is earned with evidence, and validation is how rightmodeler earns it. Your policy sets the guardrails: the quality floor, the shortlist size, a model allowlist and denylist, an optional hard spend cap per run (omit it and every case runs to completion when evidence matters more than cost), and which evaluator scores the replays.

### What does it evaluate against?

Your own traces and the outputs you already shipped, not general benchmarks. A judge from a different vendor, or your own evaluator, grades every answer, and the built-in judge runs position-swapped and reference-guided. The statistical lower bound must reach your quality floor on held-out cases (the shortlist half only screens candidates), and the agent abstains instead of opening a PR when the evidence is thin.

### How is it different from running the CLI myself?

Same validation loop, different cadence. The CLI is a validation run you start when you want one. The agent runs that loop on a schedule: a weekly catalog and price check that flags cheaper new or repriced models, follow-up on swap pull requests as review and CI report back, a daily drift check on new traces whose proposals a person approves, and one regression replay for each merged swap set. On your word it replays new candidates, and once a replay clears every gate, it opens the draft pull request.
`;
