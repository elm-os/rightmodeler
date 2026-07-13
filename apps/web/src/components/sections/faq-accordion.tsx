// FAQ accordion — the integration pages' Q&A block: the display title on the left, collapsible
// question rows on the right (ElevenLabs-style), dotted hairlines between items. Built on native
// <details>/<summary> so it ships zero JS and every answer still lands in the initial HTML for
// search + AI crawlers (the same rationale as sections/faq.tsx, which stays fully expanded). The
// FAQPage structured data is generated from the SAME items array so the JSON-LD can never drift.
// Motion is the chevron only: transform-based rotation on the house strong ease-out, under 300ms,
// stilled under reduced motion. The disclosure itself is instant. Server component.

import { ChevronDownIcon } from "@/components/icons";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import type { FaqItem } from "@/components/sections/faq";

export function FaqAccordion({ items }: { items: FaqItem[] }) {
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <section className="bg-parchment-white">
      <div className="px-6 py-14 sm:px-10 sm:py-16 lg:px-12">
        <JsonLd data={faqLd} />
        <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16">
          <Reveal>
            <h2 className="max-w-xs font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
              Frequently asked questions
            </h2>
          </Reveal>
          <div>
            {items.map((item, i) => (
              <Reveal key={item.q} delay={i * 0.04}>
                <details
                  className={`group ${
                    i > 0 ? "border-t border-dotted border-ash-border" : ""
                  }`}
                >
                  {/* The first row drops its top padding so the question tops align with the heading. */}
                  <summary
                    className={`flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white ${
                      i > 0 ? "py-6" : "pb-6"
                    }`}
                  >
                    <span className="text-subheading text-midnight-ink">
                      {item.q}
                    </span>
                    <ChevronDownIcon className="mt-1 shrink-0 text-driftwood transition-transform duration-200 ease-out-strong group-open:rotate-180 motion-reduce:transition-none" />
                  </summary>
                  <p className="pb-6 text-body text-driftwood">{item.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
