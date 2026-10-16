import { CopyCommand } from "@/components/copy-command";
import { HeroGradient } from "@/components/hero-gradient";
import { GitHubIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

// Legibility veil: parchment densest behind the top-left copy, fading into the gradient.
const VEIL =
  "radial-gradient(130% 120% at 22% 34%, rgba(253,252,252,0.84) 0%, rgba(253,252,252,0.36) 48%, rgba(253,252,252,0) 76%)";

export function CtaBand() {
  return (
    <section className="relative isolate overflow-hidden bg-parchment-white">
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
            <CopyCommand command={RUN_COMMAND} className="w-full sm:w-auto" />
          </Reveal>

          <Reveal delay={0.16} className="mt-10">
            <a
              href={REPO_URL}
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
