// SourcesBar — the "works-with" trust strip, built as the pipeline's intake seam.
//
// No vendor logos: the eight real trace sources appear as the normalized mono
// records the ingester actually reads. The mandated marquee is made load-bearing
// rather than decorative — a fixed clip seam at 63% splits the band into the
// normalized output (framed ink chips, left) and raw intake still resolving
// (loose fog text, right), so the constant drift performs methodology step 1:
// autodetect 8 trace formats into one per-step schema. Two identical,
// clip-complementary tracks share one animation declaration, so a label's box is
// byte-identical across the seam (no ghosting) — only its framing and color change
// as it crosses, like a scanner rewriting it into the schema.
//
// Motion: one linear 32s marquee (transform-only, GPU), pauses on hover, killed
// under reduced-motion by the globals.css `.animate-marquee` guard — which leaves a
// static, still-meaningful normalization diagram. One quiet Reveal entrance.
// Monochrome; no accent hues; no big number; nothing centered.

import { Reveal } from "@/components/reveal";

const SOURCES = [
  "Claude Code",
  "Codex",
  "LangSmith / LangGraph",
  "OpenAI SDK",
  "Langfuse",
  "Braintrust",
  "Phoenix (OpenInference)",
  "OTel GenAI",
] as const;

// Fixed seam position, as a percent of the band width. Left of the line is the
// normalized output; right is raw intake emerging from the edge fade.
const SEAM = 63;

// Both ends melt into the parchment (brief: edge fade via mask, not blur).
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
        <p className="font-sans text-body text-driftwood">
          Reads the traces you already have.
        </p>
        <p className="mt-1 font-mono text-caption text-driftwood">
          Autodetects 8 trace formats into one per-step schema.
        </p>
      </Reveal>

      {/* Accessible source of truth — the visual band below is decorative (aria-hidden). */}
      <p className="sr-only">Reads traces from {SOURCES.join(", ")}.</p>

      <Reveal delay={0.08} className="mt-6">
        <div
          aria-hidden
          className="group relative h-11 overflow-hidden"
          style={EDGE_MASK}
        >
          {/* Normalized output: left of the seam, framed ink chips. */}
          <div
            className="absolute inset-0"
            style={{ clipPath: `inset(0 ${100 - SEAM}% 0 0)` }}
          >
            <MarqueeTrack variant="normalized" />
          </div>

          {/* Raw intake: right of the seam, loose fog text, identical geometry. */}
          <div
            className="absolute inset-0"
            style={{ clipPath: `inset(0 0 0 ${SEAM}%)` }}
          >
            <MarqueeTrack variant="raw" />
          </div>

          {/* The ingest boundary where raw resolves into the per-step schema. */}
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
  // Identical box on both sides — only frame/color differs across the seam, so a
  // crossing label never shifts a pixel (border stays 1px via border-transparent).
  const chip =
    variant === "normalized"
      ? "border-ash-border bg-warm-sand text-midnight-ink"
      : "border-transparent bg-transparent text-fog";

  // `animate-marquee` is only the globals.css reduced-motion kill-switch hook. The
  // animation lives in the class layer (not inline) so `group-hover` can pause it —
  // an inline `animation` shorthand outranks the hover rule and would defeat it.
  // Rendered twice for the seamless translateX(-50%) loop.
  return (
    <div className="animate-marquee absolute inset-y-0 left-0 flex w-max items-center gap-x-3 [animation:marquee_32s_linear_infinite] group-hover:[animation-play-state:paused]">
      {[0, 1].map((copy) =>
        SOURCES.map((name) => (
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
