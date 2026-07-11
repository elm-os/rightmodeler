// The closing colophon — the report's sign-off. Clean by default (no gradient): Dia Browser's
// signature gradient lives in <OverscrollSpring/> and only rises up from the floor when you pull
// past the absolute bottom of the page (the whole page eases up to expose it), then snaps back.
// Server component: it composes client primitives only.

import Link from "next/link";
import { LogoMark } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { SocialLinks } from "@/components/sections/social-links";

const linkClass =
  "rounded-sm text-driftwood transition-colors duration-150 ease-out hover:text-midnight-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midnight-ink focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

export function Footer() {
  return (
    <footer className="px-6 pt-16 pb-20 sm:px-10 sm:pt-24 sm:pb-24">
      <div className="mx-auto w-full max-w-4xl">
        <Reveal className="border-t border-ash-border pt-8">
          <h2 className="max-w-xl text-balance font-display text-heading text-midnight-ink sm:text-heading-lg lg:text-display">
            Every step, on the right model. Proven, not guessed.
          </h2>
          <p className="mt-5 max-w-md text-body text-driftwood">
            The skill proves it on your traces today. The agent ships it as a
            pull request. Crucible keeps watch.
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
          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center gap-x-6 gap-y-3 text-body"
          >
            <Link href="/how-it-works" className={linkClass}>
              How it works
            </Link>
            <Link href="/use-cases/reduce-llm-costs" className={linkClass}>
              Use cases
            </Link>
            <Link href="/manifesto" className={linkClass}>
              Manifesto
            </Link>
            <Link href="/glossary" className={linkClass}>
              Glossary
            </Link>
            <Link href="/agent" className={linkClass}>
              Agent
            </Link>
            <Link href="/crucible" className={linkClass}>
              Crucible
            </Link>
            <Link href="/about" className={linkClass}>
              About
            </Link>
            <Link href="/blog" className={linkClass}>
              Blog
            </Link>
            <Link href="/feedback" className={linkClass}>
              Feedback
            </Link>
            <SocialLinks className="-ml-2" />
          </nav>
        </Reveal>

        <Reveal delay={0.14} className="mt-10 space-y-1.5">
          <nav
            aria-label="Legal"
            className="flex flex-wrap gap-x-5 gap-y-2 pb-1"
          >
            <Link
              href="/privacy"
              className={`font-mono text-caption ${linkClass}`}
            >
              Privacy policy
            </Link>
            <Link
              href="/terms"
              className={`font-mono text-caption ${linkClass}`}
            >
              Terms of service
            </Link>
          </nav>
          <p className="font-mono text-caption text-driftwood">
            Every figure shown on this page is an illustrative example, not
            measured savings.
          </p>
          <p className="font-mono text-caption text-fog">
            rightmodeler · © 2026 rightmodeler · an ELM-OS project
          </p>
        </Reveal>
      </div>
    </footer>
  );
}
