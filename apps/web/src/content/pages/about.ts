// Markdown twin of the /about route (src/app/about/page.tsx). Keep the two in sync.
export const markdown = `# About rightmodeler

About

Working toward production AI that maintains and optimizes itself, starting with validated model swaps.

rightmodeler is an open-source project from ELM-OS. We think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work.

We are solving it first for production AI systems, where a new model ships every few weeks and each one restarts the same manual job: notice it, pull real traces, build a replay, grade the outputs, write it up so it survives review, migrate, and do it again.

So we started with a validation framework for model swaps. The rightmodeler CLI reads the model calls your app already recorded, replays the recorded steps on cheaper or newer candidate models, and has a judge from a different vendor, or your own evaluator, grade every answer against the output you accepted. A swap that clears every release gate becomes a draft pull request that changes only model identifiers, with the evidence attached.

A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.

The mission: **production AI systems that maintain and optimize themselves, earning each step of autonomy with evidence**. The direction is a system that maintains itself inside the policy you set, reached one validated change at a time.

Today a person sets the policy (the quality floor, which models are allowed, an optional spend cap), gives the agent the word before it replays a new candidate, and decides which draft pull requests merge. Rolling back is one command that opens another pull request. That is deliberate: autonomy is earned with evidence, and validation is how rightmodeler earns it.

The CLI is on npm today. rightmodeler agent, the maintenance loop on a schedule, is in the same MIT-licensed repo, and you can self-host it today; a hosted version has a waitlist. Crucible, open-source observability and analytics for AI agents and MCP servers, lives in its own repository and runs on infrastructure you host. The CLI and the agent run offline, beside your app: the CLI on your machine or in CI, the agent on a host you run. Nothing sits in your request path, and there is no rightmodeler server and no telemetry.

## FAQ

### What is rightmodeler?

An open-source project from ELM-OS, working toward production AI systems that maintain and optimize themselves. It starts with a validation framework for model swaps: the rightmodeler CLI validates swaps to cheaper or newer models on your production traces and opens each one that clears every release gate as a draft pull request that changes only model identifiers, for a person to review and merge.

### Is it open source?

Yes, MIT licensed. The rightmodeler CLI and rightmodeler agent are both in the public GitHub repo, free to run, fork, and modify. The CLI is on npm today. The agent is self-hosted today: you clone and build it, then run it on a long-lived Node 24 host with your own GitHub App and model credentials. A hosted version of the agent has a waitlist. Crucible, open-source observability and analytics for AI agents and MCP servers, is in its own MIT-licensed repository, and you host it yourself.

### How is it different from observability or a gateway?

It answers a narrower question: whether a cheaper or newer model agrees with the outputs you accepted, step by step. Observability records what your app did, and a gateway serves the model you pin. rightmodeler reads the traces you already export, so your observability tool stays in place, and it can replay candidates through your gateway. It runs offline and never sits in your request path. A swap that clears every release gate becomes a draft pull request that changes only model identifiers, for a person to review and merge.
`;
