import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { SocialLinks } from "@/components/sections/social-links";
import {
  GITHUB_ORG_URL,
  LINKEDIN_URL,
  REDDIT_URL,
  REPO_URL,
  SITE_NAME,
  SITE_URL,
  X_URL,
} from "@/lib/site";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "About",
  description:
    "rightmodeler measures cheaper candidates against outputs you accepted, then reports the evidence and abstentions. Open source, for multi-agent LLM teams.",
  path: "/about",
});

const organizationLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon.png`,
  description:
    "rightmodeler measures candidate models against accepted outputs on real traces, opens evidence-backed model-change pull requests, and watches every layer with Crucible.",
  sameAs: [X_URL, LINKEDIN_URL, REDDIT_URL, REPO_URL, GITHUB_ORG_URL],
};

const FAQ: FaqItem[] = [
  {
    q: "What is rightmodeler?",
    a: "An open-source tool for teams running multi-agent LLM systems. It replays your own traces through cheaper candidates, measures each result against the output you accepted, and reports the evidence, sample size, and abstentions before you approve a repo edit.",
  },
  {
    q: "Is it open source?",
    a: "Yes, MIT licensed. The rightmodeler skill is on GitHub and free to run, fork, and modify on your own traces today. rightmodeler agent, which opens evidence-backed swap PRs, and Crucible, the analytics and optimization suite, are the products being built on top of it.",
  },
  {
    q: "How is it different from observability or a gateway?",
    a: "Observability shows you problems; a runtime gateway intercepts live traffic. rightmodeler replays candidates against accepted outputs, reports the evidence and abstentions, and applies only the edits you approve. Nothing runs in your request path.",
  },
];

export default function AboutPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("About", "/about")} />
      <JsonLd data={organizationLd} />

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
            rightmodeler is an ELM-OS project. The skill is available today;
            rightmodeler agent, which ships swaps as pull requests, and
            Crucible, the analytics and optimization suite, are built on the
            same evidence loop and coming next.
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
