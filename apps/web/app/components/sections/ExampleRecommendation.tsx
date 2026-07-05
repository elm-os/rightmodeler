// ExampleRecommendation — the payoff artifact. One task family's full recommendation, rendered
// as the file cheaper-models actually emits: a warm-sand report on the parchment canvas, mono for
// machine data, sans for human advice, monochrome throughout. Signature: a discrete-node evidence
// ladder that makes "medium confidence" legible as provenance (the top rung stays n/a, so it's
// medium not high; abstain is drawn-but-not-taken). Every figure is an illustrative example.
//
// No "use client": this file composes the client primitives (Reveal, AnimatedNumber) but holds no
// hooks, handlers, or motion of its own, so it stays a server component.

import { AnimatedNumber } from "../AnimatedNumber";
import { Reveal } from "../Reveal";

type Rung = {
  tier: string;
  value: string;
  // used  — this rung produced graded evidence (inked)
  // na    — not applicable to a single-shot free-text summary (hollow)
  // exit  — the abstain door, drawn but not taken (dimmed)
  state: "used" | "na" | "exit";
};

const LADDER: Rung[] = [
  { tier: "deterministic", value: "n/a", state: "na" },
  { tier: "reference", value: "×12", state: "used" },
  { tier: "trajectory", value: "n/a", state: "na" },
  { tier: "llm-judge", value: "×6", state: "used" },
  { tier: "abstain", value: "not taken", state: "exit" },
];

const RISKS = [
  "The match is judged, not proven — medium confidence means shadow it before you rely on it live.",
  "Evidence is tied to this prompt and these runs; re-judge if the pr_summary prompt changes.",
];

const ROLLOUT = [
  "Shadow gpt-4o-mini on the next pr_summary runs — no live traffic.",
  "Diff each summary against the gpt-4.1 output you already ship.",
  "Promote to default only once quality holds at or above the 0.90 floor. Keep gpt-4.1 as the fallback.",
];

