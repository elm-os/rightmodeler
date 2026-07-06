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
- Edit `skills/cheaper-models` as the canonical skill source. `.agents/skills/` and `.claude/skills/` are generated install targets.
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

# Ways of working

Any instruction that references `CLAUDE.md` means `AGENTS.md`.

## Think before coding

- State assumptions explicitly. Uncertain? Ask.
- Multiple interpretations? Present them - don't pick silently.
- See a simpler approach? Say so. Push back when warranted.
- Something unclear? Stop, name the confusion, ask.

## Plan before building

- Enter plan mode for any non-trivial task - 3+ steps or an architectural decision - verification work included. Trivial, obvious fixes skip the ceremony, never the verification.
- Turn the task into verifiable goals: "fix the bug" -> a test that reproduces it; "add validation" -> tests for invalid inputs, then make them pass; "refactor X" -> tests pass before and after. Strong criteria let you loop independently; weak ones ("make it work") force constant clarification.
- Write the plan to `tasks/todo.md` as `[Step] -> verify: [check]` items. Check in before implementing, mark items done as you go, end with a review section.
- If something goes sideways, stop and re-plan.

## Delegate to subagents

- Offload research, exploration, and parallel analysis to subagents - one task each - to keep the main context clean.
- Hard problem? Throw more compute at it: fan out.

## API docs first

- Before implementing against any API, pull the latest docs and read them. Never code against an API from memory.

## Simplicity first

- Minimum code that solves the problem. Nothing speculative: no features beyond the ask, no abstractions for single-use code, no unrequested flexibility, no error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Gut check: would a senior engineer call this overcomplicated? If yes, simplify.

## Surgical changes

- Touch only what you must. Every changed line traces to the request.
- Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken. Match existing style, even if you'd do it differently.
- Remove imports/variables/functions your change orphaned. Leave pre-existing dead code alone - mention it, don't delete it.

## Demand elegance

- For non-trivial changes, pause: is there a more elegant way? If a fix feels hacky, it is - fix the root cause. No temporary patches.
- Elegant means simpler, not fancier.

## Own bugs end to end

- Given a bug report or failing CI, fix it directly - zero hand-holding, zero context switching for the user.
- Chase the logs, errors, and failing tests yourself, through to resolution.

## Verify before done

- Loop until the success criteria pass: run tests, check logs, diff behavior against main when relevant.
- Challenge your own work before presenting it. Never mark a task complete without proof it works.

## Learn from corrections

- After any correction, capture the pattern in `tasks/lessons.md` as a rule that prevents the repeat.
- Review lessons at session start. Iterate until the mistake rate drops.
