// Small structured-data + metadata helpers shared by the marketing / SEO pages, so schema.org markup
// and canonical URLs stay consistent with the blog's pattern (see app/blog/[slug]/page.tsx).

import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

// BreadcrumbList JSON-LD for a top-level page: Home → this page.
export function breadcrumbLd(name: string, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name, item: `${SITE_URL}${path}` },
    ],
  };
}

// Page metadata in the house style: the layout template appends "— rightmodeler" to `title`; the
// OG/Twitter cards carry the fully-branded title. Twitter card is `summary` (no per-page OG image),
// matching the home page. `path` is the canonical route (e.g. "/how-it-works").
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const branded = `${title} · ${SITE_NAME}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      title: branded,
      description,
      url: `${SITE_URL}${path}`,
      siteName: SITE_NAME,
    },
    twitter: {
      card: "summary",
      title: branded,
      description,
    },
  };
}
