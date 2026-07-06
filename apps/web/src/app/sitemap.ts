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
    ...postEntries,
  ];
}
