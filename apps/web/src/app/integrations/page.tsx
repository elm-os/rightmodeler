import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { getAllIntegrations } from "@/content/integrations";
import { INTEGRATIONS_HUB } from "@/content/markdown/render-hub";
import { TRACE_SOURCES } from "@/lib/product-facts";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Integrations",
  description: `Everything the validation loop touches: the ${TRACE_SOURCES.length} trace formats rightmodeler reads, where cheaper candidates replay, what grades them, and where the pull request lands.`,
  path: "/integrations",
  image: "/social/integrations.png",
});

export default function IntegrationsPage() {
  const integrations = getAllIntegrations();

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "rightmodeler integrations",
    itemListElement: integrations.map((integration, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: `rightmodeler + ${integration.name}`,
      url: `${SITE_URL}/integrations/${integration.slug}`,
    })),
  };

  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Integrations", "/integrations")} />
      <JsonLd data={itemListLd} />

      <PageHero
        eyebrow={INTEGRATIONS_HUB.eyebrow}
        title={INTEGRATIONS_HUB.title}
        lede={INTEGRATIONS_HUB.lede}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {INTEGRATIONS_HUB.bands.map((band) => {
        const entries = integrations.filter((integration) =>
          band.categories.includes(integration.category),
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
                  {entries.map((integration, i) => (
                    <Reveal
                      key={integration.slug}
                      delay={i * 0.04}
                      className="border-t border-l border-dotted border-ash-border"
                    >
                      <Link
                        href={`/integrations/${integration.slug}`}
                        className="flex h-full flex-col items-center px-6 py-10 text-center transition-colors duration-150 ease-out hover:bg-warm-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-midnight-ink/40 sm:px-8 sm:py-12"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={integration.logo}
                          alt=""
                          aria-hidden
                          loading="lazy"
                          className="h-10 w-auto max-w-14 object-contain"
                        />
                        <span className="mt-6 font-sans text-heading-sm text-midnight-ink">
                          {integration.name}
                        </span>
                        <span className="mt-2 max-w-xs text-body text-driftwood">
                          {integration.description}
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
              { href: "/vs", label: "Compare alternatives" },
              { href: "/glossary", label: "Glossary" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