export function ExampleRecommendation() {
  return (
    <section className="bg-parchment-white">
      <div className="mx-auto w-full max-w-4xl px-6 py-20 sm:px-10 sm:py-28">
        {/* Section header — left-aligned, not centered */}
        <Reveal className="max-w-2xl">
          <p className="font-mono text-caption uppercase text-driftwood">
            The report
          </p>
          <h2 className="mt-3 font-display text-heading text-balance text-midnight-ink">
            One recommendation, in full.
          </h2>
          <p className="mt-4 font-sans text-body text-driftwood">
            A single card from the report — every field the pipeline emits for
            one task family, and the evidence behind it. The figures are an
            illustrative example.
          </p>
        </Reveal>

        {/* The report artifact — reads top-to-bottom like the emitted file */}
        <Reveal delay={0.08} className="mt-10">
          <article className="divide-y divide-ash-border overflow-hidden rounded-2xl border border-ash-border bg-warm-sand">
            {/* Header bar — machine identity + persistent honesty label */}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-4 sm:px-8">
              <p className="font-mono text-caption text-driftwood">
                cheaper-models · recommendation · pr_summary
              </p>
              <p className="font-mono text-caption text-fog">
                [ illustrative example ]
              </p>
            </div>

            {/* Verdict + payoff numbers */}
            <div className="px-6 py-6 sm:px-8 sm:py-7">
              <p className="font-sans text-caption uppercase text-driftwood">
                Recommended downgrade
              </p>
              <h3 className="mt-2 font-display text-heading-lg text-midnight-ink">
                Safe to downgrade.
              </h3>
              {/* Swap couplet — direction carried by monochrome hierarchy, not hue */}
              <p className="mt-3 font-mono text-body">
                <span className="text-driftwood">gpt-4.1</span>
                <span aria-hidden className="px-2 text-fog">
                  →
                </span>
                <span className="text-midnight-ink">gpt-4o-mini</span>
              </p>
              <p className="mt-3 max-w-xl font-sans text-body text-driftwood">
                A single-shot step with a shipped reference to grade against —
                swapping it can’t cascade into later work.
              </p>

              {/* Number ledger — the one inset well; only 72% animates */}
              <div className="mt-6 rounded-xl border border-ash-border bg-parchment-white px-5 py-5 sm:px-6">
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <AnimatedNumber
                      value={72}
                      suffix="%"
                      durationMs={900}
                      className="font-display text-heading text-midnight-ink sm:text-display"
                    />
                    <p className="mt-1 font-mono text-caption text-driftwood">
                      cost reduction
                    </p>
                  </div>
                  <div>
                    <span className="font-display text-heading tabular-nums text-midnight-ink sm:text-display">
                      0.94
                    </span>
                    <p className="mt-1 font-mono text-caption text-driftwood">
                      quality score · floor 0.90
                    </p>
                  </div>
                </div>
                <p className="mt-4 font-mono text-caption text-fog">
                  cost reduction · quality score — illustrative example
                </p>
              </div>
            </div>

            {/* Evidence — the signature. Ladder on the left, its reading on the right */}
            <div className="px-6 py-6 sm:px-8 sm:py-7">
              <p className="font-mono text-caption uppercase text-driftwood">
                Evidence
              </p>
              <div className="mt-4 grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
                {/* Discrete-node ladder — strongest → weakest, top → bottom */}
                <div>
                  <ul className="relative flex flex-col gap-3">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute left-[5px] top-2 bottom-2 w-px bg-ash-border"
                    />
                    {LADDER.map((rung) => {
                      const inked = rung.state === "used";
                      return (
                        <li key={rung.tier} className="flex items-center gap-3">
                          <span
                            aria-hidden
                            className={`relative z-10 h-2.5 w-2.5 shrink-0 rounded-sm ${
                              inked
                                ? "bg-midnight-ink"
                                : rung.state === "na"
                                  ? "border border-fog bg-warm-sand"
                                  : "border border-silver-mist bg-warm-sand"
                            }`}
                          />
                          <span
                            className={`font-mono text-caption ${
                              inked ? "text-midnight-ink" : "text-fog"
                            }`}
                          >
                            {rung.tier}
                          </span>
                          <span
                            className={`ml-auto font-mono text-caption ${
                              inked ? "text-midnight-ink" : "text-fog"
                            }`}
                          >
                            {rung.value}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-3 font-sans text-caption text-fog">
                    Filled rungs produced graded evidence.
                  </p>
                </div>

                {/* Reading of the ladder: confidence band + provenance + judge */}
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-caption">
                      <span className="text-driftwood">confidence</span>
                      <span className="text-fog">abstain</span>
                      <span aria-hidden className="text-fog">
                        ·
                      </span>
                      <span className="text-fog">low</span>
                      <span aria-hidden className="text-fog">
                        ·
                      </span>
                      <span className="border-b border-midnight-ink text-midnight-ink">
                        medium
                      </span>
                      <span aria-hidden className="text-fog">
                        ·
                      </span>
                      <span className="text-fog">high</span>
                    </div>
                    <p className="mt-2 font-sans text-caption text-driftwood">
                      Medium, not high: a free-text summary can’t be graded
                      deterministically, so the top rung stays n/a.
                    </p>
                  </div>
                  <div className="border-t border-ash-border pt-4">
                    <p className="font-mono text-caption text-driftwood">
                      18 historical runs · 12 reference comparisons · 6
                      LLM-judge evaluations{" "}
                      <span className="text-fog">— illustrative example</span>
                    </p>
                    <p className="mt-3 font-sans text-caption text-driftwood">
                      Judged by a model from a third family — neither gpt-4.1
                      nor gpt-4o-mini — so nothing grades its own work.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Risks (unordered set) + Rollout (real sequence) */}
            <div className="grid grid-cols-1 gap-x-10 gap-y-6 px-6 py-6 sm:grid-cols-2 sm:px-8 sm:py-7">
              <div>
                <p className="font-mono text-caption uppercase text-driftwood">
                  Risks
                </p>
                <ul className="mt-3 flex flex-col gap-3">
                  {RISKS.map((risk) => (
                    <li
                      key={risk}
                      className="flex gap-3 font-sans text-body text-driftwood"
                    >
                      <span aria-hidden className="text-fog">
                        —
                      </span>
                      <span>{risk}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-mono text-caption uppercase text-driftwood">
                  Suggested rollout
                </p>
                <ol className="mt-3 flex list-none flex-col gap-3">
                  {ROLLOUT.map((step, i) => (
                    <li
                      key={step}
                      className="flex gap-3 font-sans text-body text-midnight-ink"
                    >
                      <span
                        aria-hidden
                        className="font-mono text-body text-fog"
                      >
                        {i + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            {/* Footer — report-not-router, from your own runs */}
            <div className="px-6 py-4 sm:px-8">
              <p className="font-mono text-caption text-fog">
                cheaper-models — generated from your own runs, not benchmarks. A
                report, not a router: every swap waits for your approval.
              </p>
            </div>
          </article>
        </Reveal>
      </div>
    </section>
  );
}
