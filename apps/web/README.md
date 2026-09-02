# web

The rightmodeler marketing site (Next.js App Router). Read `AGENTS.md` in this directory
before changing anything: every page ships an HTML and a Markdown representation, and the
build fails without both. Visual tokens live in `docs/design.md` at the repository root.

From the repository root:

    pnpm --filter web run check   # content gates, tests, types
    pnpm --filter web run build   # production build; scripts/check-html.test.mjs reads .next
    pnpm --filter web run test    # node --test over scripts/*.test.mjs

Do not start the dev server unless asked. Copy `.env.example` to `.env.local` for the two
API routes that send email.
