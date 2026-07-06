// Shared page frame for the blog routes — reuses the landing skeleton verbatim (see app/page.tsx):
// sticky nav, the framed column with left/right hairline rules, full-bleed horizontal rules, footer,
// and the Dia-style overscroll gradient. The blog uses a wider max-w-7xl frame than the marketing
// page so it breathes more. data-overscroll-content is the hook OverscrollSpring translates on pull.

import type { ReactNode } from "react";
import { Nav } from "../sections/Nav";
import { Footer } from "../sections/Footer";
import { OverscrollSpring } from "../OverscrollSpring";

export function BlogShell({ children }: { children: ReactNode }) {
  return (
    <>
      <span id="top" aria-hidden className="sr-only" />
      <Nav homeHref="/" />
      <main data-overscroll-content>
        <div className="mx-auto max-w-7xl border-x border-ash-border">
          {children}
        </div>
        <div aria-hidden className="h-px w-full bg-ash-border" />
        <Footer />
      </main>
      <OverscrollSpring />
    </>
  );
}
