// The closing colophon — the report's sign-off. Clean by default (no gradient): Dia Browser's
// signature gradient lives in <OverscrollSpring/> and only rises up from the floor when you pull
// past the absolute bottom of the page (the whole page eases up to expose it), then snaps back.
// Server component: it composes client primitives only.

import { Reveal } from "../Reveal";
import { GitHubIcon, LogoMark } from "../icons";

const linkClass =
  "rounded-sm text-driftwood transition-colors duration-150 ease-out hover:text-midnight-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midnight-ink focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

export function Footer() {
  return (
    <footer className="px-6 pt-16 pb-20 sm:px-10 sm:pt-24 sm:pb-24">
      <div className="mx-auto w-full max-w-4xl">
        <Reveal className="border-t border-ash-border pt-8">
          <h2 className="max-w-xl text-balance font-display text-heading text-midnight-ink sm:text-heading-lg lg:text-display">
            A recommendation report, not a runtime gateway.
          </h2>
          <p className="mt-5 max-w-md text-body text-driftwood">
            Proven on your own traces — you decide what to swap, and when.
          </p>
        </Reveal>

        <Reveal
          delay={0.07}
          className="mt-12 flex flex-wrap items-center justify-between gap-x-8 gap-y-5"
        >
          <span className="inline-flex items-center gap-2 text-midnight-ink">
            <LogoMark height={18} />
            <span className="wordmark">rightmodeler</span>
          </span>
          <nav aria-label="Footer" className="text-body">
            <a
              href="https://github.com/elm-os/rightmodeler"
              target="_blank"
              rel="noreferrer"
              className={`${linkClass} inline-flex items-center gap-1.5`}
            >
              <GitHubIcon size={16} />
              GitHub
              <span aria-hidden>↗</span>
            </a>
          </nav>
        </Reveal>

        <Reveal delay={0.14} className="mt-10 space-y-1.5">
          <p className="font-mono text-caption text-driftwood">
            Every figure shown on this page is an illustrative example — not
            measured savings.
          </p>
          <p className="font-mono text-caption text-fog">
            cheaper-models · © 2026 rightmodeler · an ELM-OS project
          </p>
        </Reveal>
      </div>
    </footer>
  );
}
