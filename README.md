# rightmodeler

Polyglot monorepo for analyzing historical model runs and producing cheaper-model
recommendation reports.

Site: [rightmodeler.com](https://rightmodeler.com)

## Overview

This repository has two runtimes:

- `pnpm` manages the JavaScript and TypeScript workspace
- `uv` manages the Python pipeline app
- `turbo` orchestrates shared repo tasks like `build`, `check`, and `lint`

Use the repo root for workspace-wide tasks. Use the pipeline app for Python-native
work.

## Repository Layout

```text
.
├── apps/
│   ├── pipeline/   # Python CLI app for ingest, analysis, and report generation
│   └── web/        # Next.js app
├── docs/           # Product and project docs
├── packages/
│   └── contracts/  # Shared JSON Schema contracts
├── skills/
│   └── cheaper-models/  # Publishable agent skill source
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Requirements

- Node.js 20+
- `pnpm` 11
- Python 3.12+
- `uv`

## Getting Started

1. Install JavaScript workspace dependencies from the repo root:

```bash
pnpm install
```

2. Sync the Python app environment:

```bash
cd apps/pipeline
uv sync
cd ../..
```

3. Sync the skill environment if you are working on `cheaper-models`:

```bash
cd skills/cheaper-models
uv sync
cd ../..
```

4. Run the standard repo checks:

```bash
pnpm format
pnpm check
```

## Command Model

There are three levels of commands in this repo.

### 1. Repo-wide commands

Run these from the repository root when you want the whole workspace validated.

```bash
pnpm format
pnpm lint
pnpm check-types
pnpm check
pnpm build
```

### 2. App-specific commands from the root

Use `pnpm --filter` when you want one app but still want the root workflow.

```bash
pnpm --filter ./apps/web dev
pnpm --filter ./apps/web build

pnpm --filter ./apps/pipeline run smoke
pnpm --filter ./apps/pipeline run ingest -- --input .cheaper-models/input/foo.json
pnpm --filter ./apps/pipeline run analyze -- --input .cheaper-models/input/foo.json
pnpm --filter ./apps/pipeline run report -- --analysis-input .cheaper-models/analysis/task-families.json
pnpm --filter ./skills/cheaper-models run check
```

### 3. Native Python commands

Use these when you are working directly inside the pipeline app.

```bash
cd apps/pipeline
uv run python -m pipeline smoke
uv run python -m pipeline ingest --input ../../.cheaper-models/input/foo.json
uv run python -m pipeline analyze --input ../../.cheaper-models/input/foo.json
uv run python -m pipeline report --analysis-input ../../.cheaper-models/analysis/task-families.json
```

## Apps

### `apps/web`

The web app is a stock Next.js app scaffolded with `create-next-app`. It stays
separate from the Python runtime and participates in the repo through Turbo tasks.

Useful commands:

```bash
pnpm --filter ./apps/web dev
pnpm --filter ./apps/web build
pnpm --filter ./apps/web check
```

### `apps/pipeline`

The pipeline app is a Python CLI-first backend. It owns ingest, normalization,
analysis, and report generation.

Available commands:

- `smoke`
- `ingest`
- `analyze`
- `report`

Examples:

```bash
pnpm --filter ./apps/pipeline run smoke
pnpm --filter ./apps/pipeline run ingest -- --input .cheaper-models/input/source.json
pnpm --filter ./apps/pipeline run analyze -- --input .cheaper-models/input/historical-run-bundle.json
pnpm --filter ./apps/pipeline run report -- --analysis-input .cheaper-models/analysis/task-families.json
```

### `skills/cheaper-models`

The cheaper-models skill is the canonical publishable source for agent installs.
Do not edit generated copies under `.agents/skills/` or `.claude/skills/`.

Useful commands:

```bash
pnpm --filter ./skills/cheaper-models run format
pnpm --filter ./skills/cheaper-models run check
pnpm dlx skills add . --skill cheaper-models --agent codex --yes --copy
pnpm dlx skills add . --skill cheaper-models --agent claude-code --yes --copy
```

## Shared Contracts

`packages/contracts` contains the JSON Schemas shared across runtimes.

Current schemas:

- `historical-run-bundle`
- `normalized-run`
- `task-family-summary`
- `recommendation-report`

The pipeline validates artifacts against these schemas before writing outputs.

## Generated Artifacts

Pipeline outputs live under `.cheaper-models/`.

Expected layout:

```text
.cheaper-models/
├── input/
├── normalized/
├── analysis/
└── reports/
```

This directory is the current handoff boundary between the Python pipeline and the rest
of the repo.

## Docs

Project docs live in `docs/`.

- `docs/PRD.md`: product requirements

Keep product docs, technical notes, and planning docs in `docs/`, not at the repo root.

## Contributing

### Workflow

1. Install root dependencies with `pnpm install`
2. Sync the Python app with `cd apps/pipeline && uv sync`
3. Make your change
4. Run:

```bash
pnpm format
pnpm check
```

### Conventions

- Use `pnpm` for repo and JavaScript or TypeScript work
- Use `uv` for Python dependency and runtime commands
- Put product and design docs in `docs/`
- Prefer root `pnpm` commands for shared validation
- Keep app-specific runtime commands inside the owning app
- Edit `skills/cheaper-models` as the source of truth for the skill

### When adding scripts

- Add shared lifecycle scripts such as `build`, `check`, `lint`, `format`, and
  `check-types` where Turbo can orchestrate them
- Keep domain-specific commands local to the owning app, such as `ingest`,
  `analyze`, `report`, and `smoke`
- Avoid inventing duplicate root aliases for every app-specific operation
