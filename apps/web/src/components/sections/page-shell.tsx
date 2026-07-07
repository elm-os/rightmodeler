// Shared page frame for the marketing / SEO routes — the landing skeleton (app/page.tsx) with the
// section content swapped out: sticky nav (home-linked, as on nested routes), the framed max-w-6xl
// column with left/right hairline rules, a full-bleed horizontal rule, the footer, and the Dia-style
// overscroll gradient. (BlogShell is blog-specific and uses the wider max-w-7xl; this matches the
// marketing page's max-w-6xl.) data-overscroll-content is the hook OverscrollSpring translates on pull.

import type { ReactNode } from "react";
import { OverscrollSpring } from "@/components/overscroll-spring";
import { Footer } from "@/components/sections/footer";
import { Nav } from "@/components/sections/nav";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <>
      <span id="top" aria-hidden className="sr-only" />
      <Nav homeHref="/" />
      <main data-overscroll-content>
        <div className="mx-auto max-w-6xl border-x border-ash-border">
          {children}
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <Footer />
      </main>
      <OverscrollSpring />
    </>
  );
}
