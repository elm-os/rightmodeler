// Markdown twin of the /agent route (src/app/agent/page.tsx, plus sections/agent-showcase.tsx and
// sections/agent-pr-card.tsx). Keep it in sync with those files whenever the page copy changes.

import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

export const markdown = `# The last model migration you do by hand.

Open source · by rightmodeler

A new model ships. rightmodeler agent replays it against your real traces, prices the swap, and opens a pull request with the evidence attached. You review it like any other change. It lives in the open-source repo today; a hosted version is on the way.

Waitlist: enter your email address (you@company.com) and submit "Get early access".

Get hosted early access. One note when it opens, no spam.

## How it decides

### The deliverable

A one-line diff with the receipts attached.

The pull request the agent opens, as rendered on the page. The title bar stamps the scorecard figures as illustrative:

    rightmodeler agent · pull request                       ${ILLUSTRATIVE_SCORECARD.label}

    swap: summarize step to gpt-5.4-mini

    quality        ${ILLUSTRATIVE_SCORECARD.approved} vs ${ILLUSTRATIVE_SCORECARD.shipped} shipped · floor ${ILLUSTRATIVE_SCORECARD.floor} · medium
    p95 latency    -38% vs current
    list price     $5.00 → $0.75 in · $30.00 → $4.50 out · /1M

    steps/summarize.ts
    -  model: "gpt-5.6",
    +  model: "gpt-5.4-mini",

    85%
    cheaper per token · gpt-5.6 to gpt-5.4-mini · list prices

    ✓ replay: 214 traces    ✓ judge: pass    ✓ cascade: clear

### TL;DR

rightmodeler agent watches every model release, measures candidates against outputs you accepted, and opens the evidence and proposed model edit as a pull request in your repo. Model changes become code review.

### The loop

Watch, replay, judge, open the PR. Continuous, and always inside your guardrails.

### Watch

Every release, every provider, tracked live. Candidates get flagged per step the moment they ship.

### Replay

Candidates rerun your real traces end to end in a sandboxed worktree, so cascade failures surface early.

### Judge

Each output is judged against what you already shipped, cross-family, with your quality floor as the bar.

### Open the PR

Diff, evidence, and confidence, opened for your review. Weak evidence means no PR.

## Your preferences are the policy.

The agent moves only inside guardrails you set. Your configuration decides what counts as better, which models it may propose, and how much a run may spend.

    quality_floor   ${ILLUSTRATIVE_SCORECARD.floor} · judged against shipped outputs
    max_cost_usd    optional · hard stop when set, uncapped when not
    models          allow openai · anthropic · google · meta
    evaluator       braintrust · falls back to cross-family judge
    merge           open PR only · never auto-merge

illustrative config

### Runs where your work lives.

Self-hosted · Scheduled runs · Your API keys

Nothing sits in your request path. The agent wakes on a schedule, does its work, opens a PR, and goes back to sleep.

### Receipts on every PR

The diff ships with quality scores, cost deltas, latency, and the replayed traces behind them. When a reviewer asks why, the answer is already attached.

### It abstains

No candidate clears your floor, no PR. A tool that always finds a swap is not measuring anything.

### Every swap is reversible

Each applied change records the exact files it touched before and after. One command opens the pull request that restores the pre-swap state, and it refuses if the files have moved on without it.

The proof engine behind the agent is the rightmodeler CLI, and you can run it on your own traces today with ${RUN_COMMAND}.

View on GitHub: ${REPO_URL}

## FAQ

### What is rightmodeler agent?

An autonomous agent that keeps every step of your AI stack on the right model. It watches new model releases, replays them against your real traces, judges each output against what you already shipped, and opens a pull request in your repo when a swap clears your quality floor and preferences.

### When can I use it?

Today, if you self-host: the agent ships in the open-source repo and runs on your own infrastructure with your own GitHub and model credentials. Join the waitlist for the hosted version and we will send one note when early access opens.

### Does it merge changes on its own?

No. The agent opens pull requests; merging stays with you, and it carries no merge capability at all. Your configuration sets the guardrails: the quality floor, a model allowlist and denylist, an optional hard spend cap per run (omit it and every case runs to completion when evidence matters more than cost), and which evaluator scores the replays.

### What does it evaluate against?

Your own traces and the outputs you already shipped, not public benchmarks. Judging is cross-family, position-swapped, and reference-guided, and the agent abstains instead of opening a PR when the evidence is weak.

### How is it different from running the CLI myself?

Same proof loop, different cadence. The CLI is an audit you run when you want it. The agent runs that loop on a schedule: it re-checks prices as they decay, watches approved swaps for drift, reconciles open swap pull requests as CI reports back, and turns each result into a pull request you review.
`;
