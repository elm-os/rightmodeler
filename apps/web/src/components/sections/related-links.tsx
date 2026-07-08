// Cross-links to sibling pages — plain text links, not buttons. Underline affordance that deepens on
// hover (the same treatment as inline prose links in blog/prose.tsx), a quiet mono "Related" kicker,
// and no arrows. Keeps the internal link graph tight for readers and crawlers without decoration.

import Link from "next/link";
import { Reveal } from "@/components/reveal";

export type RelatedLink = { href: string; label: string };

export function RelatedLinks({ links }: { links: RelatedLink[] }) {
  return (
    <Reveal className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <span className="font-mono text-caption uppercase text-fog">Related</span>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="text-body text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
        >
          {l.label}
        </Link>
      ))}
    </Reveal>
  );
}
