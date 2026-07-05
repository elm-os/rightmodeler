// Footer — a sleek bar mirroring the nav's height and hairline: a contribute
// prompt on the left, a copyright line on the right.

const REPO_URL = "https://github.com/elm-os/rightmodeler";
// Static single-page export — Next forbids `new Date()` during prerender, so the
// copyright year is a build-time constant. Bump on the yearly rebuild.
const YEAR = 2026;

export function Footer() {
  return (
    <footer className="sticky bottom-0 z-40 border-t border-ash-border bg-parchment-white/80 backdrop-blur">
      <div className="mx-auto flex h-11 max-w-6xl items-center justify-between px-6 text-[13px] tracking-tighter">
        <p className="text-driftwood">
          Want to contribute?{" "}
          <a
            href={`${REPO_URL}/pulls`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-midnight-ink underline decoration-ash-border underline-offset-2 transition-colors duration-150 hover:decoration-midnight-ink"
          >
            Get started
          </a>
        </p>
        <span className="hidden text-fog sm:inline">
          Illustrative — not measured results
        </span>
        <span className="text-fog">© ELM {YEAR}</span>
      </div>
    </footer>
  );
}
