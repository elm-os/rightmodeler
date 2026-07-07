// FAQ block — a visible, crawlable list of Q&As plus the matching FAQPage structured data, both
// generated from the SAME items array so the JSON-LD can never drift from what's on the page (a
// structured-data requirement). Monochrome <dl> with ash-border dividers; no accordion JS, so every
// answer ships in the initial HTML for search + AI crawlers. Server component.

import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";

export type FaqItem = { q: string; a: string };

export function Faq({
  items,
  heading = "FAQ",
}: {
  items: FaqItem[];
  heading?: string;
}) {
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
      <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
        <JsonLd data={faqLd} />
        <Reveal>
          <h2 className="font-display text-heading text-balance text-midnight-ink">
            {heading}
          </h2>
        </Reveal>
        <dl className="mt-8 divide-y divide-ash-border border-t border-ash-border">
          {items.map((item, i) => (
            <Reveal key={item.q} delay={i * 0.04}>
              <div className="py-6">
                <dt className="text-subheading text-midnight-ink">{item.q}</dt>
                <dd className="mt-2 text-body text-driftwood">{item.a}</dd>
              </div>
            </Reveal>
          ))}
        </dl>
      </div>
    </section>
  );
}
