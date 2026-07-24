import type { ReactNode } from "react";
import { Reveal } from "@/components/reveal";

// HowItWorks: the methodology as one continuous, top-to-bottom pipeline spine.
// The 01–04 ordinals are junctions on a static ash-border spine (a genuine ordered
// pipeline, so the numbering encodes real flow direction). Between each card, an
// artifact chip sits ON the spine and grows richer as it descends:
// per_step → profiled → verdict+confidence → signed report, so the reader watches
// one illustrative step (`pr_summary`) travel from raw trace to a signed decision.
// Each card renders the product's own vernacular (the 9 trace sources, the per-step
// schema fields, the two replay modes, the tone-graded evidence ladder, a faithful
// TUI sliver) instead of an icon+title+blurb. Elevation is pure surface contrast:
// parchment canvas → warm-sand card → recessed ink/5 slab. Motion is the shared
// Reveal only (static spine, no draw); animated-number is deliberately withheld because
// the illustrative numbers are data inside an artifact, not hero metrics.

type Step = {
  n: string;
  title: string;
  sentence: string;
  substance: ReactNode;
  junction: string | null;
};

// One reusable label/value row for the recessed substance slab. The fixed label
// column keeps the value column aligned down each card, giving the mono blocks a
// record-like read without hand-set leading or an off-scale grid.
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-x-3">
      <span className="w-20 shrink-0 text-fog">{label}</span>
      <span className="min-w-0 text-driftwood">{children}</span>
    </div>
  );
}

const arrow = <span className="text-fog"> → </span>;
const dot = <span className="text-fog"> · </span>;

