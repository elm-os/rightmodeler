import { Nav } from "./components/sections/Nav";
import { Hero } from "./components/sections/Hero";
import { SourcesBar } from "./components/sections/SourcesBar";
import { CtaBand } from "./components/sections/CtaBand";
import { Footer } from "./components/sections/Footer";
import { OverscrollSpring } from "./components/OverscrollSpring";

// The hero + works-with bar sit in a max-width column with left/right hairline rules. Full-bleed
// horizontal rules (edge to edge) bracket the CTA top and bottom; the CTA keeps its side rules, and
// the footer + overscroll gradient break out full-screen with no side rules.
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
          <CtaBand />
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <Footer />
      </main>
      <OverscrollSpring />
    </>
  );
}
