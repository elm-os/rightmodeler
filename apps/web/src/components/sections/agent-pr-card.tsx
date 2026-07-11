"use client";

// AgentPrCard — the /agent page's signature artifact: the pull request the agent opens, rendered
// as a faithful monochrome record (product vernacular, not GitHub cosplay: no avatars, no merge
// button, no traffic-light hues). The one bold move is the assembly order — the card builds its
// case the way the agent does, evidence rows before the verdict number — via a single staggered
// whileInView cascade. The savings figure is gated by useInView so the count-up runs when seen,
// not on mount, with an invisible twin reserving the final width. The model pair and the 85% are
// factual: OpenAI list prices as of July 2026 put gpt-5.6 at $5/$30 per 1M tokens and
// gpt-5.4-mini at $0.75/$4.50, an 85% per-token cut on both input and output. Quality, latency,
// and trace-count figures remain illustrative and the title bar stamps them as such.

import { useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { AnimatedNumber } from "@/components/animated-number";

// Strong ease-out curve (docs/design.md § Motion) as a motion-friendly tuple.
const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

// One label/value line in the evidence block. The fixed label column keeps values aligned so the
// rows read as one record, without hand-set leading or an off-scale grid.
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-x-3 font-mono text-[13px]">
      <span className="w-24 shrink-0 text-fog">{label}</span>
      <span className="min-w-0 text-driftwood">{children}</span>
    </div>
  );
}

// A passed check: ink glyph for the eye, spoken label for screen readers.
function Check({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 font-mono text-[13px] text-driftwood">
      <span aria-hidden className="text-midnight-ink">
        ✓
      </span>
      <span className="sr-only">Passed:</span>
      {children}
    </span>
  );
}

export function AgentPrCard() {
  const reduce = useReducedMotion();
  const numberRef = useRef<HTMLDivElement>(null);
  // Fire the count-up when the savings block is actually seen (once), not on page mount.
  const numberInView = useInView(numberRef, { once: true, margin: "-64px" });

  // Parent orchestrates; children share one variant pair. Under reduced motion the cascade keeps
  // its meaning (the card still builds its case) but moves nothing — opacity only, tighter stagger.
  const container = {
    hidden: {},
    show: {
      transition: {
        staggerChildren: reduce ? 0.02 : 0.06,
        delayChildren: 0.1,
      },
    },
  };
  const block = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 8 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.32, ease: EASE },
    },
  };

  return (
    <motion.article
      className="overflow-hidden rounded-xl border border-ash-border bg-warm-sand"
      variants={container}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-64px" }}
    >
      {/* Title bar — artifact name (left), honesty stamp (right). Same grammar as the hero ledger. */}
      <div className="flex items-center justify-between gap-4 border-b border-ash-border px-4 py-3 sm:px-5">
        <span className="min-w-0 truncate font-mono text-caption text-driftwood">
          rightmodeler agent · pull request
        </span>
        <span className="shrink-0 font-mono text-caption text-fog">
          illustrative
        </span>
      </div>

      <div className="divide-y divide-ash-border">
        {/* Branch + author line. */}
        <motion.div
          variants={block}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-4 sm:px-5"
        >
          <span className="inline-flex items-center rounded-md border border-ash-border bg-parchment-white px-2.5 py-1 font-mono text-caption text-midnight-ink">
            agent/swap-summarize-step
          </span>
          <span className="font-mono text-caption text-fog">
            opened by rightmodeler-agent
          </span>
        </motion.div>

        {/* PR title + one-line body. */}
        <motion.div variants={block} className="px-4 py-4 sm:px-5">
          <p className="font-sans text-heading-sm text-midnight-ink">
            swap: summarize step to gpt-5.4-mini
          </p>
          <p className="mt-1 text-body text-driftwood">
            gpt-5.6 is doing work gpt-5.4-mini can hold. Evidence below; merging
            is yours.
          </p>
        </motion.div>

        {/* Evidence rows — the case, before the verdict. */}
        <motion.div
          variants={block}
          className="flex flex-col gap-y-2 px-4 py-4 sm:px-5"
        >
          <Row label="quality">
            <span className="text-midnight-ink">0.94</span> vs 0.95 shipped ·
            floor 0.90
          </Row>
          <Row label="p95 latency">
            <span className="text-midnight-ink">-38%</span> vs current
          </Row>
          <Row label="list price">
            <span className="text-midnight-ink">$5.00 → $0.75</span> in ·{" "}
            <span className="text-midnight-ink">$30.00 → $4.50</span> out · per
            1M tokens
          </Row>
          <Row label="confidence">medium · judged, position-swapped</Row>
        </motion.div>

        {/* The diff itself — recessed mono slab, glyphs and ink only (no red/green, ever). */}
        <motion.div variants={block} className="px-4 py-4 sm:px-5">
          <div className="overflow-x-auto rounded-lg border border-ash-border bg-midnight-ink/5 p-4 font-mono text-[13px]">
            <div className="min-w-max">
              <p className="text-driftwood">steps/summarize.ts</p>
              <p className="mt-2 whitespace-pre text-fog">
                {'   step: "summarize",'}
              </p>
              <p className="whitespace-pre text-fog">
                {'-  model: "gpt-5.6",'}
              </p>
              <p className="whitespace-pre text-midnight-ink">
                {'+  model: "gpt-5.4-mini",'}
              </p>
            </div>
          </div>
        </motion.div>

        {/* Checks — what ran before this PR existed. */}
        <motion.div
          variants={block}
          className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-4 sm:px-5"
        >
          <Check>replay: 214 traces</Check>
          <Check>judge: pass</Check>
          <Check>cascade: clear</Check>
        </motion.div>

        {/* The verdict number — counts up only once it is actually in view. The invisible twin
            reserves the final width so the line never reflows as digits grow. */}
        <motion.div variants={block} className="px-4 py-5 sm:px-5">
          <div ref={numberRef}>
            <span className="relative inline-block font-display text-heading text-midnight-ink sm:text-heading-lg">
              <span aria-hidden className="invisible">
                85%
              </span>
              {numberInView && (
                <AnimatedNumber
                  value={85}
                  suffix="%"
                  className="absolute inset-0"
                />
              )}
            </span>
            <p className="mt-1.5 font-mono text-caption text-fog">
              cheaper per token · gpt-5.6 to gpt-5.4-mini · list prices
            </p>
          </div>
        </motion.div>
      </div>

      {/* Footer — the ethos, stated where the artifact ends. */}
      <div className="border-t border-ash-border px-4 py-3 sm:px-5">
        <p className="font-mono text-caption text-driftwood">
          Every pull request ships with the evidence behind it. Merging stays
          your call.
        </p>
      </div>
    </motion.article>
  );
}
