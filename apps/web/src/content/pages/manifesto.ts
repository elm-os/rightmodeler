// Markdown twin of the /manifesto route (src/app/manifesto/page.tsx). Keep the two in sync.

import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { REPO_URL, SITE_URL } from "@/lib/site";

export const markdown = `# Software should maintain itself.

Manifesto

We think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work. We start with production AI systems, where a new model ships every few weeks and each one restarts the same manual job.

## The bottleneck is the work, not the judgment.

Given replays, scores, and cost deltas, an engineer makes the right call in minutes. What takes days is everything before the call: noticing the release, pulling real traces, building a replay harness, grading the outputs, writing it up so it survives review, migrating, and doing it all again when the next model ships. That standing job is the part software should do. rightmodeler takes the work out of the loop, not the judgment.

## Blind swaps fail quietly.

A cheaper model drops into a step in thirty seconds. Knowing whether it got worse does not. Cheaper models fail without throwing errors: the extraction still returns valid JSON and is wrong on the edge cases, and the summary still reads well and drops the one detail the next step needed. You find out from a user.

## Routers don't work in production.

This is our opinion, and these are the reasons. By routers we mean runtime model selectors that pick a model per request, not gateways that forward the model you pinned. A router decides with a policy that was not validated on your workload. It adds a hop and a dependency to the request path. The same input can take different models, so behavior is harder to reproduce, audit, and roll back. Production wants one pinned model per step, validated on your traces and changed through code review. rightmodeler replays through gateways, offline, and never sits in the request path.

## General benchmarks aren't your workload.

A leaderboard ranks models on someone else's tasks. It cannot tell you whether a cheaper model matches the outputs you already accepted, on your prompts and context. Your traces are the benchmark.

## Frontier everywhere costs too much.

The most expensive model on every step feels safe. Then the bill compounds, call by call, and nobody can say which step earned it. The expensive model should earn its price on the hard steps, and only your traces can show which steps those are.

The section carries an illustrative figure: a model usage ledger headed "model usage · June" and stamped illustrative, with every step running on the same frontier model.

| Step | Model | Cost |
| --- | --- | --- |
| classify | gpt-5.6 | $1,180 |
| extract | gpt-5.6 | $940 |
| summarize | gpt-5.6 | $2,310 |
| judge | gpt-5.6 | $860 |
| rerank | gpt-5.6 | $1,040 |
| answer | gpt-5.6 | $620 |

month to date: $6,950 and climbing

## Safe means it cleared every gate.

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

## It can say no.

Thin evidence means abstain. A tool that finds a swap every time is not measuring anything.

The section carries a figure of how a validation run decides: your traces come in, cheaper or newer candidates replay, and two outcomes land on opposite branches.

    your traces
      |
      v
    replay cheaper or newer candidates
      |
      +--> clears every gate --> ✓ draft PR: gpt-5.4-mini
      |
      +--> evidence too thin --> ✕ abstain · keep gpt-5.6

## Autonomy is earned with evidence.

We are not asking anyone to trust a system that changes models on its own. We are building the evidence that would justify one, a validated change at a time, inside the policy you set. Today rightmodeler does the work, and when a swap clears every gate it opens a draft pull request that changes only model identifiers, with the evidence attached.

## Nothing merges on its own.

A person sets the policy (the quality floor, which models are allowed, an optional spend cap), gives the agent the word before it replays a new candidate, and decides whether each draft pull request merges. To roll back a merged swap, one command opens the pull request that restores the exact pre-swap files. Today, the final yes stays yours.

The section carries an illustrative figure: a review panel headed "Review the evidence" and stamped ${ILLUSTRATIVE_SCORECARD.label}. The agent's finding reads:

    rightmodeler-agent
    swap: summarize step to gpt-5.4-mini
    Q ${ILLUSTRATIVE_SCORECARD.approved} · 85% cheaper · 214 traces replayed

Under the finding: "Gates, sample sizes, and cost-per-case receipts attached. Whether it merges is your call." The panel offers two controls, Close and Merge.

View on GitHub: ${REPO_URL}

See how it works: ${SITE_URL}/how-it-works

## FAQ

### What do you mean by the human in the loop?

The hand work of keeping a production AI system on the right models: noticing a release, building a replay harness, grading outputs, writing it up, migrating, and doing it again every few weeks. For swaps to cheaper or newer models, rightmodeler does that work, up to a draft pull request with the evidence attached. A person still sets the policy and gives the final yes.

### What makes a model swap safe?

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

### Why not use a router?

In our view, a runtime router makes a fresh choice per request with a policy that was not validated on your workload, adds a hop and a dependency to the request path, and can send the same input to different models, which makes behavior harder to reproduce, audit, and roll back. rightmodeler validates a swap per step, offline, on your own traces, and proposes it as a draft pull request; a person decides whether it merges. The result is one pinned model per step. A gateway that serves the model you pin is a different thing, and rightmodeler replays through gateways.

### Does rightmodeler touch production?

No. It is built for production AI systems and validates on production traces, the calls your app already recorded, but it runs offline beside your app, on your machine or in CI, never in your request path. Swaps that feed later model steps are confirmed by running your app in a sandbox, apart from production. That sandbox has ordinary network access, so point your app's tools at test fixtures, not production services.

### Will it swap models on its own?

No. rightmodeler never merges, deploys, or swaps anything on its own, and the agent carries no merge capability. It abstains when the evidence is thin, flags cascade risk, and, when a swap clears every gate, opens a draft pull request that changes only model identifiers. A person reviews it and decides whether it merges; after a merge, one command opens the pull request that restores the exact pre-swap files.

### Where is this going?

Toward autonomous self-maintenance and optimization for production AI systems, earned with evidence. Today that means validated swaps to cheaper or newer models from the CLI and scheduled maintenance from the self-hosted agent. Crucible, in development, is planned as open-source, self-hosted observability for AI agents and MCP servers, and rightmodeler will replay its traces.
`;
