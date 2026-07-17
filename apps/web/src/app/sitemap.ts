// Native App Router sitemap, resolved from the same post and integration registries the routes use.
// Omit lastmod until the content sources track modification time separately from publication time.

import type { MetadataRoute } from "next";
import { getAllPosts } from "@/content/blog";
import { getAllIntegrations } from "@/content/integrations";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();

  const postEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${SITE_URL}/blog/${post.meta.slug}`,
    images: [`${SITE_URL}${post.meta.hero.src}`],
  }));

  // Integration pages, resolved from the same registry the /integrations routes use.
  const integrationEntries: MetadataRoute.Sitemap = getAllIntegrations().map(
    (integration) => ({
      url: `${SITE_URL}/integrations/${integration.slug}`,
    }),
  );

  const pageEntries: MetadataRoute.Sitemap = [
    "/how-it-works",
    "/agent",
    "/use-cases/reduce-llm-costs",
    "/integrations",
    "/crucible",
    "/manifesto",
    "/glossary",
    "/about",
    "/privacy",
    "/terms",
  ].map((path) => ({
    url: `${SITE_URL}${path}`,
  }));

  return [
    { url: SITE_URL },
    { url: `${SITE_URL}/blog` },
    ...pageEntries,
    ...integrationEntries,
    ...postEntries,
  ];
}
