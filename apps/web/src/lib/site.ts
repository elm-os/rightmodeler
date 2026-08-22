// Site-wide constants — one source of truth for the production origin (metadata, sitemap, robots,
// canonical URLs), the house byline, and the two links that recur across the marketing surface.

export const SITE_URL = "https://www.rightmodeler.com";
export const SITE_NAME = "rightmodeler";
export const SITE_AUTHOR = "The rightmodeler team";

// The engineer's first click and first command — imported everywhere they appear (nav, hero,
// CTA band, blog CTA, integrations, vs) so the strings can never drift between surfaces.
// RUN_COMMAND is the published CLI's guided first run; SKILL_COMMAND installs the runbook that
// lets Claude Code and Codex-class agents drive the same CLI.
export const REPO_URL = "https://github.com/elm-os/rightmodeler";
// The published CLI. Linked from the structured data so the site and the package
// resolve to each other; the package manifest points its homepage back here.
export const NPM_PACKAGE_URL = "https://www.npmjs.com/package/rightmodeler";
export const RUN_COMMAND = "npx rightmodeler init";
export const SKILL_COMMAND =
  "npx skills add elm-os/rightmodeler --skill rightmodeler";

// The MIT grant itself. Linked from the footer's legal row, so the license the site
// claims is always one click away.
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

// Public contact for the legal pages (privacy policy, terms of service) and /contact.
export const CONTACT_EMAIL = "rightmodeler@gmail.com";

// The two public intake paths that are not email. Derived from REPO_URL the same way LICENSE_URL
// is, so a repo move updates every surface at once.
export const ISSUES_NEW_URL = `${REPO_URL}/issues/new/choose`;
export const SECURITY_URL = `${REPO_URL}/blob/main/.github/SECURITY.md`;

// The CLI reference that ships inside the published npm tarball, at its canonical source URL:
// getting-started, commands, exit-codes, evaluators, modeb. Named in the SoftwareApplication
// schema and in llms.txt so "where are rightmodeler's docs" has an answer.
export const DOCS_URL = `${REPO_URL}/tree/main/harness/packages/rightmodeler/docs`;

// A single doc file inside DOCS_URL. GitHub serves directories under /tree and files under
// /blob, so the two cannot share a base.
export function docsFileUrl(name: string): string {
  return `${REPO_URL}/blob/main/harness/packages/rightmodeler/docs/${name}`;
}

// Public profiles — used for the About page links and the Organization `sameAs` (app/about/page.tsx).
export const GITHUB_ORG_URL = "https://github.com/elm-os";
export const LINKEDIN_URL = "https://www.linkedin.com/company/rightmodeler";
export const X_URL = "https://x.com/rightmodeler";
export const REDDIT_URL = "https://www.reddit.com/user/rightmodeler/";

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
