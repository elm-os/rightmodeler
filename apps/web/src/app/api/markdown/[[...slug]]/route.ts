// The Markdown representation of every page, per acceptmarkdown.com. Reached two ways, both of
// which land here so there is exactly one implementation:
//   - src/proxy.ts rewrites here when Accept prefers text/markdown
//   - next.config.ts rewrites /<path>.md here, regardless of Accept
//
// Never reads the request: doing so would opt this handler out of the prerender under Cache
// Components. Everything comes from params, so all ~44 representations are static.

import {
  allMarkdownPaths,
  getMarkdown,
  notFoundMarkdown,
} from "@/content/markdown";
import { pathFromSlug, slugFromPath } from "@/lib/markdown-routes";

export function generateStaticParams() {
  return allMarkdownPaths().map((path) => {
    // The completeness gate. A page that ships without a Markdown representation fails the
    // build here rather than 404ing for agents in production.
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
    // A real 404 with a Markdown body an agent can act on. This is a route handler returning a
    // literal Response, so the not-found.js streaming caveat does not apply: the status is
    // exactly what is written here.
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
