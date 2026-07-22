// Social handles, icon-only — no text label, no trailing arrow (house rule for every social link).
// Monochrome per docs/design.md: driftwood glyph that deepens to ink on hover, ink focus ring. The
// accessible name lives on aria-label since the icon carries no visible text.

import {
  GitHubIcon,
  LinkedInIcon,
  RedditIcon,
  XIcon,
} from "@/components/icons";
import { LINKEDIN_URL, REDDIT_URL, REPO_URL, X_URL } from "@/lib/site";

const linkClass =
  "flex h-10 w-10 items-center justify-center rounded-md text-driftwood transition-colors duration-150 ease-out hover:text-midnight-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

export function SocialLinks({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-1 ${className ?? ""}`}>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="rightmodeler on GitHub"
        className={linkClass}
      >
        <GitHubIcon size={18} />
      </a>
      <a
        href={LINKEDIN_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="rightmodeler on LinkedIn"
        className={linkClass}
      >
        <LinkedInIcon size={18} />
      </a>
      <a
        href={X_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="rightmodeler on X"
        className={linkClass}
      >
        <XIcon size={16} />
      </a>
      <a
        href={REDDIT_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="rightmodeler on Reddit"
        className={linkClass}
      >
        <RedditIcon size={18} />
      </a>
    </div>
  );
}
