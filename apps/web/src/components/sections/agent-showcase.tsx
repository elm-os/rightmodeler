// AgentShowcase — the /agent feature spread: two equal panels over a four-box step row, filling
// the framed column edge to edge. The left panel is the deliverable: the PR-card artifact inset
// from the left and bleeding off the right edge (clipped by the panel), over a grainy
// brand-gradient image that stays visible along the left sliver and bottom band, where the
// caption sits. The right panel carries the TL;DR in a parchment inset box with its own caption
// anchored bottom. Below, the four decision steps as equal boxes (square at desktop), ordinal
// chips instead of icons because the sequence is real. The accent hues live only inside the
// generated grain image; every control and every word stays monochrome. Server component —
// Reveal and the PR card are the client leaves.

import Image from "next/image";
import { Reveal } from "@/components/reveal";
import { AgentPrCard } from "@/components/sections/agent-pr-card";

const STEPS: { n: string; name: string; body: string }[] = [
  {
    n: "01",
    name: "Watch",
    body: "Every release, every provider, tracked live. Candidates get flagged per step the moment they ship.",
  },
  {
    n: "02",
    name: "Replay",
    body: "Candidates rerun your real traces end to end in a sandboxed worktree, so cascade failures surface early.",
  },
  {
    n: "03",
    name: "Judge",
    body: "Each output is judged against what you already shipped, cross-family, with your quality floor as the bar.",
  },
  {
    n: "04",
    name: "Open the PR",
    body: "Diff, evidence, and confidence, opened for your review. Weak evidence means no PR.",
  },
];

export function AgentShowcase() {
  return (
    <div>
      <h2 className="sr-only">How it decides</h2>

      {/* ── The two feature panels: same size, equal-height columns on desktop. ── */}
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        <Reveal className="h-full">
          <div className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand lg:aspect-square">
            {/* Grainy brand-gradient backdrop (decorative; the only place the accents live). */}
            <Image
              src="/agent/showcase-grain.jpg"
              alt=""
              fill
              aria-hidden
              className="-z-10 object-cover object-left-bottom"
              sizes="(min-width: 1024px) 50vw, 100vw"
            />
            {/* The artifact — inset left so the grain shows as a sliver, flush to the top, and
                bleeding off the right edge on desktop like a window onto a wider screen. */}
            <div className="ml-4 sm:ml-8 lg:-mr-16">
              <AgentPrCard />
            </div>

            <div className="mt-auto max-w-lg p-4 pt-6 sm:p-5">
              <p className="font-mono text-caption uppercase text-driftwood">
                The deliverable
              </p>
              <p className="mt-1.5 text-body text-midnight-ink">
                A one-line diff with the receipts attached.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.06} className="h-full">
          <div className="flex h-full flex-col rounded-2xl border border-ash-border bg-warm-sand p-4 sm:p-5 lg:aspect-square">
            <div className="rounded-xl border border-ash-border bg-parchment-white p-5 sm:p-7">
              <p className="font-mono text-caption uppercase text-fog">TL;DR</p>
              <p className="mt-3 text-subheading text-driftwood">
                rightmodeler agent watches every model release, proves the ones
                that beat your current stack on your own traces, and ships the
                swap as{" "}
                <span className="text-midnight-ink">
                  a pull request in your repo
                </span>
                . Model migrations become code review.
              </p>
            </div>

            <div className="mt-auto max-w-md p-1 pt-10 sm:p-2">
              <p className="font-mono text-caption uppercase text-driftwood">
                The loop
              </p>
              <p className="mt-2 text-body text-midnight-ink">
                Watch, replay, judge, open the PR. Continuous, and always inside
                your guardrails.
              </p>
            </div>
          </div>
        </Reveal>
      </div>

      {/* ── The four steps: equal boxes, square at desktop, chip up top and copy anchored low. ── */}
      <div className="mt-4 grid gap-4 sm:mt-5 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <Reveal key={step.n} delay={i * 0.06} className="h-full">
            <div className="flex h-full flex-col rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-6 lg:aspect-square">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-ash-border bg-parchment-white font-mono text-body text-driftwood">
                {step.n}
              </span>
              {/* Fixed offset from the chip (not bottom-anchored) so the four titles sit on the
                  same line across the row regardless of body length. */}
              <div className="mt-8 sm:mt-10">
                <h3 className="font-sans text-heading-sm text-midnight-ink">
                  {step.name}
                </h3>
                <p className="mt-2 text-body text-driftwood">{step.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
