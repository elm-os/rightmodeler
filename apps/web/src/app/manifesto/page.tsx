import type { Metadata } from "next";
import Link from "next/link";
import { Lead, P, PullQuote } from "@/components/blog/prose";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Prove it. Don't guess.",
  description:
    "The rightmodeler manifesto: nobody should downgrade a model on vibes. The case for evidence-backed model downgrading, proven on your own traces, not benchmarks.",
  path: "/manifesto",
});

const FAQ: FaqItem[] = [
  {
    q: "What is evidence-backed model downgrading?",
    a: "Moving a step to a cheaper model only after proving, on your own traces, that quality holds against the output you already shipped. The decision is backed by evidence: replays, scores, and a confidence level, not a benchmark or a hunch.",
  },
  {
    q: "How is this different from observability?",
    a: "Observability shows you what happened. It doesn't replay your steps through cheaper models, judge the results, or change anything. rightmodeler proves a specific swap is safe and applies it in your repo: detect, prove, fix.",
  },
  {
    q: "Is it safe to downgrade automatically?",
    a: "rightmodeler never swaps on its own. It abstains when the evidence is weak, flags cascade risk, and leaves the final call, and the repo edit, to you.",
  },
];

export default function ManifestoPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Manifesto", "/manifesto")} />

      <PageHero
        eyebrow="Manifesto"
        title="Prove it. Don't guess."
        lede="A model downgrade is a real decision. It deserves evidence, not a vibe."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white py-16 sm:py-20">
        <div className="mx-auto max-w-2xl space-y-8 px-6 sm:px-8">
          <Tldr>
            Nobody should downgrade a model on vibes. Prove it on{" "}
            <span className="text-midnight-ink">your own traces</span>:
            replayed, judged against what you shipped, and applied only when the
            evidence holds.
          </Tldr>

          <div className="space-y-6">
            <Lead>
              Frontier models are the default, and the default is
              over-provisioned. Teams reach for the biggest model on every step
              because it feels like the safe choice, then a quiet downgrade
              ships and quality slips where no one is watching. The cost is
              real; the regression is invisible.
            </Lead>

            <P>
              Evidence beats vibes. You shouldn&apos;t downgrade because a
              leaderboard liked a model, or keep an expensive one because
              switching feels risky. The only proof that counts is your own
              traces: the same inputs you already ran, judged against the output
              you already shipped.
            </P>

            <PullQuote>Nobody should downgrade a model on vibes.</PullQuote>

            <P>
              So we&apos;re building a category:{" "}
              <span className="font-medium text-midnight-ink">
                evidence-backed model downgrading
              </span>
              . Detect the inefficient call, prove the safe swap on your data,
              apply the fix in your repo. rightmodeler does it as a report you
              run today; Crucible will do it continuously, as your traces
              arrive.
            </P>
          </div>

          <div className="flex flex-col items-start gap-5 border-t border-ash-border pt-8 sm:flex-row sm:items-center">
            <GithubButton />
            <Link
              href="/how-it-works"
              className="text-body text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
            >
              See how it works
            </Link>
          </div>

          <div className="border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
                { href: "/crucible", label: "Crucible (coming soon)" },
                { href: "/glossary", label: "Glossary" },
              ]}
            />
          </div>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <Faq items={FAQ} />
    </PageShell>
  );
}
