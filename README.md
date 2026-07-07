# rightmodeler

rightmodeler proves, from your own agent traces, where a cheaper model can replace
an expensive one without breaking quality.

Site: [rightmodeler.com](https://www.rightmodeler.com)

## Install the skill

```bash
npx skills add elm-os/rightmodeler --skill rightmodeler
```

Then invoke `rightmodeler` in your coding agent.

The skill is the execution layer. It installs the skill bundle, then drives the
repo's Python scripts for you: preflight, ingest, analyze, replay, judge, TUI,
and report generation.

Before first run, set your OpenRouter key as:

```env
OPENROUTER_API_KEY=your_key_here
```

Put that line in your project root `.env`, or export it in your shell. The skill
checks the process environment first, then looks up the current repo tree for a
project `.env`.

On first run, `rightmodeler` should bootstrap its Python environment, run
preflight, ask only for missing inputs like the API key or trace path, then
continue in the same workflow once you reply.

## What it does

- Ingests trace logs from supported agent runtimes
- Maps your pipeline step by step
- Replays candidate cheaper models against your accepted outputs
- Flags cascade risk and abstains when the evidence is weak
- Writes working artifacts under `.rightmodeler/`

## Local validation

From the repo root:

```bash
pnpm install
pnpm format
pnpm check
npx skills add . --skill rightmodeler --agent codex --yes --copy
```

The canonical skill source lives in `skills/rightmodeler`. Do not edit generated
copies under `.agents/skills/` or `.claude/skills/`.

## Repository layout

```text
.
├── apps/
│   ├── pipeline/   # Python CLI app for ingest, analysis, and report generation
│   └── web/        # Next.js app
├── docs/           # Product and project docs
├── packages/
│   └── contracts/  # Shared JSON Schema contracts
├── skills/
│   └── rightmodeler/  # Publishable agent skill source
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Contributor setup

Requirements:

- Node.js 20+
- `pnpm` 11
- Python 3.12+
- `uv`

Install workspace dependencies and sync the Python environments:

```bash
pnpm install
cd apps/pipeline && uv sync
cd ../../skills/rightmodeler && uv sync
cd ../..
```

Shared repo commands:

```bash
pnpm format
pnpm lint
pnpm check-types
pnpm check
pnpm build
```

Useful package-local commands:

```bash
pnpm --filter ./apps/pipeline run smoke
pnpm --filter ./apps/pipeline run ingest -- --input .rightmodeler/input/source.json
pnpm --filter ./apps/pipeline run analyze -- --input .rightmodeler/input/historical-run-bundle.json
pnpm --filter ./apps/pipeline run report -- --analysis-input .rightmodeler/analysis/task-families.json
pnpm --filter ./skills/rightmodeler run check
```

## Generated artifacts

Pipeline and skill outputs live under `.rightmodeler/`.

Expected layout:

```text
.rightmodeler/
├── input/
├── normalized/
├── analysis/
└── reports/
```

This directory is the current handoff boundary between the Python pipeline and the
rest of the repo.

## Docs

Project docs live in `docs/`.

- `docs/PRD.md`: product requirements

Keep product docs, technical notes, and planning docs in `docs/`, not at the repo
root.
