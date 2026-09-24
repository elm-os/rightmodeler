import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { SocialLinks } from "@/components/sections/social-links";
import { breadcrumbLd, organizationLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "About",
  description:
    "rightmodeler measures cheaper candidates against outputs you accepted, then reports the evidence and abstentions. Open source, for multi-agent LLM teams.",
  path: "/about",
});

const FAQ: FaqItem[] = [
  {
    q: "What is rightmodeler?",
    a: "An open-source tool for teams running multi-agent LLM systems. It replays your own traces through cheaper candidates, measures each result against the output you accepted, and reports the evidence, sample size, and abstentions before you approve a repo edit.",
  },
  {
    q: "Is it open source?",
    a: "Yes, MIT licensed. The rightmodeler CLI and rightmodeler agent are both in the public GitHub repo, free to run, fork, and modify. The CLI is on npm today. The agent is self-hosted today: you clone and build it, then run it on a long-lived Node 24 host with your own GitHub App and model credentials. A hosted version of the agent has a waitlist. Crucible, the analytics and optimization suite, is in development, also with a waitlist.",
  },
  {
    q: "How is it different from observability or a gateway?",
    a: "It answers a narrower question: which model each step of your agent needs. rightmodeler replays recorded steps through cheaper candidates, measures each against the output you accepted, and reports the evidence, sample size, and abstentions. A swap that clears every release gate becomes a draft pull request that changes only model identifiers, and a human reviews and merges it. It reads exported traces, so your observability tool stays in place, and it never sits in your request path the way a runtime gateway does.",
  },
];

export default function AboutPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("About", "/about")} />
      <JsonLd data={organizationLd()} />

      <PageHero
        eyebrow="About"
        title="About rightmodeler"
        lede="Measured evidence over guesswork, for the models your agents run on."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-16 sm:px-8 sm:py-20">
          <p className="text-subheading text-driftwood">
            rightmodeler is an open-source tool for teams running multi-agent
            LLM systems. It measures how closely cheaper candidates match the
            outputs you already accepted, one call at a time.
          </p>
          <p className="text-body text-driftwood">
            The mission is simple:{" "}
            <span className="font-medium text-midnight-ink">
              no model decision on vibes
            </span>
            . rightmodeler detects inefficient calls, measures candidates
            against what you already shipped, and reports the evidence, sample
            size, and abstentions before applying an edit you approve. A report
            and an edit, never a runtime gateway.
          </p>
          <p className="text-body text-driftwood">
            rightmodeler is an ELM-OS project. The CLI is on npm today.
            rightmodeler agent, which opens evidence-backed swaps as draft pull
            requests, is in the same MIT-licensed repo, and you can self-host it
            today; a hosted version has a waitlist. Crucible, the analytics and
            optimization suite built on the same evidence loop, is in
            development.
          </p>

          <div className="pt-2">
            <p className="font-mono text-caption uppercase text-fog">Find us</p>
            <SocialLinks className="mt-3 -ml-2.5" />
          </div>

          <div className="border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
                { href: "/manifesto", label: "Read the manifesto" },
                { href: "/agent", label: "rightmodeler agent" },
                { href: "/crucible", label: "Crucible" },
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
