// The /md route handler throws at build time for any known route getMarkdown leaves undefined.

import { getPost } from "@/content/blog";
import {
  getAllSlugs as getIntegrationSlugs,
  getIntegration,
} from "@/content/integrations";
import { getAllSlugs as getVsSlugs, getComparison } from "@/content/vs";
import { getAllSlugs as getBlogSlugs } from "@/content/blog";
import { renderIntegrationMarkdown } from "@/content/markdown/render-integration";
import { renderVsMarkdown } from "@/content/markdown/render-vs";
import {
  renderBlogIndexMarkdown,
  renderCaseStudyIndexMarkdown,
  renderIntegrationsIndexMarkdown,
  renderVsIndexMarkdown,
} from "@/content/markdown/render-hub";
import { PAGE_MARKDOWN } from "@/content/pages";
import { STATIC_MARKDOWN_PATHS } from "@/lib/markdown-routes";
import { SITE_URL } from "@/lib/site";

const HUBS: Record<string, () => string> = {
  "/blog": renderBlogIndexMarkdown,
  "/vs": renderVsIndexMarkdown,
  "/integrations": renderIntegrationsIndexMarkdown,
  "/case-study": renderCaseStudyIndexMarkdown,
};

// The Markdown stand-in for a canonical link, in the format buildLlmsContext() already uses.
function withSource(path: string, body: string): string {
  return `Source: ${SITE_URL}${path}\n\n${body}\n`;
}

export function getMarkdown(pathname: string): string | undefined {
  const path = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");

  const hub = HUBS[path];
  if (hub) return withSource(path, hub());

  const segments = path.slice(1).split("/");
  if (segments.length === 2) {
    const [family, slug] = segments;
    if (family === "blog") {
      const post = getPost(slug);
      if (post) return withSource(path, post.markdown.trim());
    }
    if (family === "vs") {
      const comparison = getComparison(slug);
      if (comparison)
        return withSource(path, renderVsMarkdown(comparison, SITE_URL));
    }
    if (family === "integrations") {
      const integration = getIntegration(slug);
      if (integration)
        return withSource(path, renderIntegrationMarkdown(integration));
    }
  }

  const page = PAGE_MARKDOWN[path];
  if (page) return withSource(path, page.trim());

  return undefined;
}

export function allMarkdownPaths(): string[] {
  return [
    ...STATIC_MARKDOWN_PATHS,
    ...getBlogSlugs().map((slug) => `/blog/${slug}`),
    ...getVsSlugs().map((slug) => `/vs/${slug}`),
    ...getIntegrationSlugs().map((slug) => `/integrations/${slug}`),
  ];
}

export function notFoundMarkdown(pathname: string): string {
  return `# 404: not found

There is no page at \`${pathname}\` on rightmodeler.

## Where to go instead

- [Site index for language models](${SITE_URL}/llms.txt)
- [Full site context, one file](${SITE_URL}/llms-context.txt)
- [Sitemap](${SITE_URL}/sitemap.xml)
- [Home](${SITE_URL}/)
- [How it works](${SITE_URL}/how-it-works)
- [Integrations](${SITE_URL}/integrations)
- [Comparisons](${SITE_URL}/vs)
- [Case studies](${SITE_URL}/case-study)
- [Blog](${SITE_URL}/blog)
- [Contact](${SITE_URL}/contact)

Every page is available as Markdown: append \`.md\` to any path, or send \`Accept: text/markdown\`.
`;
}
