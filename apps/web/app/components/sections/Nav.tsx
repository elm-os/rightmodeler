"use client";

// Nav — a quiet sticky masthead: the brand lockup (mark + wordmark), the GitHub repo link
// (logo icon), and the product's real first step docked as a copy-able command. Monochrome
// throughout; hover states are quiet color fades.

import Link from "next/link";
import { CopyCommand } from "../CopyCommand";
import { GitHubIcon, LogoMark } from "../icons";

// Placeholder repo URL — point at the real repository before shipping.
const REPO_URL = "https://github.com/elm-os/rightmodeler";
// Real entrypoint from README.md (§ run commands): ingest your own traces.
const RUN_COMMAND = "uv run python -m pipeline ingest";

const NAV_CSS = `
/* Monochrome keyboard focus — never a colored ring. */
.rm-focus:focus-visible { outline: 2px solid var(--color-midnight-ink); outline-offset: 2px; }
`;

// homeHref: the brand lockup points at "#top" on the landing page (smooth scroll to top) but at "/"
// on nested routes like the blog, where "home" means navigating back to the landing page.
export function Nav({ homeHref = "#top" }: { homeHref?: string }) {
  return (
    <header className="sticky top-0 z-50 border-b border-ash-border bg-parchment-white/80 backdrop-blur">
      <style>{NAV_CSS}</style>

      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6"
      >
        <a
          href={homeHref}
          aria-label="rightmodeler — home"
          className="rm-focus inline-flex items-center gap-2 self-stretch text-midnight-ink"
        >
          <LogoMark height={18} />
          <span className="wordmark">rightmodeler</span>
        </a>

        <div className="flex items-center gap-6 sm:gap-8">
          {/* Writing — the blog index. */}
          <Link
            href="/blog"
            className="rm-focus inline-flex items-center text-body text-driftwood transition-colors duration-150 hover:text-midnight-ink"
          >
            Blog
          </Link>

          {/* Repo link — an engineer's first click, shown on every breakpoint. */}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="rightmodeler on GitHub"
            className="rm-focus flex h-11 w-11 items-center justify-center text-driftwood transition-colors duration-150 hover:text-midnight-ink"
          >
            <GitHubIcon />
          </a>

          <span
            aria-hidden
            className="hidden h-4 w-px bg-ash-border md:block"
          />

          {/* Desktop primary action: the real run command, docked. */}
          <div className="hidden md:block">
            <CopyCommand command={RUN_COMMAND} className="rm-focus" />
          </div>
        </div>
      </nav>
    </header>
  );
}
