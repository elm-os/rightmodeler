import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { OverscrollSpring } from "@/components/overscroll-spring";
import { CtaBand } from "@/components/sections/cta-band";
import { Footer } from "@/components/sections/footer";
import { Hero } from "@/components/sections/hero";
import { Nav } from "@/components/sections/nav";
import { NumbersBand } from "@/components/sections/numbers-band";
import { Platform } from "@/components/sections/platform";
import { SourcesBar } from "@/components/sections/sources-bar";
import { TestimonialBand } from "@/components/sections/testimonial-band";
import { ThesisBand } from "@/components/sections/thesis-band";
import {
  alternatesFor,
  DEFAULT_SOCIAL_IMAGE,
  organizationLd,
  ORGANIZATION_ID,
  socialImage,
} from "@/lib/seo";
import {
  DOCS_URL,
  LICENSE_URL,
  NPM_PACKAGE_URL,
  REPO_URL,
  SITE_NAME,
  SITE_URL,
} from "@/lib/site";

// Canonical strings from docs/positioning.md. The hero h1 is an opinion and never a title here.
const title = "rightmodeler: cheaper model swaps, validated on your traces";
const description =
  "The bottleneck is the human work in the loop. rightmodeler validates cheaper models on your production traces and opens a draft pull request for your review.";
const preview = socialImage(
  DEFAULT_SOCIAL_IMAGE,
  "Take the work out of the loop: rightmodeler",
);
const websiteLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
};

// Only facts that hold today, with no version pin to go stale and no ratings.
const softwareLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  // The one-liner: it describes the software, where the page description argues the thesis.
  description:
    "Cheaper model swaps for production AI, validated on your own traces and opened as draft PRs.",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  softwareRequirements: "Node.js 24 or newer",
  url: SITE_URL,
  installUrl: NPM_PACKAGE_URL,
  downloadUrl: NPM_PACKAGE_URL,
  codeRepository: REPO_URL,
  license: LICENSE_URL,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  softwareHelp: {
    "@type": "CreativeWork",
    name: "rightmodeler CLI documentation",
    url: DOCS_URL,
  },
  publisher: { "@id": ORGANIZATION_ID },
  sameAs: [NPM_PACKAGE_URL, REPO_URL],
};

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: alternatesFor("/"),
  openGraph: {
    title,
    description,
    url: "https://www.rightmodeler.com",
    siteName: "rightmodeler",
    locale: "en_US",
    type: "website",
    images: [preview],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [preview],
  },
};

// data-overscroll-content is the hook OverscrollSpring translates on pull.
export default function Home() {
  return (
    <>
      <JsonLd data={websiteLd} />
      <JsonLd data={organizationLd()} />
      <JsonLd data={softwareLd} />
      <span id="top" aria-hidden className="sr-only" />
      <Nav />
      <main data-overscroll-content>
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <Hero />
          <SourcesBar />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        {/* The thesis closer defines "safe", so it must sit directly above Platform's h2. */}
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <ThesisBand />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <Platform />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <NumbersBand />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <TestimonialBand />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <CtaBand />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <Footer />
      </main>
      <OverscrollSpring />
    </>
  );
}
