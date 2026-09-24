import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { getAllComparisons } from "@/content/vs";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "rightmodeler vs alternatives",
  description:
    "Where rightmodeler ends and gateways, eval platforms, routers, spend meters, model trainers, and benchmarks begin: honest side-by-side pages on what each tool decides and when to use which.",
  path: "/vs",
});

// The catalog bands: grouping is presentation only — the ItemList JSON-LD below stays flat so
// every comparison keeps its own entry. Bands with no registered entries simply don't render.
const BANDS: { title: string; intro: string; category: string }[] = [
  {
    title: "The rails",
    intro:
      "They move your live requests. rightmodeler rides them as test benches and hands back a decision, not a proxy.",
    category: "gateway",
  },
  {
    title: "The graders",
    intro:
      "They score outputs against bars you define. rightmodeler asks which steps overpay to clear them, on the same traces.",
    category: "evals",
  },
  {
    title: "The routers",
    intro:
      "They predict the right model per request, at runtime. rightmodeler measures it per step, at release time.",
    category: "router",
  },
  {
    title: "The meters",
    intro:
      "They show where AI spend goes, or trim what each call carries. rightmodeler asks whether each step needs the model it pays for.",
    category: "spend",
  },
  {
    title: "The trainers",
    intro:
      "They train a custom model on your data. rightmodeler measures the models you can already call, step by step, against outputs you accepted.",
    category: "training",
  },
  {
    title: "The scorekeepers",
    intro:
      "They rank models on shared test sets. rightmodeler scores candidates on your own traces, step by step.",
    category: "benchmarks",
  },
];

export default function VsPage() {
  const comparisons = getAllComparisons();

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "rightmodeler comparisons",
    itemListElement: comparisons.map((comparison, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: `rightmodeler vs ${comparison.name}`,
      url: `${SITE_URL}/vs/${comparison.slug}`,
    })),
  };

  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("rightmodeler vs alternatives", "/vs")} />
      <JsonLd data={itemListLd} />

      <PageHero
        eyebrow="Comparisons"
        title="Different question, different tool."
        lede="rightmodeler is an offline audit that measures cheaper models against outputs you already accepted. Gateways, eval platforms, routers, spend meters, model trainers, and benchmarks each answer a different question; rightmodeler reads traces from some and replays through others. Each page draws the line."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {BANDS.map((band) => {
        const entries = comparisons.filter(
          (comparison) => comparison.category === band.category,
        );
        if (entries.length === 0) return null;
        return (
          <section key={band.title} className="bg-parchment-white">
            <div className="px-6 pt-14 sm:px-10 sm:pt-16 lg:px-12">
              <Reveal>
                <h2 className="font-sans text-heading-sm text-midnight-ink">
                  {band.title}
                </h2>
                <p className="mt-2 text-body text-driftwood">{band.intro}</p>
              </Reveal>
            </div>
            {/* Card grid in the reference's grammar: one rounded frame, cells separated by dotted
                hairlines. Every cell draws a dotted top+left edge; the -ml/-mt shift tucks the
                outer ones under the frame so only the internal grid lines show. */}
            <div className="px-4 py-10 sm:px-6 sm:py-12">
              <div className="overflow-hidden rounded-2xl border border-ash-border">
                <div className="-ml-px -mt-px grid sm:grid-cols-2 lg:grid-cols-3">
                  {entries.map((comparison, i) => (
                    <Reveal
                      key={comparison.slug}
                      delay={i * 0.04}
                      className="border-t border-l border-dotted border-ash-border"
                    >
                      <Link
                        href={`/vs/${comparison.slug}`}
                        className="flex h-full flex-col items-center px-6 py-10 text-center transition-colors duration-150 ease-out hover:bg-warm-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-midnight-ink/40 sm:px-8 sm:py-12"
                      >
                        {/* Official mark, unboxed per the design brief; the link text names the tool. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={comparison.logo}
                          alt=""
                          aria-hidden
                          loading="lazy"
                          className="h-10 w-auto max-w-14 object-contain"
                        />
                        <span className="mt-6 font-sans text-heading-sm text-midnight-ink">
                          {comparison.name}
                        </span>
                        <span className="mt-2 max-w-xs text-body text-driftwood">
                          {comparison.description}
                        </span>
                      </Link>
                    </Reveal>
                  ))}
                </div>
              </div>
            </div>
            <div aria-hidden className="h-px w-full bg-ash-border" />
          </section>
        );
      })}

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
          <RelatedLinks
            links={[
              { href: "/how-it-works", label: "How it works" },
              {
                href: "/use-cases/reduce-llm-costs",
                label: "Reduce LLM costs",
              },
              { href: "/integrations", label: "Integrations" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
