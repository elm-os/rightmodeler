# rightmodeler

- Keep docs in `docs/`, not at the repo root.
- Do not run the dev server unless explicitly asked.
- Use `pnpm` for repo-level and JavaScript or TypeScript work.
- Use `uv` for Python dependency and runtime commands in `apps/pipeline`.
- Prefer root `pnpm` commands for shared lifecycle tasks: `format`, `check`, `lint`, `build`, `check-types`.
- Keep app-specific runtime commands local to the owning app or run them via `pnpm --filter`.
- Treat `packages/contracts` and `.cheaper-models/` as the current pipeline contract boundary.
- Edit `skills/cheaper-models` as the canonical skill source. `.agents/skills/` and `.claude/skills/` are generated install targets.
- Run `pnpm format` and `pnpm check` after changes.

## Web

- Do not use Tailwind line-spacing utilities.
- Do not use custom Tailwind tracking values.
- If tracking is needed, use only `tracking-normal`, `tracking-tight`, or `tracking-tighter`.
