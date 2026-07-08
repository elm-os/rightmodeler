import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { SITE_URL } from "@/lib/site";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Glossary",
  description:
    "The model-downgrade glossary: plain definitions for evidence-backed model downgrading, quality floor, cascade risk, abstain, reference evidence, LLM-as-judge, and more.",
  path: "/glossary",
});

// Each term is anchor-linkable (#slug) so it can be cited directly; the DefinedTermSet + FAQPage
// JSON-LD below is generated from this same list, so structured data always matches the page.
const TERMS: { term: string; slug: string; def: string }[] = [
  {
    term: "Evidence-backed model downgrading",
    slug: "evidence-backed-model-downgrading",
    def: "Moving a step to a cheaper model only after proving, on your own traces, that quality holds against the output you already shipped. The decision rests on replays and scores, not a benchmark or a hunch.",
  },
  {
    term: "Model downgrade audit",
    slug: "model-downgrade-audit",
    def: "A pass over your traces that checks, step by step, which model calls could move to a cheaper model without losing quality, and which can't.",
  },
  {
    term: "Downgrade-safe",
    slug: "downgrade-safe",
    def: "A step whose cheaper-model output holds up against the shipped reference with enough evidence and confidence to swap. The opposite of a step the audit abstains on.",
  },
  {
    term: "Quality floor",
    slug: "quality-floor",
    def: "The minimum quality score a downgrade must clear to be recommended; below it, the frontier model stays. rightmodeler's default is 0.90, and it's configurable.",
  },
  {
    term: "Cascade risk",
    slug: "cascade-risk",
    def: "The chance that downgrading one step degrades later steps that depend on it, common in tool and loop steps. It's flagged so a local win doesn't cause a downstream regression.",
  },
  {
    term: "Abstain",
    slug: "abstain",
    def: "The audit's decision to make no recommendation when the evidence is too weak to prove a swap is safe. A tool that always finds savings isn't measuring anything.",
  },
  {
    term: "Reference evidence",
    slug: "reference-evidence",
    def: "Grading a cheaper model's output against the output you already shipped for the same input, rather than against a synthetic gold answer. Your production result is the reference.",
  },
  {
    term: "LLM-as-judge",
    slug: "llm-as-judge",
    def: "Using a separate model, from a different family than either candidate, to score one output against another, so nothing grades its own work.",
  },
  {
    term: "Trace",
    slug: "trace",
    def: "The recorded steps of an agent run: the models called, their inputs, and their outputs. rightmodeler ingests traces you already emit and folds them into one per-step schema.",
  },
];

const definedTermSetLd = {
  "@context": "https://schema.org",
  "@type": "DefinedTermSet",
  name: "The model-downgrade glossary",
  url: `${SITE_URL}/glossary`,
  hasDefinedTerm: TERMS.map((t) => ({
    "@type": "DefinedTerm",
    name: t.term,
    description: t.def,
    url: `${SITE_URL}/glossary#${t.slug}`,
    inDefinedTermSet: `${SITE_URL}/glossary`,
  })),
};

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: TERMS.map((t) => ({
    "@type": "Question",
    name: `What is ${t.term.toLowerCase()}?`,
    acceptedAnswer: { "@type": "Answer", text: t.def },
  })),
};

export default function GlossaryPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Glossary", "/glossary")} />
      <JsonLd data={definedTermSetLd} />
      <JsonLd data={faqLd} />

      <PageHero
        eyebrow="Glossary"
        title="The model-downgrade glossary"
        lede="Plain definitions for the words rightmodeler uses: model downgrades, proven on evidence."
        gradient={false}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <dl className="divide-y divide-ash-border border-t border-ash-border">
            {TERMS.map((t, i) => (
              <Reveal key={t.slug} delay={Math.min(i * 0.03, 0.18)}>
                <div id={t.slug} className="py-6">
                  <dt className="font-sans text-heading-sm text-midnight-ink">
                    {t.term}
                  </dt>
                  <dd className="mt-2 text-body text-driftwood">{t.def}</dd>
                </div>
              </Reveal>
            ))}
          </dl>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
                { href: "/manifesto", label: "Read the manifesto" },
              ]}
            />
          </div>
        </div>
      </section>
    </PageShell>
  );
}
