import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { AgentShowcase } from "@/components/sections/agent-showcase";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { WaitlistForm } from "@/components/sections/waitlist-form";
import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "rightmodeler agent",
  description:
    "rightmodeler agent tests new model releases against your real traces and opens evidence-backed model-swap pull requests when a change clears your bar.",
  path: "/agent",
  image: "/social/agent.png",
});

// The guardrails record — the agent moves only inside these. Rendered as an illustrative config
// slab in the policy section; label/value rows keep the mono block aligned like a real file.
const POLICY: { key: string; value: string }[] = [
  {
    key: "quality_floor",
    value: `${ILLUSTRATIVE_SCORECARD.floor} · judged against shipped outputs`,
  },
  { key: "max_cost_usd", value: "optional · hard stop when set, uncapped when not" },
  { key: "models", value: "allow openai · anthropic · google · meta" },
  { key: "evaluator", value: "braintrust · falls back to cross-family judge" },
  { key: "merge", value: "open PR only · never auto-merge" },
];

const FAQ: FaqItem[] = [
  {
    q: "What is rightmodeler agent?",
    a: "An autonomous agent that keeps every step of your AI stack on the right model. It watches new model releases, replays them against your real traces, judges each output against what you already shipped, and opens a pull request in your repo when a swap clears your quality floor and preferences.",
  },
  {
    q: "When can I use it?",
    a: "Today, if you self-host: the agent ships in the open-source repo and runs on your own infrastructure with your own GitHub and model credentials. Join the waitlist for the hosted version and we will send one note when early access opens.",
  },
  {
    q: "Does it merge changes on its own?",
    a: "No. The agent opens pull requests; merging stays with you, and it carries no merge capability at all. Your configuration sets the guardrails: the quality floor, a model allowlist and denylist, an optional hard spend cap per run (omit it and every case runs to completion when evidence matters more than cost), and which evaluator scores the replays.",
  },
  {
    q: "What does it evaluate against?",
    a: "Your own traces and the outputs you already shipped, not public benchmarks. Judging is cross-family, position-swapped, and reference-guided, and the agent abstains instead of opening a PR when the evidence is weak.",
  },
  {
    q: "How is it different from the rightmodeler skill?",
    a: "Same proof loop, different cadence. The skill is an audit you run when you want it. The agent runs that loop on a schedule: it re-checks prices as they decay, watches approved swaps for drift, reconciles open swap pull requests as CI reports back, and turns each result into a pull request you review.",
  },
];

export default function AgentPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("rightmodeler agent", "/agent")} />

      <PageHero
        eyebrow="Open source · by rightmodeler"
        title="The last model migration you do by hand."
        lede="A new model ships. rightmodeler agent replays it against your real traces, prices the swap, and opens a pull request with the evidence attached. You review it like any other change. It lives in the open-source repo today; a hosted version is on the way."
      >
        <div className="max-w-md">
          <WaitlistForm product="agent" />
          <p className="mt-3 font-mono text-caption text-fog">
            Get hosted early access. One note when it opens, no spam.
          </p>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {/* The feature spread — the deliverable and the loop, filling the framed column. */}
      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-20">
          <AgentShowcase />
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {/* Guardrails + where it runs + the honesty ethos. */}
      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal className="max-w-xl">
            <h2 className="font-display text-heading text-balance text-midnight-ink">
              Your preferences are the policy.
            </h2>
            <p className="mt-4 text-body text-driftwood">
              The agent moves only inside guardrails you set. Your configuration
              decides what counts as better, which models it may propose, and
              how much a run may spend.
            </p>
          </Reveal>

          <Reveal delay={0.06} className="mt-8">
            <div className="overflow-x-auto rounded-lg border border-ash-border bg-midnight-ink/5 p-4">
              <div className="flex min-w-max flex-col gap-y-2 font-mono text-[13px] sm:min-w-0">
                {POLICY.map((row) => (
                  <div key={row.key} className="flex gap-x-3">
                    <span className="w-28 shrink-0 text-fog">{row.key}</span>
                    <span className="min-w-0 text-driftwood">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 font-mono text-caption text-fog">
              illustrative config
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-12">
            <h3 className="font-sans text-heading-sm text-midnight-ink">
              Runs where your work lives.
            </h3>
            <div className="mt-4 flex flex-wrap gap-2">
              {["Self-hosted", "Scheduled runs", "Your API keys"].map(
                (chip) => (
                  <span
                    key={chip}
                    className="inline-flex items-center rounded-md border border-ash-border bg-parchment-white px-3 py-1.5 font-mono text-caption text-driftwood"
                  >
                    {chip}
                  </span>
                ),
              )}
            </div>
            <p className="mt-4 max-w-xl text-body text-driftwood">
              Nothing sits in your request path. The agent wakes on a schedule,
              does its work, opens a PR, and goes back to sleep.
            </p>
          </Reveal>

          <ul className="mt-12 divide-y divide-ash-border border-y border-ash-border">
            <Reveal>
              <li className="py-5">
                <p className="font-sans text-heading-sm text-midnight-ink">
                  Receipts on every PR
                </p>
                <p className="mt-1 text-body text-driftwood">
                  The diff ships with quality scores, cost deltas, latency, and
                  the replayed traces behind them. When a reviewer asks why, the
                  answer is already attached.
                </p>
              </li>
            </Reveal>
            <Reveal delay={0.06}>
              <li className="py-5">
                <p className="font-sans text-heading-sm text-midnight-ink">
                  It abstains
                </p>
                <p className="mt-1 text-body text-driftwood">
                  No candidate clears your floor, no PR. A tool that always
                  finds a swap is not measuring anything.
                </p>
              </li>
            </Reveal>
            <Reveal delay={0.12}>
              <li className="py-5">
                <p className="font-sans text-heading-sm text-midnight-ink">
                  Every swap is reversible
                </p>
                <p className="mt-1 text-body text-driftwood">
                  Each applied change records the exact files it touched before
                  and after. One command opens the pull request that restores
                  the pre-swap state, and it refuses if the files have moved on
                  without it.
                </p>
              </li>
            </Reveal>
          </ul>

          <Reveal delay={0.1} className="mt-10">
            <p className="max-w-xl text-body text-driftwood">
              The proof engine behind the agent is the rightmodeler skill, and
              you can run it on your own traces today.
            </p>
            <div className="mt-6">
              <GithubButton />
            </div>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How the proof works" },
                { href: "/crucible", label: "Crucible, the analytics suite" },
                {
                  href: "/blog/the-tuesday-problem",
                  label: "Read the vision: the Tuesday problem",
                },
              ]}
            />
          </div>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <Faq items={FAQ} />
    </PageShell>
  );
}
