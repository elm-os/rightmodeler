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
    "rightmodeler agent flags cheaper models weekly, validates a swap on your traces when you say go, and opens a draft pull request once it clears every gate.",
  path: "/agent",
  image: "/social/agent.png",
});

const POLICY: { key: string; value: string }[] = [
  {
    key: "quality_floor",
    value: `${ILLUSTRATIVE_SCORECARD.floor} · judged against shipped outputs`,
  },
  {
    key: "max_cost_usd",
    value: "optional · hard stop when set, uncapped when not",
  },
  { key: "allow_models", value: "gpt-5.4-mini · gpt-5.4-nano · deepseek-chat" },
  { key: "deny_models", value: "llama-4-nano" },
  {
    key: "evaluator",
    value: "braintrust · a judge from a different vendor when unset",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "What is rightmodeler agent?",
    a: "The maintenance loop for production AI systems, on a schedule. It takes the noticing, re-pricing, re-checking, and pull-request follow-up off a person's plate. Every week it rechecks the provider catalog for cheaper new or repriced models; on your word, it replays a candidate against your traces, judges each output against what you already shipped, and opens a draft pull request in your repo when the swap clears every gate. A person decides whether it merges.",
  },
  {
    q: "When can I use it?",
    a: "Today, if you self-host: the agent is in the MIT-licensed repo, and you clone it, build it, and run it on a long-lived Node 24 host with your own GitHub App and model credentials. The hosted version has a waitlist; join it and we will send one note when it opens.",
  },
  {
    q: "Does it merge changes on its own?",
    a: "No. The agent opens draft pull requests; merging stays with you, and it carries no merge capability at all. It can close a swap pull request whose CI failure repeats, but it never merges, deploys, or swaps a model on its own. That is deliberate: autonomy is earned with evidence, and validation is how rightmodeler earns it. Your policy sets the guardrails: the quality floor, the shortlist size, a model allowlist and denylist, an optional hard spend cap per run (omit it and every case runs to completion when evidence matters more than cost), and which evaluator scores the replays.",
  },
  {
    q: "What does it evaluate against?",
    a: "Your own traces and the outputs you already shipped, not general benchmarks. A judge from a different vendor, or your own evaluator, grades every answer, and the built-in judge runs position-swapped and reference-guided. The statistical lower bound must reach your quality floor on held-out cases (the shortlist half only screens candidates), and the agent abstains instead of opening a PR when the evidence is thin.",
  },
  {
    q: "How is it different from running the CLI myself?",
    a: "Same validation loop, different cadence. The CLI is a validation run you start when you want one. The agent runs that loop on a schedule: a weekly catalog and price check that flags cheaper new or repriced models, follow-up on swap pull requests as review and CI report back, a daily drift check on new traces whose proposals a person approves, and one regression replay for each merged swap set. On your word it replays new candidates, and once a replay clears every gate, it opens the draft pull request.",
  },
];

export default function AgentPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("rightmodeler agent", "/agent")} />

      <PageHero
        eyebrow="Open source · by rightmodeler"
        title="Stop re-checking models by hand."
        lede="rightmodeler agent is the maintenance loop, on a schedule. A weekly catalog and price check flags cheaper new or repriced models and projects what a replay would cost. On your word, it replays the candidate on your production traces and, once the swap clears every gate, opens a draft pull request with the evidence attached. A person says go, and a person merges. Self-host it today from the MIT-licensed repo; the hosted version has a waitlist."
      >
        <div className="max-w-md">
          <WaitlistForm product="agent" />
          <p className="mt-3 font-mono text-caption text-fog">
            Join the hosted version waitlist. One note when it opens, no spam.
          </p>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-20">
          <AgentShowcase />
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal className="max-w-xl">
            <h2 className="font-display text-heading text-balance text-midnight-ink">
              You set the policy.
            </h2>
            <p className="mt-4 text-body text-driftwood">
              The agent works only inside the policy you set: how closely a
              cheaper model must match the outputs you accepted, which models it
              may propose, which evaluator grades the replays, and how much a
              run may spend. There is no merge setting: the agent opens draft
              pull requests, and it will never auto-merge.
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
              does its work offline, reports back, and goes back to sleep.
            </p>
          </Reveal>

          <ul className="mt-12 divide-y divide-ash-border border-y border-ash-border">
            <Reveal>
              <li className="py-5">
                <p className="font-sans text-heading-sm text-midnight-ink">
                  Receipts on every PR.
                </p>
                <p className="mt-1 text-body text-driftwood">
                  Each draft pull request carries its evidence: the worst-case
                  lower bound, cost per case before and after, the winning
                  candidate&rsquo;s p50 latency, the sample size and caps, and
                  the replayed case IDs. When a reviewer asks why, the answer is
                  already attached.
                </p>
              </li>
            </Reveal>
            <Reveal delay={0.06}>
              <li className="py-5">
                <p className="font-sans text-heading-sm text-midnight-ink">
                  It abstains.
                </p>
                <p className="mt-1 text-body text-driftwood">
                  Thin evidence means abstain, and no candidate at your floor
                  means no PR. A tool that always finds a swap is not measuring
                  anything.
                </p>
              </li>
            </Reveal>
            <Reveal delay={0.12}>
              <li className="py-5">
                <p className="font-sans text-heading-sm text-midnight-ink">
                  Rollback is one command.
                </p>
                <p className="mt-1 text-body text-driftwood">
                  Each applied change records the exact files it touched, before
                  and after. One command, run by a person on a merged swap,
                  opens the pull request that restores the exact pre-swap files,
                  and it refuses if those files have moved on since.
                </p>
              </li>
            </Reveal>
          </ul>

          <Reveal delay={0.1} className="mt-10">
            <p className="max-w-xl text-body text-driftwood">
              The validation engine behind the agent is the rightmodeler CLI,
              and you can run it on the traces you already have today with npx
              rightmodeler init.
            </p>
            <div className="mt-6">
              <GithubButton />
            </div>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How the validation works" },
                { href: "/crucible", label: "Crucible, in development" },
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
