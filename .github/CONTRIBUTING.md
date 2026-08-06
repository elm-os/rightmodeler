# Contributing to rightmodeler

Thanks for your interest. rightmodeler is MIT licensed, and contributions of any
size are welcome: bug reports, trace-format support, docs, and code.

By contributing you agree that your contributions are licensed under the
[MIT License](../LICENSE).

## Requirements

- Node.js 20+
- `pnpm` 11
- Python 3.12+
- [`uv`](https://docs.astral.sh/uv/)

## Setup

Install workspace dependencies and sync the Python environments:

```bash
pnpm install
cd apps/pipeline && uv sync
cd ../../skills/rightmodeler && uv sync
cd ../..
```

## Workspace layout

| Path                  | What it is                                                      |
| --------------------- | --------------------------------------------------------------- |
| `skills/rightmodeler` | The canonical skill source. This is the artifact users install. |
| `apps/pipeline`       | Python batch pipeline: ingest, analyze, evaluate, report.       |
| `apps/web`            | The rightmodeler.com marketing site (Next.js).                  |
| `packages/contracts`  | JSON Schemas and fixtures. The pipeline contract boundary.      |
| `docs/`               | Product docs, specs, research, and the design system.           |

Two rules you cannot infer from the tree:

- **Edit `skills/rightmodeler` only.** The copies under `.agents/skills/` and
  `.claude/skills/` are generated install targets. Changes there are overwritten.
- **`.rightmodeler/` is generated output**, not source. It is the handoff boundary
  between the Python pipeline and the rest of the repo, and it is gitignored.

## Commands

Shared lifecycle tasks run from the repo root:

```bash
pnpm format
pnpm lint
pnpm check-types
pnpm check
pnpm build
```

Package-local commands:

```bash
pnpm --filter ./apps/pipeline run smoke
pnpm --filter ./apps/pipeline run ingest -- --input .rightmodeler/input/source.json
pnpm --filter ./apps/pipeline run analyze -- --input .rightmodeler/input/historical-run-bundle.json
pnpm --filter ./apps/pipeline run report -- --analysis-input .rightmodeler/analysis/task-families.json
pnpm --filter ./skills/rightmodeler run check
```

Use `pnpm` for anything JavaScript or TypeScript, and `uv` for Python work in
`apps/pipeline` and `skills/rightmodeler`.

## Validating a skill change

Install the local skill into this repo and run it end to end:

```bash
npx skills add . --skill rightmodeler --agent codex --yes --copy
```

## Working on the site

`apps/web` has extra rules, all enforced by `pnpm check`:

- Read [`docs/design.md`](../docs/design.md) first. Every color, type, and motion
  decision derives from its tokens, which live in `apps/web/src/app/globals.css`.
  The UI is monochrome and light theme only.
- No em dashes in visible copy. `apps/web/scripts/check-content.mjs` fails the build
  on them.
- Shared counts and scores come from `src/lib/product-facts.ts`, never hardcoded.
- Blog posts carry a JSX body and a parallel markdown string that must match exactly.
- Keep app code under `src/`, use `@/*` imports, and name source files in kebab-case.

## Pull requests

1. Branch off `main`.
2. Run `pnpm format` and `pnpm check` before pushing. Both must pass.
3. Use conventional commits, scoped to the package you touched:

   ```
   feat(skill): multi-provider replay across OpenRouter and LiteLLM
   fix(web): keep meta descriptions within Bing limits
   docs: streamline documentation structure
   ```

4. Keep the diff scoped to the change. Do not reformat or refactor adjacent code.
5. Open the PR against `main` and fill in the template.

## Reporting bugs

Open an [issue](https://github.com/elm-os/rightmodeler/issues/new/choose). For
anything security related, do not open a public issue: follow
[SECURITY.md](SECURITY.md) instead.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part
you agree to uphold it.