export function HowItWorks() {
  const steps: Step[] = [
    {
      n: "01",
      title: "Ingest & normalize",
      sentence:
        "Point it at the traces you already emit. It autodetects the format across nine sources and folds every run into one per-step schema.",
      substance: (
        <div className="flex flex-col gap-y-2 font-mono text-[13px]">
          <Row label="reads">
            Claude Code · Codex · LangSmith / LangGraph · OpenAI SDK · Langfuse
            · Braintrust · Phoenix · OTel GenAI · LiteLLM
          </Row>
          <Row label="folds">
            9 sources{arrow}
            <span className="text-midnight-ink">1 per-step schema</span>
          </Row>
        </div>
      ),
      junction: "e.g. pr_summary · per_step",
    },
    {
      n: "02",
      title: "Map your pipeline",
      sentence:
        "Every step gets a profile: what it runs, the kind of task it is, and how risky it is to touch, so the audit goes per step, not all-or-nothing.",
      substance: (
        <div className="overflow-x-auto font-mono text-[13px]">
          <div className="min-w-max whitespace-nowrap">
            <Row label="per step">
              model{dot}task_family{dot}shot{dot}strongest_evaluator{dot}cost
              {dot}risk
            </Row>
          </div>
        </div>
      ),
      junction: "pr_summary · profiled",
    },
    {
      n: "03",
      title: "Replay & judge",
      sentence:
        "Shortlist cheaper models from your selected replay provider and re-run each step on your real inputs. Single-shot steps replay in isolation; tool and loop steps re-execute their code in a sandboxed git worktree, so cascades surface before you ship them.",
      substance: (
        <div className="flex flex-col gap-y-2 font-mono text-[13px]">
          <Row label="replay">
            single-shot{arrow}isolated{dot}tool / loop{arrow}sandboxed git
            worktree
          </Row>
          <Row label="judge">
            cross-family{dot}position-swapped{dot}reference-guided
          </Row>
          <Row label="evidence">
            <span className="text-midnight-ink">deterministic</span>
            <span className="text-fog"> → </span>
            <span className="text-midnight-ink">reference</span>
            <span className="text-fog"> → </span>
            <span className="text-driftwood">trajectory</span>
            <span className="text-fog"> → </span>
            <span className="text-driftwood">cross-family judge</span>
            <span className="text-fog"> → </span>
            <span className="text-fog">abstain</span>
          </Row>
        </div>
      ),
      junction: "pr_summary · verdict + confidence",
    },
    {
      n: "04",
      title: "Approve & report",
      sentence:
        "Nothing swaps on its own. You approve each downgrade in the TUI and get a per-step report: savings, quality, evidence, confidence, and cascade flags. When the evidence isn’t there, it abstains and keeps the frontier model.",
      substance: (
        <div className="font-mono text-[13px]">
          <div className="border-b border-ash-border px-1 pb-2 text-driftwood">
            rightmodeler · per-step approval
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-max whitespace-nowrap pt-2">
              <div className="px-1 py-1 text-fog">
                st · step · current → candidate · save · Q · flag
              </div>
              <div className="px-1 py-1">
                <span className="text-midnight-ink">✓</span>
                {dot}
                <span className="text-midnight-ink">pr_summary</span>
                {dot}gpt-4.1{arrow}gpt-4o-mini{dot}
                <span className="text-midnight-ink">72%</span>
                {dot}
                <span className="text-midnight-ink">0.94</span>
                {dot}n/a
              </div>
              <div className="px-1 py-1">
                <span className="text-fog">✕</span>
                {dot}auth_code_edit{dot}gpt-4.1{arrow}n/a{dot}n/a{dot}n/a{dot}
                <span className="text-fog">abstain · high-risk</span>
              </div>
            </div>
          </div>
          <p className="px-1 pt-3 text-caption text-fog">
            illustrative example: no savings figure until it runs on your traces
          </p>
        </div>
      ),
      junction: null,
    },
  ];

  return (
    <section id="how-it-works" className="bg-parchment-white text-midnight-ink">
      <div className="mx-auto max-w-4xl px-6 py-24 sm:px-10 sm:py-32">
        {/* Header: left-aligned editorial block, capped to a readable measure. */}
        <Reveal className="max-w-xl">
          <p className="font-mono text-caption uppercase text-fog">
            How it works · 01-04
          </p>
          <h2 className="mt-4 text-balance font-display text-heading text-midnight-ink sm:text-heading-lg">
            Four steps from your own traces to a swap you can defend.
          </h2>
          <p className="mt-4 text-body text-driftwood">
            It proves each swap on runs you already shipped: a report, not a
            runtime gateway. Follow one step down the pipeline: raw trace to an
            approved, or abstained, decision.
          </p>
        </Reveal>

        {/* Pipeline: one static, continuous spine; cards Reveal over it in order. */}
        <div className="relative mt-14">
          {/* The spine: a single ash-border hairline spanning the whole pipeline,
              never segmented as the cards stagger in. */}
          <div
            aria-hidden
            className="absolute bottom-2 left-5 top-2 w-px bg-ash-border sm:left-7"
          />

          {/* Spine head: the pipeline's input. */}
          <Reveal className="grid grid-cols-[2.5rem_1fr] items-center gap-x-4 sm:grid-cols-[3.5rem_1fr] sm:gap-x-6">
            <div className="flex justify-center">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-ash-border"
              />
            </div>
            <p className="font-mono text-caption text-fog">in ▸ raw traces</p>
          </Reveal>

          {steps.map((step, i) => (
            <Reveal
              key={step.n}
              delay={i * 0.06}
              className={i === 0 ? "mt-6" : "mt-8"}
            >
              {/* Card row: ordinal node on the spine + the record card. */}
              <div className="grid grid-cols-[2.5rem_1fr] gap-x-4 sm:grid-cols-[3.5rem_1fr] sm:gap-x-6">
                <div className="flex justify-center pt-5 sm:pt-6">
                  <span className="flex size-9 items-center justify-center rounded-md border border-ash-border bg-parchment-white font-mono text-body text-driftwood">
                    {step.n}
                  </span>
                </div>
                <div className="rounded-xl border border-ash-border bg-warm-sand p-5 sm:p-6">
                  <h3 className="font-sans text-heading-sm text-midnight-ink">
                    {step.title}
                  </h3>
                  <p className="mt-2 max-w-prose text-body text-driftwood">
                    {step.sentence}
                  </p>
                  <div className="mt-4 rounded-lg border border-ash-border bg-midnight-ink/5 p-4">
                    {step.substance}
                  </div>
                </div>
              </div>

              {/* Junction: the artifact this step hands to the next, on the spine. */}
              {step.junction && (
                <div className="mt-3 grid grid-cols-[2.5rem_1fr] items-center gap-x-4 sm:grid-cols-[3.5rem_1fr] sm:gap-x-6">
                  <div className="flex justify-center">
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full bg-fog"
                    />
                  </div>
                  <p className="font-mono text-caption text-fog">
                    <span aria-hidden>▸ </span>
                    {step.junction}
                  </p>
                </div>
              )}
            </Reveal>
          ))}

          {/* Spine foot: the pipeline resolves to a signed report. */}
          <Reveal
            delay={0.24}
            className="mt-8 grid grid-cols-[2.5rem_1fr] items-center gap-x-4 sm:grid-cols-[3.5rem_1fr] sm:gap-x-6"
          >
            <div className="flex justify-center">
              <span aria-hidden className="h-px w-3 bg-ash-border" />
            </div>
            <p className="font-mono text-caption text-fog">
              out ▸ signed report
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
