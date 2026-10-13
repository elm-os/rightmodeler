// data-overscroll-content is the hook OverscrollSpring translates on pull.

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
