"use client";

// MethodologyDetail — the evidence ladder, set as a methods figure for a skeptical
// engineering manager. Structure carries the argument, not ornament:
//
//  - The ladder is ordered by falsifiability (strongest → weakest). Each rung fires
//    only when the one above it can't settle the case, so the LLM judge reads as the
//    LAST resort, not the product.
//  - One labeled QUALITY FLOOR (0.90) hairline cuts the ladder in two: everything above
//    it is recommendable; the fifth rung, abstain, sits below it — abstaining just means
//    nothing cleared the line. That line is the section's single signature: it draws in
//    from the spine on first view, a threshold being measured out. GPU-only, once,
//    reduced-motion → static.
//  - The one place the layout opens up is the judge rung, into a warm-sand inset that
//    defends it (cross-family, position-swapped, hard-checks-first) — the safeguards sit
//    exactly at the rung that asks you to trust a model, pre-empting "your judge is just
//    another LLM."
//  - Certainty drains through ONE monochrome tonal ramp on the per-rung ceiling column
//    (ink → driftwood → fog); no accent hue, no colored badges. "up to" marks it as a
//    ceiling, so a pass that lands lower is the honest origin of the "low" band.
//  - 0.90 does NOT count up (no AnimatedNumber): it's a config default, not a measured
//    result, and a ticker would over-dramatize a constant.

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Reveal } from "../Reveal";

type Rung = {
  name: string;
  verify: string;
  eg: string;
  ceiling: string;
  ceilingClass: string;
};

// Above the floor, ordered by falsifiability. The per-rung ceiling is the strongest
// band that class of evidence can reach — the ONE tonal ramp (ink → driftwood).
const ABOVE_FLOOR: Rung[] = [
  {
    name: "Deterministic check",
    verify:
      "Byte-exact, schema, or rule match. It holds or it doesn’t — no model is asked for an opinion.",
    eg: "json_extraction",
    ceiling: "high",
    ceilingClass: "text-midnight-ink",
  },
  {
    name: "Reference comparison",
    verify:
      "Scored for equivalence against the output you already shipped on that exact input.",
    eg: "sql_generation",
    ceiling: "high",
    ceilingClass: "text-midnight-ink",
  },
  {
    name: "Trajectory & tool-use",
    verify:
      "Replays the whole loop in a sandboxed git worktree and checks the tool calls and end state still line up. This is where cascades surface.",
    eg: "tool_agent",
    ceiling: "medium",
    ceilingClass: "text-driftwood",
  },
];

const JUDGE: Rung = {
  name: "Calibrated LLM judge",
  verify:
    "Used only when nothing harder applies — a reference-guided verdict, never the first thing tried.",
  eg: "support_draft",
  ceiling: "medium",
  ceilingClass: "text-driftwood",
};

const ABSTAIN: Rung = {
  name: "Abstain",
  verify:
    "Nothing clears the floor, or the task is too risky to certify. We recommend no swap — and tell you why.",
  eg: "auth_code_edit",
  ceiling: "no swap",
  ceilingClass: "text-fog",
};

// The defense lives at exactly the one rung that asks you to trust a model.
const JUDGE_DEFENSE: { lead: string; rest: string }[] = [
  {
    lead: "Cross-family by construction.",
    rest: "The judge is always a different model family than both the current and candidate models, so it can’t quietly prefer its own kind.",
  },
  {
    lead: "Position-swapped.",
    rest: "Each pair is scored in both orders and reconciled — which output came first can’t decide the winner.",
  },
  {
    lead: "Hard checks run first.",
    rest: "The judge never rules on a pair a deterministic or reference check could have settled.",
  },
];

const BANDS: { label: string; def: string }[] = [
  {
    label: "high",
    def: "Cleared the floor on objective evidence, with almost no judgment involved.",
  },
  {
    label: "medium",
    def: "Cleared the floor on trajectory or judged evidence, with de-biasing applied.",
  },
  {
    label: "low",
    def: "Cleared the floor, but below the ceiling its evidence allows, or close to the line — worth a second look before you ship it.",
  },
  {
    label: "abstain",
    def: "Below the floor, or a task we won’t certify. No swap recommended.",
  },
];

function Ceiling({ label, className }: { label: string; className: string }) {
  // "no swap" is a terminal state, not a ceiling — no "up to" framing.
  if (label === "no swap") {
    return (
      <span className="font-mono text-caption uppercase text-fog">no swap</span>
    );
  }
  return (
    <span className="font-mono text-caption uppercase">
      <span className="text-fog">up to </span>
      <span className={className}>{label}</span>
    </span>
  );
}

function RungRow({ rung, children }: { rung: Rung; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-baseline gap-x-6 gap-y-2 sm:grid-cols-[1fr_auto]">
      <div>
        <h3 className="text-heading-sm text-midnight-ink">{rung.name}</h3>
        <p className="mt-1.5 max-w-[48ch] text-body text-driftwood">
          {rung.verify}
        </p>
        <p className="mt-2 font-mono text-caption text-fog">e.g. {rung.eg}</p>
        {children}
      </div>
      <div className="sm:pl-6 sm:text-right">
        <Ceiling label={rung.ceiling} className={rung.ceilingClass} />
      </div>
    </div>
  );
}

