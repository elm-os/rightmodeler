import { Reveal } from "@/components/reveal";
import { TRACE_SOURCES } from "@/lib/product-facts";

// Seam position, as a percent of the band width: normalized output left of it, raw intake right.
const SEAM = 63;

const EDGE_MASK = {
  maskImage:
    "linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)",
  WebkitMaskImage:
    "linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)",
} as const;

export function SourcesBar() {
  return (
    <section className="mx-auto max-w-4xl border-t border-ash-border px-6 py-10 sm:px-10 sm:py-12">
      <Reveal>
        {/* An h2 styled as body text: this is the band's title, and the outline needs it. */}
        <h2 className="font-sans text-body text-driftwood">
          Reads the traces you already have.
        </h2>
        <p className="mt-1 font-mono text-caption text-driftwood">
          Autodetects {TRACE_SOURCES.length} trace formats into one per-step
          schema.
        </p>
      </Reveal>

      {/* Accessible source of truth — the visual band below is decorative (aria-hidden). */}
      <p className="sr-only">Reads traces from {TRACE_SOURCES.join(", ")}.</p>

      <Reveal delay={0.08} className="mt-6">
        <div
          aria-hidden
          className="group relative h-11 overflow-hidden"
          style={EDGE_MASK}
        >
          <div
            className="absolute inset-0"
            style={{ clipPath: `inset(0 ${100 - SEAM}% 0 0)` }}
          >
            <MarqueeTrack variant="normalized" />
          </div>

          <div
            className="absolute inset-0"
            style={{ clipPath: `inset(0 0 0 ${SEAM}%)` }}
          >
            <MarqueeTrack variant="raw" />
          </div>

          <div
            className="absolute inset-y-0 w-px bg-ash-border"
            style={{ left: `${SEAM}%` }}
          />
        </div>
      </Reveal>
    </section>
  );
}

function MarqueeTrack({ variant }: { variant: "normalized" | "raw" }) {
  // Identical box on both sides (border-transparent keeps the 1px): a crossing label never shifts.
  const chip =
    variant === "normalized"
      ? "border-ash-border bg-warm-sand text-midnight-ink"
      : "border-transparent bg-transparent text-fog";

  // `animate-marquee` is only the globals.css reduced-motion kill-switch hook. The animation is a
  // class, not inline, so `group-hover` can pause it. Rendered twice for the seamless -50% loop.
  return (
    <div className="animate-marquee absolute inset-y-0 left-0 flex w-max items-center gap-x-3 [animation:marquee_32s_linear_infinite] group-hover:[animation-play-state:paused]">
      {[0, 1].map((copy) =>
        TRACE_SOURCES.map((name) => (
          <span
            key={`${copy}-${name}`}
            className={`inline-flex items-center whitespace-nowrap rounded-md border px-3 py-1.5 font-mono text-caption ${chip}`}
          >
            {name}
          </span>
        )),
      )}
    </div>
  );
}
