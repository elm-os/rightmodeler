// Markdown twin of the /about route (src/app/about/page.tsx). Keep the two in sync.
export const markdown = `# About rightmodeler

Measured evidence over guesswork, for the models your agents run on.

rightmodeler is an open-source tool for teams running multi-agent LLM systems. It measures how closely cheaper candidates match the outputs you already accepted, one call at a time.

The mission is simple: **no model decision on vibes**. rightmodeler detects inefficient calls, measures candidates against what you already shipped, and reports the evidence, sample size, and abstentions before applying an edit you approve. A report and an edit, never a runtime gateway.

rightmodeler is an ELM-OS project. The CLI is on npm today. rightmodeler agent, which opens evidence-backed swaps as draft pull requests, is in the same MIT-licensed repo, and you can self-host it today; a hosted version has a waitlist. Crucible, the analytics and optimization suite built on the same evidence loop, is in development.

## FAQ

### What is rightmodeler?

An open-source tool for teams running multi-agent LLM systems. It replays your own traces through cheaper candidates, measures each result against the output you accepted, and reports the evidence, sample size, and abstentions before you approve a repo edit.

### Is it open source?

Yes, MIT licensed. The rightmodeler CLI and rightmodeler agent are both in the public GitHub repo, free to run, fork, and modify. The CLI is on npm today. The agent is self-hosted today: you clone and build it, then run it on a long-lived Node 24 host with your own GitHub App and model credentials. A hosted version of the agent has a waitlist. Crucible, the analytics and optimization suite, is in development, also with a waitlist.

### How is it different from observability or a gateway?

It answers a narrower question: which model each step of your agent needs. rightmodeler replays recorded steps through cheaper candidates, measures each against the output you accepted, and reports the evidence, sample size, and abstentions. A swap that clears every release gate becomes a draft pull request that changes only model identifiers, and a human reviews and merges it. It reads exported traces, so your observability tool stays in place, and it never sits in your request path the way a runtime gateway does.
`;
