// Native App Router sitemap (MetadataRoute.Sitemap) — home, the blog index, and every post, all
// resolved from the same post registry the routes use. Cached at build; regenerates when a post is
// added. No next-sitemap dependency: Next 16.3 has first-class support.

import type { MetadataRoute } from "next";
import { getAllPosts } from "@/content/blog";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  // Newest post date drives home + index freshness; falls back gracefully with no posts.
  const latest = posts[0]?.meta.date ?? "2026-01-01";

  const postEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${SITE_URL}/blog/${post.meta.slug}`,
    lastModified: post.meta.date,
    changeFrequency: "yearly",
    priority: 0.6,
    images: [`${SITE_URL}${post.meta.hero.src}`],
  }));

  // Static marketing / SEO pages. Priority ranks the core explainer highest; all share the site's
  // freshness date since they're maintained alongside it.
  const pageEntries: MetadataRoute.Sitemap = (
    [
      ["/how-it-works", 0.9],
      ["/agent", 0.9],
      ["/use-cases/reduce-llm-costs", 0.8],
      ["/case-study", 0.7],
      ["/case-study/bside", 0.8],
      ["/case-study/iam360", 0.8],
      ["/crucible", 0.8],
      ["/manifesto", 0.7],
      ["/glossary", 0.7],
      ["/about", 0.6],
      ["/feedback", 0.4],
      ["/privacy", 0.3],
      ["/terms", 0.3],
    ] as const
  ).map(([path, priority]) => ({
    url: `${SITE_URL}${path}`,
    lastModified: latest,
    changeFrequency: "monthly",
    priority,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: latest,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/blog`,
      lastModified: latest,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...pageEntries,
    ...postEntries,
  ];
}
