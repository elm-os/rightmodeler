import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { VS_HUB } from "@/content/markdown/render-hub";
import { getAllComparisons } from "@/content/vs";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "rightmodeler vs alternatives",
  description:
    "rightmodeler validates swaps to cheaper models on your own traces. See where it ends and gateways, observability, evals, routers, benchmarks, and coding agents begin.",
  path: "/vs",
});

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
        eyebrow={VS_HUB.eyebrow}
        title={VS_HUB.title}
        lede={VS_HUB.lede}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {VS_HUB.bands.map((band) => {
        const entries = comparisons.filter((comparison) =>
          band.categories.includes(comparison.category),
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
            {/* Cells draw top+left edges; -ml-px/-mt-px tucks the outer ones under the frame. */}
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
