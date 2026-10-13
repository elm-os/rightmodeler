// Import-free so the tests can load it directly under Node's type stripping.

// One-off pages only: the templated families (/blog, /vs, /integrations) resolve from their own
// registries. scripts/markdown.test.mjs fails if a page.tsx is covered by neither.
export const STATIC_MARKDOWN_PATHS: readonly string[] = [
  "/",
  "/about",
  "/agent",
  "/blog",
  "/case-study",
  "/case-study/bside",
  "/case-study/iam360",
  "/contact",
  "/crucible",
  "/feedback",
  "/glossary",
  "/how-it-works",
  "/integrations",
  "/manifesto",
  "/privacy",
  "/terms",
  "/use-cases/reduce-llm-costs",
  "/vs",
];

// Deliberately NOT under /api/: a GET-serving /api/* path reads as a public HTTP API to crawlers
// and readiness scanners. /md is an internal rewrite target, and robots.txt disallows it.
export const MARKDOWN_HANDLER_BASE = "/md";

export function markdownHandlerPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === ""
    ? MARKDOWN_HANDLER_BASE
    : `${MARKDOWN_HANDLER_BASE}${trimmed}`;
}

// The root is "/index.md", the spelling acceptmarkdown.com advertises in its own Link header.
export function markdownSiblingPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/index.md" : `${trimmed}.md`;
}

export function pathFromSlug(slug: string[] | undefined): string {
  return slug && slug.length > 0 ? `/${slug.join("/")}` : "/";
}

export function slugFromPath(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? [] : trimmed.split("/");
}
