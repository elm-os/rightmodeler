// AgentDecisionSpine — the agent's loop as one continuous pipeline spine, echoing the
// /how-it-works page grammar (numbered junctions on a static ash-border hairline, display-quiet
// step records with a hairline-topped machine-output line) so the two pages read as one system.
// The numbering is earned: Watch → Replay → Judge → Open the PR is a real ordered loop, and the
// in/out labels make the whole section a function signature: a model release goes in, a pull
// request comes out. Server component — motion is the shared Reveal only; the spine never draws.

import { Reveal } from "@/components/reveal";

const STEPS: {
  n: string;
  name: string;
  body: string;
  label: string;
  line: string;
}[] = [
  {
    n: "01",
    name: "Watch",
    body: "Every release, every provider. The agent tracks the live model catalog and flags candidates that could beat a step in your stack on price, speed, or quality, the moment they ship.",
    label: "watches",
    line: "releases · prices · context windows · tool support  →  candidates per step",
  },
  {
    n: "02",
    name: "Replay",
    body: "Candidates rerun your real traces, not a benchmark. Single-shot steps replay in isolation; tool and loop steps re-execute end to end in a sandboxed worktree, so cascade failures surface before a PR ever exists.",
    label: "replays",
    line: "your traces · sandboxed worktree · end to end  →  candidate outputs",
  },
  {
    n: "03",
    name: "Judge",
    body: "Each output is judged against what you already shipped: a different model family, position-swapped, with your quality floor as the bar. Weak evidence means no PR. The agent abstains instead of guessing.",
    label: "judges",
    line: "cross-family · reference-guided · abstains on weak evidence  →  verdict + confidence",
  },
  {
    n: "04",
    name: "Open the PR",
    body: "When a swap clears your floor and your preferences, the agent opens a pull request with the diff, the numbers, and the replayed traces behind them. Merging stays yours.",
    label: "opens",
    line: "diff + evidence + confidence  →  your review",
  },
];

export function AgentDecisionSpine() {
  return (
    <section className="bg-parchment-white">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
        <Reveal className="max-w-xl">
          <p className="font-mono text-caption uppercase text-fog">
            How it decides
          </p>
          <h2 className="mt-4 font-display text-heading text-balance text-midnight-ink">
            From release notes to a reviewable diff.
          </h2>
          <p className="mt-4 text-body text-driftwood">
            The same proof loop as the rightmodeler skill, running on a schedule
            instead of on demand. Nothing reaches your repo without surviving
            all four steps.
          </p>
        </Reveal>

        <div className="relative mt-14">
          {/* The spine: one static hairline spanning the whole loop. */}
          <div
            aria-hidden
            className="absolute top-2 bottom-2 left-4 w-px bg-ash-border sm:left-5"
          />

          <div className="grid grid-cols-[2rem_1fr] items-center gap-x-5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-7">
            <span className="flex justify-center">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-ash-border"
              />
            </span>
            <p className="font-mono text-caption text-fog">
              in ▸ a new model release
            </p>
          </div>

          <ol className="mt-8 space-y-12">
            {STEPS.map((step, i) => (
              <Reveal key={step.n} delay={i * 0.06}>
                <li className="grid grid-cols-[2rem_1fr] gap-x-5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-7">
                  <div className="flex justify-center">
                    <span className="relative z-10 mt-1 flex size-8 items-center justify-center rounded-full border border-ash-border bg-parchment-white font-mono text-caption text-driftwood sm:size-9 sm:text-body">
                      {step.n}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-sans text-heading-sm text-midnight-ink">
                      {step.name}
                    </h3>
                    <p className="mt-3 max-w-prose text-body text-driftwood">
                      {step.body}
                    </p>
                    <p className="mt-4 border-t border-ash-border pt-3 font-mono text-[13px] text-driftwood">
                      <span className="text-fog">{step.label} </span>
                      {step.line}
                    </p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>

          <div className="mt-10 grid grid-cols-[2rem_1fr] items-center gap-x-5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-7">
            <span className="flex justify-center">
              <span aria-hidden className="h-px w-3 bg-ash-border" />
            </span>
            <p className="font-mono text-caption text-fog">
              out ▸ a pull request in your repo
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
