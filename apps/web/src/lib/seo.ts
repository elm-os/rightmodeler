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

// `alternates` replaces the layout's wholesale, so the /llms.txt and /humans.txt hints repeat here.
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

// The shared @id merges the Organization nodes on / (where verifiers look), /about and /contact
// into one entity. No postal address: the project does not publish one.
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
      "rightmodeler measures candidate models against accepted outputs on real traces, opens evidence-backed model-change pull requests, and is building Crucible to watch every layer.",
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

// `title` is unbranded: the layout template appends the brand, and the cards carry it in full.
// `image: null` leaves `images` out, since Next applies a route's opengraph-image file only then.
export function pageMetadata({
  title,
  description,
  path,
  image = DEFAULT_SOCIAL_IMAGE,
}: {
  title: string;
  description: string;
  path: string;
  image?: string | null;
}): Metadata {
  const branded = `${title} · ${SITE_NAME}`;
  const imageAlt =
    image === DEFAULT_SOCIAL_IMAGE
      ? "Keep your agents on the right model: rightmodeler"
      : `${branded} social preview`;
  const images =
    image === null ? {} : { images: [socialImage(image, imageAlt)] };
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
      ...images,
    },
    twitter: {
      card: "summary_large_image",
      title: branded,
      description,
      ...images,
    },
  };
}
