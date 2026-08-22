// Markdown twin of the /about route (src/app/about/page.tsx). Keep the two in sync.
export const markdown = `# About rightmodeler

Measured evidence over guesswork, for the models your agents run on.

rightmodeler is an open-source tool for teams running multi-agent LLM systems. It measures how closely cheaper candidates match the outputs you already accepted, one call at a time.

The mission is simple: **no model decision on vibes**. rightmodeler detects inefficient calls, measures candidates against what you already shipped, and reports the evidence, sample size, and abstentions before applying an edit you approve. A report and an edit, never a runtime gateway.

rightmodeler is an ELM-OS project. The CLI is available today; rightmodeler agent, which ships swaps as pull requests, and Crucible, the analytics and optimization suite, are built on the same evidence loop and coming next.

## FAQ

### What is rightmodeler?

An open-source tool for teams running multi-agent LLM systems. It replays your own traces through cheaper candidates, measures each result against the output you accepted, and reports the evidence, sample size, and abstentions before you approve a repo edit.

### Is it open source?

Yes, MIT licensed. The rightmodeler CLI is on npm and GitHub, free to run, fork, and modify on your own traces today. rightmodeler agent, which opens evidence-backed swap PRs, and Crucible, the analytics and optimization suite, are the products being built on top of it.

### How is it different from observability or a gateway?

Observability shows you problems; a runtime gateway intercepts live traffic. rightmodeler replays candidates against accepted outputs, reports the evidence and abstentions, and applies only the edits you approve. Nothing runs in your request path.
`;