export function MethodologyDetail() {
  const reduce = useReducedMotion();

  return (
    <section
      id="methodology"
      aria-labelledby="methodology-title"
      className="bg-parchment-white"
    >
      <div className="mx-auto max-w-5xl px-6 py-24 sm:px-10 sm:py-32">
        <div className="grid gap-x-12 gap-y-12 md:grid-cols-[minmax(0,0.62fr)_minmax(0,1fr)]">
          {/* Left rail — thesis, deliberately not centered, sticky beside the ladder. */}
          <div className="md:sticky md:top-24 md:self-start">
            <Reveal>
              <p className="font-mono text-caption uppercase text-fog">
                Evidence ladder — strongest → weakest
              </p>
              <h2
                id="methodology-title"
                className="mt-4 font-display text-heading text-balance text-midnight-ink sm:text-heading-lg"
              >
                We grade the evidence, not just the output.
              </h2>
              <p className="mt-5 max-w-[42ch] text-body text-driftwood">
                Every candidate swap is checked against the strongest evidence
                its task allows — a deterministic fact where one exists, a
                model’s judgment only where nothing harder applies. Each rung
                fires only when the one above it can’t settle the case, so the
                LLM judge is the last resort, not the product. The rung a result
                stood on travels with it, so you always know how a number was
                earned.
              </p>
            </Reveal>
          </div>

          {/* Right — the ladder. A single ash-border spine is the strongest→weakest axis. */}
          <div className="relative">
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-px bg-ash-border"
            />

            <div className="space-y-10">
              {ABOVE_FLOOR.map((rung, i) => (
                <Reveal key={rung.name} delay={i * 0.06} className="pl-8">
                  <RungRow rung={rung} />
                </Reveal>
              ))}

              {/* Judge rung — the one place the ladder opens up, exactly at the trust risk. */}
              <Reveal delay={0.18} className="pl-8">
                <RungRow rung={JUDGE}>
                  <div className="mt-4 rounded-lg border border-ash-border bg-warm-sand p-4 sm:p-5">
                    <h4 className="font-mono text-caption uppercase text-driftwood">
                      Why you can trust the judge
                    </h4>
                    <ul className="mt-3 space-y-2.5">
                      {JUDGE_DEFENSE.map((point) => (
                        <li
                          key={point.lead}
                          className="text-body text-driftwood"
                        >
                          <span className="text-midnight-ink">
                            {point.lead}
                          </span>{" "}
                          {point.rest}
                        </li>
                      ))}
                    </ul>
                  </div>
                </RungRow>
              </Reveal>
            </div>

            {/* Quality floor — the signature: a threshold measured out from the spine.
                0.90 does not count up; it fades in with its line. */}
            <div className="my-10">
              <motion.div
                aria-hidden
                className="h-0.5 origin-left bg-midnight-ink"
                style={{ transformOrigin: "left", willChange: "transform" }}
                initial={reduce ? { opacity: 0 } : { opacity: 0, scaleX: 0.02 }}
                whileInView={
                  reduce ? { opacity: 1 } : { opacity: 1, scaleX: 1 }
                }
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1] }}
              />
              <Reveal className="pl-8">
                <p className="mt-3 font-mono text-caption uppercase text-midnight-ink">
                  Quality floor · <span className="tabular-nums">0.90</span> ·{" "}
                  <span className="text-fog">default</span>
                </p>
                <p className="mt-1.5 max-w-[52ch] text-body text-driftwood">
                  A candidate must match your shipped output at 0.90 or better
                  to be recommended at all. It’s the shipped default, not a
                  measured result — raise it wherever your task needs it.
                </p>
              </Reveal>
            </div>

            {/* Abstain — below the line. The pratfall turned into the trust argument. */}
            <Reveal delay={0.06} className="pl-8">
              <RungRow rung={ABSTAIN}>
                <p className="mt-3 max-w-[48ch] text-body text-driftwood">
                  Abstaining is a result, not a gap — it’s the rung that keeps
                  the other four honest.
                </p>
              </RungRow>
            </Reveal>
          </div>
        </div>

        {/* Confidence bands — the key to the ceiling column, defined once. */}
        <div className="mt-14 border-t border-ash-border pt-8">
          <Reveal>
            <h3 className="font-mono text-caption uppercase text-fog">
              Confidence bands
            </h3>
            <dl className="mt-5 grid gap-x-10 gap-y-5 sm:grid-cols-2">
              {BANDS.map((band) => (
                <div key={band.label}>
                  <dt className="font-mono text-caption uppercase text-midnight-ink">
                    {band.label}
                  </dt>
                  <dd className="mt-1.5 max-w-[46ch] text-body text-driftwood">
                    {band.def}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-8 font-mono text-caption text-fog">
              Task families shown are illustrative examples.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
