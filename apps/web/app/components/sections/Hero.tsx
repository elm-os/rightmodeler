// The hero — a thesis, not a claim. Left-aligned editorial copy on a feathered parchment scrim
// over the HeroGradient (the only place the two accent hues live), with the star artifact below:
// a monochrome `cheaper-models · optimize` console (HeroFlow) that types the uv command, spins
// while it replays candidates, then resolves into a model-swap flow. Every figure is illustrative.

import { HeroGradient } from "../HeroGradient";
import { HeroFlow } from "../HeroFlow";
import { Reveal } from "../Reveal";
import { GitHubIcon, ArrowUpRightIcon } from "../icons";

export function Hero() {
  return (
    <section className="flex flex-1 flex-col bg-parchment-white">
      <div className="relative isolate flex flex-1 flex-col overflow-hidden">
        {/* Grain-gradient backdrop spans the full framed column, edge to edge. The two accent
            hues live only in here. */}
        <HeroGradient className="absolute inset-0 -z-10" />
        {/* Legibility veil — a parchment wash densest behind the top-left copy, fading into the
            gradient toward the bottom-right. Edge-to-edge, so it never reads as an inner panel. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(130% 115% at 24% 30%, rgba(253,252,252,0.82) 0%, rgba(253,252,252,0.34) 46%, rgba(253,252,252,0) 74%)",
          }}
        />

        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-16 sm:px-8 sm:py-20">
          <Reveal className="relative max-w-3xl">
            <div>
              <p className="tracking-tighter">
                ai doesn&apos;t have to be{" "}
                <span className="underline decoration-[#e5484d] decoration-wavy underline-offset-4">
                  expensive
                </span>
                .
              </p>

              <h1 className="mt-5 text-5xl tracking-tighter font-medium text-balance sm:text-6xl">
                Prove which models you can <span className="text-[#008000]">safely downgrade</span>.
              </h1>

              <p className="mt-6 max-w-2xl text-subheading tracking-tighter text-driftwood">
                rightmodeler replays your real agent traces through cheaper
                models, judges each output against what you already shipped, and
                shows exactly where you can cut cost — with evidence and
                confidence on every call.
              </p>

              {/* CTA row — the trivial first step (a copy-able command) plus a quiet repo link. */}
              <div className="mt-8 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                <a
                  href="https://github.com/elm-os/rightmodeler"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group inline-flex items-center rounded text-[13px] text-midnight-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
                >
                  <GitHubIcon size={15} />
                  <span className="tracking-tighter hover:underline">
                    view on github
                  </span>
                  <ArrowUpRightIcon className="transition-transform duration-200 ease-out-strong [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5 [@media(hover:hover)_and_(pointer:fine)]:group-hover:-translate-y-0.5" />
                </a>
              </div>
            </div>
          </Reveal>

          {/* ── The star artifact: the optimize console + model-swap flow ── */}
          <div className="mt-14 sm:mt-16">
            <HeroFlow />
          </div>
        </div>
      </div>
    </section>
  );
}
