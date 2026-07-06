// Final call-to-action band — the full-bleed break in the framed column, carrying the SAME
// grain-gradient effect as the hero so the page opens and closes on the same note. Legibility
// comes from a parchment veil (as in the hero), not a boxed panel. Strictly monochrome content;
// the accent hues live only inside the gradient. Server component — it composes the client
// primitives (HeroGradient, Reveal, CopyCommand).

import { CopyCommand } from "@/components/copy-command";
import { HeroGradient } from "@/components/hero-gradient";
import { GitHubIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";

// Legibility veil — parchment densest behind the top-left copy, fading into the gradient. Same
// treatment as the hero, so it never reads as a card.
const VEIL =
  "radial-gradient(130% 120% at 22% 34%, rgba(253,252,252,0.84) 0%, rgba(253,252,252,0.36) 48%, rgba(253,252,252,0) 76%)";

export function CtaBand() {
  return (
    <section className="relative isolate overflow-hidden bg-parchment-white">
      {/* Same grain-gradient effect as the hero. */}
      <HeroGradient className="absolute inset-0 -z-10" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: VEIL }}
      />

      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-32">
        <div className="max-w-2xl">
          <Reveal>
            <h2 className="font-display text-heading text-balance text-midnight-ink sm:text-display">
              Run it on your own traces.
            </h2>
          </Reveal>

          <Reveal
            delay={0.08}
            className="mt-8 flex w-full flex-col items-start gap-4"
          >
            <CopyCommand
              command="uv run python -m pipeline ingest"
              className="w-full sm:w-auto"
            />

            <p className="max-w-[34rem] pl-4 font-mono text-body text-driftwood">
              <span aria-hidden className="select-none text-fog">
                #{" "}
              </span>
              It’s a report, not a runtime gateway — prove the savings on your
              own data first.
            </p>
          </Reveal>

          <Reveal delay={0.16} className="mt-10">
            <a
              href="https://github.com/elm-os/rightmodeler"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:w-auto"
            >
              <GitHubIcon />
              View on GitHub
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
