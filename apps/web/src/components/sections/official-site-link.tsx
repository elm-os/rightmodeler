// "Visit <name>": the hero link to a vendor's official site on the /vs and /integrations detail
// pages. Same quiet treatment as the landing hero's repo link (sections/hero.tsx), with a 44px
// touch target. rel is "noopener" alone on purpose: no noreferrer, so the vendor sees the
// referral, and no nofollow.

import { ArrowRightIcon } from "@/components/icons";

export function OfficialSiteLink({
  href,
  name,
}: {
  href: string;
  name: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="group -mx-1 inline-flex min-h-11 items-center gap-2 rounded px-1 text-body text-driftwood transition-colors duration-150 hover:text-midnight-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
    >
      <span>Visit {name}</span>
      <span className="sr-only"> (opens in a new tab)</span>
      <ArrowRightIcon className="shrink-0 transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
    </a>
  );
}
