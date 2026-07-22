import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { OverscrollSpring } from "@/components/overscroll-spring";
import { CtaBand } from "@/components/sections/cta-band";
import { Footer } from "@/components/sections/footer";
import { Hero } from "@/components/sections/hero";
import { Nav } from "@/components/sections/nav";
import { Platform } from "@/components/sections/platform";
import { SourcesBar } from "@/components/sections/sources-bar";
import { TestimonialBand } from "@/components/sections/testimonial-band";
import { DEFAULT_SOCIAL_IMAGE, socialImage } from "@/lib/seo";
import { SITE_NAME, SITE_URL } from "@/lib/site";

const description =
  "Keep your agents on the right model: prove safe swaps from your real traces, ship model upgrades as evidence-backed PRs, and watch every layer with Crucible.";
const preview = socialImage(
  DEFAULT_SOCIAL_IMAGE,
  "Keep your agents on the right model: rightmodeler",
);
const websiteLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
};

export const metadata: Metadata = {
  title: {
    absolute: "rightmodeler: prove which models you can safely downgrade",
  },
  description,
  alternates: { canonical: "/" },
  openGraph: {
    title: "rightmodeler",
    description,
    url: "https://www.rightmodeler.com",
    siteName: "rightmodeler",
    locale: "en_US",
    type: "website",
    images: [preview],
  },
  twitter: {
    card: "summary_large_image",
    title: "rightmodeler",
    description,
    images: [preview],
  },
};

// The hero + works-with bar sit in a max-width column with left/right hairline rules, then the
// platform trio in its own framed block. Full-bleed horizontal rules (edge to edge) separate the
// blocks and bracket the CTA top and bottom; every block keeps its side rules, and the footer +
// overscroll gradient break out full-screen with no side rules.
// data-overscroll-content: at the absolute bottom, <OverscrollSpring/> eases this whole block UP to
// open the gradient beneath it (the nav is a sticky sibling and stays put).
export default function Home() {
  return (
    <>
      <JsonLd data={websiteLd} />
      <span id="top" aria-hidden className="sr-only" />
      <Nav />
      <main data-overscroll-content>
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <Hero />
          <SourcesBar />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          <Platform />
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
