import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { getAllIntegrations } from "@/content/integrations";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Integrations",
  description:
    "Every tool rightmodeler works with: the trace formats it reads (LangSmith, Langfuse, Braintrust, Phoenix, OpenAI SDK, Claude Code, Codex, OTel GenAI) and the infrastructure it replays through.",
  path: "/integrations",
  image: "/social/integrations.png",
});

// Official vendor marks, downloaded to public/integrations/logos. Two ship as raster; the map
// keeps the odd extensions in one place.
const LOGOS: Record<string, string> = {
  "claude-code": "/integrations/logos/claude-code.svg",
  codex: "/integrations/logos/codex.svg",
  langsmith: "/integrations/logos/langsmith.svg",
  "openai-sdk": "/integrations/logos/openai-sdk.svg",
  langfuse: "/integrations/logos/langfuse.svg",
  braintrust: "/integrations/logos/braintrust.svg",
  phoenix: "/integrations/logos/phoenix.png",
  otel: "/integrations/logos/otel.svg",
  openrouter: "/integrations/logos/openrouter.svg",
  litellm: "/integrations/logos/litellm.png",
  "vercel-ai-gateway": "/integrations/logos/vercel-ai-gateway.svg",
};

// The catalog bands: grouping is presentation only — the ItemList JSON-LD below stays flat so
// every integration keeps its own entry. Bands with no registered entries simply don't render.
const BANDS: { title: string; intro: string; categories: string[] }[] = [
  {
    title: "Reads your traces",
    intro: "Autodetected and folded into one per-step schema.",
    categories: ["trace-source", "trace-source-generic"],
  },
  {
    title: "Replays through",
    intro: "Where the candidate calls actually run.",
    categories: ["replay-engine", "replay-method"],
  },
  {
    title: "On the roadmap",
    intro: "Named integrations arriving with Crucible.",
    categories: ["roadmap"],
  },
];

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
        eyebrow="Integrations"
        title="Works with the traces you already have."
        lede="No new SDK and nothing in your request path: rightmodeler reads the traces your agent already emits, replays them through cheaper models, and proves which swaps are safe."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {BANDS.map((band) => {
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
            {/* Card grid in the reference's grammar: one rounded frame, cells separated by dotted
                hairlines. Every cell draws a dotted top+left edge; the -ml/-mt shift tucks the
                outer ones under the frame so only the internal grid lines show. */}
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
                        {/* Official mark, unboxed per the design brief; the link text names the tool. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={LOGOS[integration.slug]}
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
              { href: "/glossary", label: "Glossary" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
