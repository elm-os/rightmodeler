// rel is "noopener" alone on purpose: no noreferrer (the vendor sees the referral) and no nofollow.
// Below sm the link sits on the densest band of the hero gradient, so it is ink there.

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
      className="group -mx-1 inline-flex min-h-11 items-center rounded px-1 text-body text-midnight-ink transition-colors duration-150 hover:text-midnight-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:text-driftwood"
    >
      <span>
        Visit {name}&nbsp;
        <ArrowRightIcon className="ml-1 inline align-middle transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
        <span className="sr-only"> (opens in a new tab)</span>
      </span>
    </a>
  );
}
