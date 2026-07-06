// Site-wide constants — one source of truth for the production origin (metadata, sitemap, robots,
// canonical URLs), the house byline, and the two links that recur across the marketing surface.

export const SITE_URL = "https://www.rightmodeler.com";
export const SITE_NAME = "rightmodeler";
export const SITE_AUTHOR = "The rightmodeler team";

// The engineer's first click and first command — kept identical to the landing page CTA so the blog
// closes on the same note (see components/sections/nav.tsx, hero.tsx, cta-band.tsx).
export const REPO_URL = "https://github.com/elm-os/rightmodeler";
export const RUN_COMMAND = "uv run python -m pipeline ingest";

// Format an ISO date (YYYY-MM-DD) as a readable byline date. Pinned to UTC so the day never drifts
// across the reader's timezone.
export function formatPostDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
