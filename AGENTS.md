<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# rightmodeler

- Keep docs in `docs/`, not at the repo root.
- Do not run the dev server unless explicitly asked.
- Use `pnpm` for repo-level and JavaScript or TypeScript work.
- Use `uv` for Python dependency and runtime commands in `apps/pipeline`.
- Prefer root `pnpm` commands for shared lifecycle tasks: `format`, `check`, `lint`, `build`, `check-types`.
- Keep app-specific runtime commands local to the owning app or run them via `pnpm --filter`.
- Treat `packages/contracts` and `.cheaper-models/` as the current pipeline contract boundary.
- Run `pnpm format` and `pnpm check` after changes.

## Web

The visual identity is defined in `docs/design.md` (color, typography, motion) and
implemented as tokens in `apps/web/app/globals.css` (Tailwind v4 `@theme`) with
fonts loaded in `apps/web/app/layout.tsx`. Read `docs/design.md` before building or
changing any UI, and derive every color, type, and motion decision from its tokens.

- Use the design skills for UI work: `frontend-design` for visual direction,
  `emil-design-eng` for interaction/motion craft, `review-animations` to audit
  motion, and `animation-vocabulary` to name a motion effect you can describe.
- Colors: use the brand color utilities (`bg-parchment-white`, `bg-warm-sand`,
  `text-midnight-ink`, `text-driftwood`, `text-fog`, `border-ash-border`, …).
  The UI is monochrome — the accent hues (`void-violet`, `ember-orange`) are
  decorative/illustration only and never appear on buttons, links, or state.
  No semantic color-coding (no green/red/blue for success/error/info); hierarchy
  comes from surface contrast. Light theme only — no dark variant.
- Typography: use the semantic type utilities (`text-caption` … `text-display`),
  which bake in line-height and letter-spacing. Use `font-display` for headlines
  (≥ 32px), `font-sans` for UI/body, `font-mono` for code, and the `wordmark`
  utility for the logo only.
- Do not use Tailwind line-spacing (`leading-*`) utilities or ad-hoc tracking
  values — leading and tracking live in the type tokens.
- If tracking must be set directly, use only `tracking-normal`, `tracking-tight`, or `tracking-tighter`.
