"use client";

// Differentiators — three honest moat pillars, read as an annotated report, not a 3-up grid.
// Through-line: three REAL fields from packages/contracts (confidence · risk_flags · evidence_type)
// each rendered as a fragment lifted from the product's own output. Quiet–LOUD–quiet: a static
// abstain verdict, one animated cascade (the only motion beyond the entrance), a static evidence
// ladder whose tone ramp encodes strength. Strictly monochrome — no accent hues, elevation by
// surface contrast. Every model name / flag is labelled "illustrative example".

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Reveal } from "@/components/reveal";

// The shared spine: a real schema field name + a hairline rule. The same grammar on every card is
// what makes the three read as one system rather than three siblings; the field itself differs.
function FieldToken({ name }: { name: string }) {
  return (
    <div className="mb-6 flex items-center gap-4">
      <code className="font-mono text-body text-midnight-ink">{name}</code>
      <span aria-hidden className="h-px flex-1 bg-ash-border" />
    </div>
  );
}

function InsetCaption({ children }: { children: ReactNode }) {
  return <p className="mt-5 font-mono text-caption text-fog">{children}</p>;
}

// One evidence-ladder rung. The left bar steps from solid ink (strongest) to dashed silver-mist
// (abstain); the label tone follows. Strength is encoded by the brand's own hierarchy mechanism —
// no color-coding, no chart, no fabricated number.
function Rung({
  bar,
  labelTone,
  label,
  desc,
}: {
  bar: string;
  labelTone: string;
  label: string;
  desc: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 border-l-2 pl-3 ${bar}`}
    >
      <span className={`font-mono text-body ${labelTone}`}>{label}</span>
      <span className="font-mono text-body text-fog">{desc}</span>
    </div>
  );
}

export function Differentiators() {
  const reduce = useReducedMotion();
  const once = { once: true, margin: "-80px" } as const;

  return (
    <section className="bg-parchment-white py-20 sm:py-28">
      {/* Hover is a color-only deepen, gated to real hover pointers so a tap never sticks it on. */}
      <style>{`
        @media (hover: hover) and (pointer: fine) {
          .rm-diff-card {
            transition: border-color 200ms ease, background-color 200ms ease;
          }
          .rm-diff-card:hover {
            border-color: var(--color-silver-mist);
            background-color: color-mix(in oklab, var(--color-warm-sand), var(--color-midnight-ink) 3%);
          }
        }
      `}</style>

      <div className="mx-auto w-full max-w-4xl px-6 sm:px-10">
        {/* Header — left-weighted, ragged-right, nothing centered. */}
        <Reveal>
          <p className="font-mono text-caption text-fog uppercase">
            What makes a downgrade trustworthy
          </p>
          <h2 className="mt-4 max-w-[20ch] font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            The strongest thing a recommender can do is refuse.
          </h2>
          <p className="mt-5 max-w-[62ch] text-subheading text-driftwood">
            rightmodeler proves cheaper-model swaps on your own runs. Three
            fields ride on every recommendation and keep the proof checkable —
            when it won&rsquo;t switch, what a swap would break, and the
            evidence behind the score.
          </p>
        </Reveal>

        <div className="mt-12 flex flex-col gap-4 sm:mt-16 sm:gap-6">
          {/* CARD 1 — confidence · abstain (quiet). The em-dash void is the loudest mark. */}
          <Reveal delay={0.04}>
            <article className="rm-diff-card rounded-xl border border-ash-border bg-warm-sand p-6 sm:p-8">
              <FieldToken name="confidence" />
              <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:items-center md:gap-10">
                <div>
                  <h3 className="text-heading-sm font-medium text-midnight-ink">
                    It tells you when not to switch.
                  </h3>
                  <p className="mt-3 text-body text-driftwood">
                    Abstain is a first-class answer, not a fallback. When a
                    step&rsquo;s traces are too sparse to judge — or it touches
                    a high-risk family like auth, billing, migrations, or
                    deploys — the report returns no candidate instead of a shaky
                    one.
                  </p>
                </div>

                <div className="rounded-lg border border-ash-border bg-parchment-white p-5 sm:p-6">
                  <div className="overflow-x-auto">
                    <div className="grid min-w-[15rem] grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 font-mono text-body">
                      <span className="text-fog">task_family</span>
                      <span className="text-midnight-ink">
                        auth_code_edit{" "}
                        <span className="text-fog">[high-risk]</span>
                      </span>
                      <span className="text-fog">confidence</span>
                      <span className="text-midnight-ink">abstain</span>
                    </div>
                  </div>

                  <div className="mt-5 border-t border-ash-border pt-5">
                    <p className="font-mono text-caption text-fog">
                      recommended_model
                    </p>
                    <p className="mt-1 flex items-center gap-3">
                      <span className="font-mono text-body text-fog">
                        gpt-4.1 →
                      </span>
                      <span
                        aria-hidden
                        className="font-display text-heading text-midnight-ink"
                      >
                        —
                      </span>
                    </p>
                    <p className="mt-1 font-mono text-caption text-fog">
                      null · no candidate cleared the bar
                    </p>
                  </div>

                  <InsetCaption>illustrative example</InsetCaption>
                </div>
              </div>
            </article>
          </Reveal>

          {/* CARD 2 — risk_flags · cascade (LOUD). Full-width diagram; the one animated moment. */}
          <Reveal delay={0.12}>
            <article className="rm-diff-card rounded-xl border border-ash-border bg-warm-sand p-6 sm:p-8">
              <FieldToken name="risk_flags" />
              <div className="max-w-[62ch]">
                <h3 className="text-heading-sm font-medium text-midnight-ink">
                  Cascade-aware.
                </h3>
                <p className="mt-3 text-body text-driftwood">
                  A model that wins on its own step can break the step that
                  depends on it. rightmodeler re-runs your real pipeline —
                  tools, loops, and all — in a sandboxed git worktree, so a
                  downstream break shows up in the report, not in production
                  after you ship the swap.
                </p>
              </div>

              <div className="mt-6 rounded-lg border border-ash-border bg-parchment-white p-5 sm:p-6">
                <div className="overflow-x-auto">
                  <div className="flex min-w-[22rem] flex-col font-mono text-body">
                    {/* Step 1 */}
                    <div className="flex items-center gap-3">
                      <span className="w-5 shrink-0 text-fog">1</span>
                      <span className="w-36 shrink-0 text-midnight-ink">
                        retrieve
                      </span>
                      <span className="flex-1 text-driftwood">
                        reused as-is
                      </span>
                      <span className="text-fog">ok</span>
                    </div>
                    {/* connector 1 → 2 (static hairline) */}
                    <div className="flex">
                      <span className="flex w-5 justify-center">
                        <span
                          aria-hidden
                          className="block h-4 w-px bg-ash-border"
                        />
                      </span>
                    </div>
                    {/* Step 2 — the swap */}
                    <div className="flex items-center gap-3">
                      <span className="w-5 shrink-0 text-fog">2</span>
                      <span className="w-36 shrink-0 text-midnight-ink">
                        tool_agent
                      </span>
                      <span className="flex-1 text-midnight-ink">
                        opus-4 <span className="text-fog">→</span> llama-3.3
                      </span>
                      <span className="text-fog">swapped</span>
                    </div>
                    {/* connector 2 → 3 — the signature: an ink line drawing downstream */}
                    <div className="flex">
                      <span className="flex w-5 justify-center">
                        <motion.span
                          aria-hidden
                          className="block h-5 w-px bg-midnight-ink"
                          initial={{
                            clipPath: reduce
                              ? "inset(0% 0% 0% 0%)"
                              : "inset(0% 0% 100% 0%)",
                          }}
                          whileInView={{ clipPath: "inset(0% 0% 0% 0%)" }}
                          viewport={once}
                          transition={{
                            duration: 0.42,
                            ease: [0.77, 0, 0.175, 1],
                          }}
                        />
                      </span>
                    </div>
                    {/* Step 3 — the downstream break */}
                    <div className="flex items-center gap-3">
                      <span className="w-5 shrink-0 text-fog">3</span>
                      <span className="w-36 shrink-0 text-midnight-ink">
                        json_extraction
                      </span>
                      <span className="flex-1 text-driftwood">
                        malformed output
                      </span>
                      <motion.span
                        className="text-midnight-ink"
                        initial={{ opacity: reduce ? 1 : 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={once}
                        transition={{
                          duration: 0.18,
                          ease: [0.23, 1, 0.32, 1],
                          delay: reduce ? 0 : 0.42,
                        }}
                      >
                        [cascade]
                      </motion.span>
                    </div>
                  </div>
                </div>

                <InsetCaption>illustrative example</InsetCaption>
              </div>
            </article>
          </Reveal>

          {/* CARD 3 — evidence_type (quiet). Tone ramp encodes strength; bottoms out at abstain. */}
          <Reveal delay={0.2}>
            <article className="rm-diff-card rounded-xl border border-ash-border bg-warm-sand p-6 sm:p-8">
              <FieldToken name="evidence_type" />
              <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] md:gap-10">
                <div>
                  <h3 className="text-heading-sm font-medium text-midnight-ink">
                    Evidence, not vibes.
                  </h3>
                  <p className="mt-3 text-body text-driftwood">
                    Every call climbs an evidence ladder, strongest rung first.
                    The judge near the top always sits in a different model
                    family than either candidate, so no model grades its own
                    kind — and where the rungs run out, it abstains.
                  </p>
                </div>

                <div className="rounded-lg border border-ash-border bg-parchment-white p-5 sm:p-6">
                  <div className="flex flex-col gap-3">
                    <Rung
                      bar="border-midnight-ink"
                      labelTone="text-midnight-ink"
                      label="deterministic check"
                      desc="exact, gate-able"
                    />
                    <Rung
                      bar="border-midnight-ink"
                      labelTone="text-midnight-ink"
                      label="reference comparison"
                      desc="vs. what you shipped"
                    />
                    <Rung
                      bar="border-driftwood"
                      labelTone="text-driftwood"
                      label="trajectory / tool-use eval"
                      desc="re-runs the pipeline"
                    />
                    <Rung
                      bar="border-driftwood"
                      labelTone="text-driftwood"
                      label="cross-family judge"
                      desc="different model family"
                    />
                    <Rung
                      bar="border-dashed border-silver-mist"
                      labelTone="text-fog"
                      label="abstain"
                      desc="evidence too thin"
                    />
                  </div>
                  <p className="mt-4 font-mono text-caption text-fog">
                    → confidence on every call
                  </p>
                  <InsetCaption>illustrative example</InsetCaption>
                </div>
              </div>
            </article>
          </Reveal>
        </div>

        <Reveal delay={0.08}>
          <p className="mt-10 max-w-[70ch] font-mono text-caption text-fog">
            Rows, model names, and flags above are illustrative examples —
            rightmodeler reports figures only from your own runs, and the
            shipped pipeline emits none by default.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
