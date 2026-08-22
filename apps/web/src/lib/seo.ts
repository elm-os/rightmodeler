// Small structured-data + metadata helpers shared by the marketing / SEO pages, so schema.org markup
// and canonical URLs stay consistent with the blog's pattern (see app/blog/[slug]/page.tsx).

import type { Metadata } from "next";
import {
  CONTACT_EMAIL,
  GITHUB_ORG_URL,
  ISSUES_NEW_URL,
  LINKEDIN_URL,
  NPM_PACKAGE_URL,
  REDDIT_URL,
  REPO_URL,
  SECURITY_URL,
  SITE_NAME,
  SITE_URL,
  X_URL,
} from "@/lib/site";
import { markdownSiblingPath } from "@/lib/markdown-routes";

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

// Discovery hints for the alternate representations of a page. `alternates` replaces the object
// wholesale rather than merging with the layout's, so the plain-text entries have to be repeated
// here: without them the layout's /llms.txt and /humans.txt hints reach no real page.
// text/markdown points at the .md sibling; the same content is also reachable at this URL via
// Accept negotiation (see src/proxy.ts).
export function alternatesFor(
  path: string,
): NonNullable<Metadata["alternates"]> {
  return {
    canonical: path,
    types: {
      "text/markdown": [
        { url: markdownSiblingPath(path), title: "This page as Markdown" },
      ],
      "text/plain": [
        { url: "/llms.txt", title: "llms.txt" },
        { url: "/humans.txt", title: "humans.txt" },
      ],
    },
  };
}

// The one Organization node for the whole graph. Emitted on the home page (where verifiers look)
// and on /about and /contact; the shared @id merges them into a single entity instead of reading
// as three organizations. No postal address: the project does not publish one, and a fabricated
// address is worse than none.
export const ORGANIZATION_ID = `${SITE_URL}/#organization`;

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icon.png`,
    email: CONTACT_EMAIL,
    description:
      "rightmodeler measures candidate models against accepted outputs on real traces, opens evidence-backed model-change pull requests, and watches every layer with Crucible.",
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: CONTACT_EMAIL,
        url: `${SITE_URL}/contact`,
        availableLanguage: "English",
      },
      {
        "@type": "ContactPoint",
        contactType: "technical support",
        email: CONTACT_EMAIL,
        url: ISSUES_NEW_URL,
        availableLanguage: "English",
      },
      {
        "@type": "ContactPoint",
        contactType: "security",
        email: CONTACT_EMAIL,
        url: SECURITY_URL,
        availableLanguage: "English",
      },
    ],
    sameAs: [
      X_URL,
      LINKEDIN_URL,
      REDDIT_URL,
      REPO_URL,
      GITHUB_ORG_URL,
      NPM_PACKAGE_URL,
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
    alternates: alternatesFor(path),
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
