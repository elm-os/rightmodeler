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

export const DEFAULT_SOCIAL_IMAGE = "/social/default.png";

export function socialImage(url: string, alt: string) {
  return {
    url,
    width: 1200,
    height: 630,
    type: "image/png",
    alt,
  };
}

// Page metadata in the house style: the layout template appends "· rightmodeler" to `title`; the
// OG/Twitter cards carry the fully-branded title and a large social image. `path` is the canonical
// route (e.g. "/how-it-works"); lower-priority pages fall back to the site-wide social card.
export function pageMetadata({
  title,
  description,
  path,
  image = DEFAULT_SOCIAL_IMAGE,
}: {
  title: string;
  description: string;
  path: string;
  image?: string;
}): Metadata {
  const branded = `${title} · ${SITE_NAME}`;
  const imageAlt =
    image === DEFAULT_SOCIAL_IMAGE
      ? "Keep your agents on the right model: rightmodeler"
      : `${branded} social preview`;
  const preview = socialImage(image, imageAlt);
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
      images: [preview],
    },
    twitter: {
      card: "summary_large_image",
      title: branded,
      description,
      images: [preview],
    },
  };
}
