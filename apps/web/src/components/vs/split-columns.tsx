// Two-column split band — the use-case page's before/after grammar (two full-bleed columns split
// by the center hairline, dotted rules between rows) generalized for the /vs pages, where the same
// skeleton carries two registers:
//   "contrast"  ✕ (fog) rows on the left answered by ✓ (ink) rows on the right, as the reference
//   "none"      plain rows on dotted rules (positioning pairs, use-when forks); per house rule,
//               list rows carry no marker glyphs unless the reference design shows them
// The rightmodeler column is always the right one and always carries the ink. Server component;
// motion is the house Reveal pair (left first, right +0.06s).

import { Reveal } from "@/components/reveal";

export type SplitSide = { heading: string; items: string[] };

export function SplitColumns({
  left,
  right,
  markers = "none",
}: {
  left: SplitSide;
  right: SplitSide;
  markers?: "contrast" | "none";
}) {
  return (
    <section className="bg-parchment-white">
      <div className="relative grid lg:grid-cols-2 lg:divide-x lg:divide-ash-border">
        <div className="p-6 sm:p-10 lg:p-12">
          <Reveal>
            <h2 className="font-sans text-heading-sm text-midnight-ink">
              {left.heading}
            </h2>
            <ul className="mt-8">
              {left.items.map((item, i) => (
                <li
                  key={item}
                  className={`flex gap-4 py-5 ${
                    i > 0 ? "border-t border-dotted border-ash-border" : ""
                  }`}
                >
                  {markers === "contrast" && (
                    <span aria-hidden className="font-mono text-fog">
                      ✕
                    </span>
                  )}
                  <span className="text-body text-driftwood">{item}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <div className="border-t border-ash-border p-6 sm:p-10 lg:border-t-0 lg:p-12">
          <Reveal delay={0.06}>
            <h2 className="font-sans text-heading-sm text-midnight-ink">
              {right.heading}
            </h2>
            <ul className="mt-8">
              {right.items.map((item, i) => (
                <li
                  key={item}
                  className={`flex gap-4 py-5 ${
                    i > 0 ? "border-t border-dotted border-ash-border" : ""
                  }`}
                >
                  {markers === "contrast" && (
                    <span aria-hidden className="font-mono text-midnight-ink">
                      ✓
                    </span>
                  )}
                  <span className="text-body text-midnight-ink">{item}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
