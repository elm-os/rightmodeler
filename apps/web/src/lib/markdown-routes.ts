// Path arithmetic for the Markdown representation, shared by src/proxy.ts, the markdown route
// handler, src/lib/seo.ts, and scripts/markdown.test.mjs. Import-free so the tests can load it
// directly under Node's type stripping.

// Routes whose page is a one-off rather than a member of a templated family. Templated families
// (/blog/[slug], /vs/[slug], /integrations/[slug]) resolve from their own registries instead, so
// adding a page to a family never touches this list. scripts/markdown.test.mjs walks src/app and
// fails if a page.tsx exists that is not accounted for here or by a family.
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

export const MARKDOWN_HANDLER_BASE = "/api/markdown";

// "/about" -> "/api/markdown/about"; "/" -> "/api/markdown"
export function markdownHandlerPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === ""
    ? MARKDOWN_HANDLER_BASE
    : `${MARKDOWN_HANDLER_BASE}${trimmed}`;
}

// "/about" -> "/about.md"; "/" -> "/index.md". The root spelling matches the convention
// acceptmarkdown.com itself advertises in its Link: rel="alternate" header.
export function markdownSiblingPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/index.md" : `${trimmed}.md`;
}

// The reverse of markdownHandlerPath, for the route handler's catch-all segments.
export function pathFromSlug(slug: string[] | undefined): string {
  return slug && slug.length > 0 ? `/${slug.join("/")}` : "/";
}

export function slugFromPath(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? [] : trimmed.split("/");
}
