import Link from "next/link";
import { CopyCommand } from "@/components/copy-command";
import { GitHubIcon, LogoMark } from "@/components/icons";
import { REPO_URL, RUN_COMMAND } from "@/lib/site";

const NAV_CSS = `
/* Monochrome keyboard focus, never a colored ring. */
.rm-focus:focus-visible { outline: 2px solid var(--color-midnight-ink); outline-offset: 2px; }
`;

// homeHref is "#top" on the landing page (scroll to top) and "/" on nested routes such as the blog.
export function Nav({ homeHref = "#top" }: { homeHref?: string }) {
  return (
    <header className="sticky top-0 z-50 border-b border-ash-border bg-parchment-white/80 backdrop-blur">
      <style>{NAV_CSS}</style>

      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6"
      >
        <Link
          href={homeHref}
          prefetch={false}
          aria-label="rightmodeler, home"
          className="rm-focus inline-flex items-center gap-2 self-stretch text-midnight-ink"
        >
          <LogoMark height={18} />
          <span className="wordmark">rightmodeler</span>
        </Link>

        <div className="flex items-center gap-6 sm:gap-8">
          {/* "How it works" stays in the footer: adding it here would wrap the masthead. */}
          <Link
            href="/agent"
            className="rm-focus hidden items-center whitespace-nowrap text-body text-driftwood transition-colors duration-150 hover:text-midnight-ink sm:inline-flex"
          >
            Agent
          </Link>
          <Link
            href="/crucible"
            className="rm-focus hidden items-center whitespace-nowrap text-body text-driftwood transition-colors duration-150 hover:text-midnight-ink sm:inline-flex"
          >
            Crucible
          </Link>

          <Link
            href="/blog"
            className="rm-focus inline-flex items-center text-body text-driftwood transition-colors duration-150 hover:text-midnight-ink"
          >
            Blog
          </Link>

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

          <div className="hidden md:block">
            <CopyCommand command={RUN_COMMAND} className="rm-focus" />
          </div>
        </div>
      </nav>
    </header>
  );
}
