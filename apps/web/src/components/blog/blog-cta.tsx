// Closing call-to-action — mirrors the landing page cta-band so the blog ends on the same note the
// homepage does: the product's real first step as a copy-able command, one honest caveat, and the
// ink "View on GitHub" button. No new patterns, no accent hues; reuses CopyCommand and the exact
// button treatment from sections/cta-band.tsx.

import { CopyCommand } from "@/components/copy-command";
import { GitHubIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

export function BlogCta() {
  return (
    <section className="mx-auto max-w-2xl px-6 py-16 sm:px-8 sm:py-20">
      <div className="border-t border-ash-border pt-10">
        <Reveal>
          <h2 className="font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            Run it on your own traces.
          </h2>
        </Reveal>

        <Reveal
          delay={0.08}
          className="mt-8 flex w-full flex-col items-start gap-4"
        >
          <CopyCommand command={RUN_COMMAND} className="w-full sm:w-auto" />
          <p className="max-w-[34rem] pl-4 font-mono text-body text-driftwood">
            <span aria-hidden className="select-none text-fog">
              #{" "}
            </span>
            It is a report, not a runtime gateway. Prove the savings on your own
            data first.
          </p>
        </Reveal>

        <Reveal delay={0.16} className="mt-10">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:w-auto"
          >
            <GitHubIcon />
            View on GitHub
          </a>
        </Reveal>
      </div>
    </section>
  );
}
