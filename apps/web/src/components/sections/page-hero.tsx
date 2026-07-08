// Shared masthead for the marketing / SEO pages — the landing hero's opening move distilled to a
// reusable header: an optional grain-gradient backdrop under a parchment legibility veil (identical
// to sections/hero.tsx and blog/page.tsx, so every page reads as one system), a mono eyebrow, the
// page's single <h1> in the display face, an optional subheading lede, and an optional CTA slot.
// Server component — it composes the client primitives (HeroGradient, Reveal).

import type { ReactNode } from "react";
import { HeroGradient } from "@/components/hero-gradient";
import { Reveal } from "@/components/reveal";

// Same veil as the landing hero — parchment densest behind the top-left copy, fading into the
// gradient toward the bottom-right, so it never reads as a boxed panel.
const VEIL =
  "radial-gradient(130% 115% at 24% 30%, rgba(253,252,252,0.82) 0%, rgba(253,252,252,0.34) 46%, rgba(253,252,252,0) 74%)";

export function PageHero({
  eyebrow,
  title,
  lede,
  gradient = true,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  gradient?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="relative isolate overflow-hidden bg-parchment-white">
      {gradient && (
        <>
          <HeroGradient className="absolute inset-0 -z-10" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{ background: VEIL }}
          />
        </>
      )}

      <div className="mx-auto max-w-3xl px-6 py-20 sm:px-10 sm:py-28">
        <Reveal>
          <p className="font-mono text-caption uppercase text-fog">{eyebrow}</p>
          <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
            {title}
          </h1>
          {lede && (
            <p className="mt-6 max-w-2xl text-subheading text-driftwood">
              {lede}
            </p>
          )}
          {children && <div className="mt-8">{children}</div>}
        </Reveal>
      </div>
    </section>
  );
}
