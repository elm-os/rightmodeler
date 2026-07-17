import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { CrucibleShowcase } from "@/components/sections/crucible-showcase";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { WaitlistForm } from "@/components/sections/waitlist-form";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Crucible (coming soon)",
  description:
    "Crucible is the analytics and optimization suite for your AI agents: cost per layer, speed per step, failures as they happen, and a model stack that keeps itself right-sized. Join the waitlist.",
  path: "/crucible",
  image: "/social/crucible.png",
});

const FAQ: FaqItem[] = [
  {
    q: "What is Crucible?",
    a: "Crucible is the analytics and optimization suite for AI agents, by rightmodeler. It shows what every layer of your agent system costs, how fast it runs, and where it fails, and it runs the rightmodeler proof loop continuously so your model stack stays right-sized as new traces arrive.",
  },
  {
    q: "When can I use it?",
    a: "Crucible is in active development. Join the waitlist and we'll send an early-access note when it opens. The engine behind it, the rightmodeler skill, is available now on GitHub.",
  },
  {
    q: "How does it connect?",
    a: "Over MCP, using the tracing you already emit, with no new SDK. You keep your own API keys and can route through OpenRouter, the Vercel AI Gateway, or LiteLLM.",
  },
  {
    q: "Is it a gateway?",
    a: "No. Crucible reads your traces passively and never sits in your request path. Your traffic keeps flowing through your own keys and routes; Crucible watches, measures, and proves.",
  },
];

export default function CruciblePage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Crucible", "/crucible")} />

      <PageHero
        eyebrow="Coming soon · by rightmodeler"
        title="Crucible: every layer, measured and right-sized."
        lede="The analytics and optimization suite for your AI agents. See what every layer costs, how fast it runs, and where it fails, while Crucible keeps your model stack right-sized, continuously."
      >
        <div className="max-w-md">
          <WaitlistForm />
          <p className="mt-3 font-mono text-caption text-fog">
            Get early access. One note when it opens, no spam.
          </p>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 pt-16 sm:px-10 sm:pt-20">
          <Reveal>
            <Tldr>
              Crucible watches your agents in production: cost per layer, speed
              per step,{" "}
              <span className="text-midnight-ink">failures as they happen</span>
              . And because it runs the rightmodeler proof loop continuously, it
              does not just show you problems, it right-sizes the stack that
              caused them.
            </Tldr>
          </Reveal>
        </div>

        {/* The feature wall runs the full framed column, wider than the prose bands around it,
            the same move as the /agent feature spread. */}
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <Reveal>
            <CrucibleShowcase />
          </Reveal>
        </div>

        <div className="mx-auto max-w-3xl px-6 pb-16 sm:px-10 sm:pb-20">
          {/* Closing note as a quiet surface card, echoing the wall's card language above. */}
          <Reveal delay={0.1}>
            <div className="rounded-2xl border border-ash-border bg-warm-sand p-6 sm:p-8">
              <p className="font-mono text-caption uppercase text-fog">
                Available today
              </p>
              <p className="mt-3 max-w-xl text-body text-driftwood">
                Crucible is in active development. The engine behind it, the
                rightmodeler skill, is available now on GitHub.
              </p>
              <div className="mt-6">
                <GithubButton />
              </div>
            </div>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How the proof works" },
                { href: "/agent", label: "rightmodeler agent, the PR writer" },
                { href: "/manifesto", label: "Read the manifesto" },
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
