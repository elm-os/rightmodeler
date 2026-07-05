"use client";

// Nav — a quiet sticky masthead: the brand lockup (mark + wordmark) and a minimal,
// monochrome GitHub link with a live star count. No accent hues; hover states are quiet
// color fades.

import { useEffect, useState } from "react";
import { GitHubIcon, LogoMark, StarIcon } from "../icons";
import { CopyCommand } from "../CopyCommand";

const REPO = "elm-os/rightmodeler";
const REPO_URL = `https://github.com/${REPO}`;

const NAV_CSS = `
/* Monochrome keyboard focus — never a colored ring. */
.rm-focus:focus-visible { outline: 2px solid var(--color-midnight-ink); outline-offset: 2px; }
`;

export function Nav() {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data && typeof data.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-ash-border bg-parchment-white/80 backdrop-blur">
      <style>{NAV_CSS}</style>

      <nav
        aria-label="Primary"
        className="mx-auto flex h-11 max-w-6xl items-center justify-between px-6"
      >
        <a
          href="#top"
          aria-label="rightmodeler — home"
          className="rm-focus inline-flex items-center gap-2 self-stretch text-midnight-ink"
        >
          <LogoMark height={18} />
          <span className="text-[15px] font-normal tracking-tighter">
            rightmodeler
          </span>
        </a>

        <div className="flex items-center gap-5">
          {/* The real first step, docked in the masthead — sans, not mono. */}
          <div className="hidden lg:block">
            <CopyCommand
              command="uv run python -m pipeline ingest"
              mono={false}
              className="rm-focus text-driftwood"
            />
          </div>

          {/* Minimal GitHub + live star count — an engineer's first click. */}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={
              stars !== null
                ? `rightmodeler on GitHub — ${stars} stars`
                : "rightmodeler on GitHub"
            }
            className="rm-focus inline-flex items-center gap-2 text-driftwood transition-colors duration-150 hover:text-midnight-ink"
          >
            <GitHubIcon />
            {stars !== null ? (
              <span className="inline-flex items-center gap-1 text-sm">
                <StarIcon size={14} />
                <span className="tabular-nums">
                  {stars.toLocaleString("en-US")}
                </span>
              </span>
            ) : null}
          </a>

          {/* shadcn-style vertical separator */}
          <span aria-hidden className="h-4 w-px shrink-0 bg-ash-border" />

          {/* Docs — straight to the repo README. */}
          <a
            href={`${REPO_URL}/blob/main/README.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="rm-focus text-sm tracking-tighter text-driftwood transition-colors duration-150 hover:text-midnight-ink"
          >
            view docs
          </a>
        </div>
      </nav>
    </header>
  );
}
