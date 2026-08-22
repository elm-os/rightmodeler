<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

**Keep this block, including in commits.** It is part of the project's agent setup, maintained by `next dev` for every agent that works here. If it appears as an uncommitted change, that is intentional — commit it as-is. Do not remove it to clean up a diff; it will be regenerated.
<!-- END:nextjs-agent-rules -->

# Every page ships two representations

This site content-negotiates Markdown per [acceptmarkdown.com](https://acceptmarkdown.com). An
agent that sends `Accept: text/markdown`, or fetches `<path>.md`, gets Markdown instead of HTML
from the same URL. That means **every route needs a Markdown representation**, and the build
fails without one (`src/app/api/markdown/[[...slug]]/route.ts` throws in `generateStaticParams`).

## Adding a page

Where the Markdown comes from depends on the kind of page:

- **A member of a templated family** (`/blog/[slug]`, `/vs/[slug]`, `/integrations/[slug]`):
  nothing to do. The renderers in `src/content/markdown/` generate from the same registry the
  route resolves from. **Adding a new family is the preferred way to add many pages**: write one
  renderer, get Markdown for every member forever.
- **A hub/index page**: add a renderer to `src/content/markdown/render-hub.ts`, generated from
  the registry it lists.
- **A one-off page**: add `src/content/pages/<slug>.ts` exporting `markdown`, register it in
  `src/content/pages/index.ts`, and add the route to `STATIC_MARKDOWN_PATHS` in
  `src/lib/markdown-routes.ts`. Also register the page in `src/app/sitemap.ts`,
  `src/lib/llms.ts` `PAGES`, and the footer; `scripts/markdown.test.mjs` fails if you miss one.

## Rules for a Markdown twin

1. **Faithful, not summarized.** Every heading, paragraph, list item, FAQ pair, table row,
   command, and step on the page appears in the twin. An agent reading the Markdown must not
   end up worse informed than one reading the HTML. Long pages produce long twins.
2. **Content only.** No nav, footer, "Related" row, or social icons. That is chrome.
3. **Responsive duplicates appear once.** Where the page renders the same rows as a mobile stack
   _and_ a desktop table, the twin carries them a single time.
4. **Exactly one `#` h1**, matching the page's h1. Section h2s become `##`, h3s become `###`.
5. **Keep every hedge verbatim.** This site labels illustrative figures as illustrative and
   distinguishes "modeled" from "measured". Never drop, soften, or upgrade those words.
6. **Never state a product fact twice.** Interpolate from `@/lib/product-facts` or `@/lib/site`
   rather than typing a trace-format count or a scorecard number. `scripts/check-content.mjs`
   enforces this.

## Writing the file

The twin lives in a TypeScript template literal, not a `.md` file, so that the em-dash gate and
the product-fact gate in `scripts/check-content.mjs` both cover it.

- **Never use fenced code blocks or inline backticks.** Use 4-space indented code blocks. This is
  the same constraint the `OVERVIEW` constant in `src/lib/llms.ts` works under.
- Escape a literal `$` before `{` as `\$`.
- **No em dashes**, anywhere, ever. CI fails the build on one.

## Response headers: what the platform honours

Header rules live in `vercel.json`, not `next.config.ts`. Two findings, both verified rather
than assumed, so nobody has to rediscover them:

1. **`next.config.ts` `headers()` is not applied to prerendered responses** in Next
   16.3.0-preview.5. A literal single-path rule with `src/proxy.ts` removed entirely was still
   dropped under `next start`, and the rule compiled into `routes-manifest.json` correctly yet
   production served the page without it.
2. **`Vary` cannot be set on a prerendered page at all** on the current deployment platform. A
   custom marker header and `Vary` were shipped from the _same_ `vercel.json` rule: the marker
   arrived on the response, `Vary` did not. The platform manages `Vary` on cached responses
   itself.

Consequences worth knowing before you debug this again:

- Headers set on a `NextResponse.next()` in `src/proxy.ts` do not reach a prerendered asset
  either. Only a `Response` the origin actually constructs keeps its headers, which is why the
  `406` and the Markdown representation both carry `Vary: Accept` correctly while the HTML
  representation does not.
- This costs nothing in cache correctness here: the Markdown representation is served from a
  different URL (`/api/markdown/...`) after the rewrite, so the two representations already have
  separate cache keys and cannot be served to the wrong audience.
- The `vercel.json` rule is kept as a statement of intent. If the platform stops managing `Vary`,
  it starts working with no code change.
