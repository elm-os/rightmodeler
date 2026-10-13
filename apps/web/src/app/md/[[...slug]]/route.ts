// Reached by rewrite: src/proxy.ts when Accept prefers Markdown, next.config.ts for /<path>.md.
// Never read the request: that opts this handler out of the prerender under Cache Components.

import {
  allMarkdownPaths,
  getMarkdown,
  notFoundMarkdown,
} from "@/content/markdown";
import { pathFromSlug, slugFromPath } from "@/lib/markdown-routes";

export function generateStaticParams() {
  return allMarkdownPaths().map((path) => {
    // The completeness gate: a page without a Markdown representation fails the build here.
    if (!getMarkdown(path)) {
      throw new Error(
        `No Markdown representation for ${path}. Add a co-located markdown export in ` +
          `src/content/pages, or a renderer in src/content/markdown.`,
      );
    }
    return { slug: slugFromPath(path) };
  });
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await ctx.params;
  const path = pathFromSlug(slug);
  const markdown = getMarkdown(path);

  if (!markdown) {
    // A literal Response, so the not-found.js streaming caveat does not apply: this is a real 404.
    return new Response(notFoundMarkdown(path), {
      status: 404,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        vary: "Accept",
        "cache-control": "public, max-age=0, s-maxage=60",
      },
    });
  }

  return new Response(markdown, {
    headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept" },
  });
}
