import { OverscrollSpring } from "@/components/overscroll-spring";
import { CtaBand } from "@/components/sections/cta-band";
import { Footer } from "@/components/sections/footer";
import { Hero } from "@/components/sections/hero";
import { Nav } from "@/components/sections/nav";
import { Platform } from "@/components/sections/platform";
import { SourcesBar } from "@/components/sections/sources-bar";

// The hero + works-with bar sit in a max-width column with left/right hairline rules, then the
// platform trio in its own framed block. Full-bleed horizontal rules (edge to edge) separate the
// blocks and bracket the CTA top and bottom; every block keeps its side rules, and the footer +
// overscroll gradient break out full-screen with no side rules.
// data-overscroll-content: at the absolute bottom, <OverscrollSpring/> eases this whole block UP to
// open the gradient beneath it (the nav is a sticky sibling and stays put).
export default function Home() {
  return (
    <>
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
          <CtaBand />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <Footer />
      </main>
      <OverscrollSpring />
    </>
  );
}
