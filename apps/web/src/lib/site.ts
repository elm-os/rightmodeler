export const SITE_URL = "https://www.rightmodeler.com";
export const SITE_NAME = "rightmodeler";
export const SITE_AUTHOR = "The rightmodeler team";

export const REPO_URL = "https://github.com/elm-os/rightmodeler";
export const NPM_PACKAGE_URL = "https://www.npmjs.com/package/rightmodeler";
export const RUN_COMMAND = "npx rightmodeler init";
export const SKILL_COMMAND =
  "npx skills add elm-os/rightmodeler --skill rightmodeler";

export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const CONTACT_EMAIL = "rightmodeler@gmail.com";

export const ISSUES_NEW_URL = `${REPO_URL}/issues/new/choose`;
export const SECURITY_URL = `${REPO_URL}/blob/main/.github/SECURITY.md`;

export const DOCS_URL = `${REPO_URL}/tree/main/harness/packages/rightmodeler/docs`;

// GitHub serves directories under /tree and files under /blob, so DOCS_URL cannot be the base.
export function docsFileUrl(name: string): string {
  return `${REPO_URL}/blob/main/harness/packages/rightmodeler/docs/${name}`;
}

export const GITHUB_ORG_URL = "https://github.com/elm-os";
export const LINKEDIN_URL = "https://www.linkedin.com/company/rightmodeler";
export const X_URL = "https://x.com/rightmodeler";
export const REDDIT_URL = "https://www.reddit.com/user/rightmodeler/";

// Pinned to UTC so the day never drifts across the reader's timezone.
export function formatPostDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
