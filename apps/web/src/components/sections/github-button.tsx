// Primary "View on GitHub" action — the same ink button used in the landing CTA band
// (sections/cta-band.tsx), extracted so every marketing page closes on the identical control.
// Points at the canonical repo from lib/site.ts.

import { GitHubIcon } from "@/components/icons";
import { REPO_URL } from "@/lib/site";

export function GithubButton({ label = "View on GitHub" }: { label?: string }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:w-auto"
    >
      <GitHubIcon />
      {label}
    </a>
  );
}
