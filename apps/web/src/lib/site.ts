// Site-wide constants — one source of truth for the production origin (metadata, sitemap, robots,
// canonical URLs), the house byline, and the two links that recur across the marketing surface.

export const SITE_URL = "https://www.rightmodeler.com";
export const SITE_NAME = "rightmodeler";
export const SITE_AUTHOR = "The rightmodeler team";

// The engineer's first click and first command — imported everywhere they appear (nav, hero,
// CTA band, blog CTA) so the strings can never drift between surfaces.
export const REPO_URL = "https://github.com/elm-os/rightmodeler";
export const RUN_COMMAND =
  "npx skills add elm-os/rightmodeler --skill rightmodeler";

// Public contact for the legal pages (privacy policy, terms of service).
export const CONTACT_EMAIL = "rightmodeler@gmail.com";

// Public profiles — used for the About page links and the Organization `sameAs` (app/about/page.tsx).
export const GITHUB_ORG_URL = "https://github.com/elm-os";
export const LINKEDIN_URL = "https://www.linkedin.com/company/rightmodeler";
export const X_URL = "https://x.com/rightmodeler";

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
