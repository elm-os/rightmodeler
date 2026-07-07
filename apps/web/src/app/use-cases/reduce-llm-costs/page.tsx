import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Reduce LLM costs",
  description:
    "Cut your agent's model bill without guessing. rightmodeler proves which steps can move to cheaper models on your own traces, with evidence and a quality floor on every call.",
  path: "/use-cases/reduce-llm-costs",
});

// Illustrative per-step ledger — the same shape rightmodeler emits, mirroring the home hero's rows.
// Every figure is an example, not a measured result; the abstain row keeps the honest "it declines
// to gamble" beat.
const ROWS: {
  step: string;
  from: string;
  to: string;
  save: string;
  quality: string;
  evidence: string;
  dim?: boolean;
}[] = [
  {
    step: "pr_summary",
    from: "gpt-4.1",
    to: "gpt-4o-mini",
    save: "72%",
    quality: "0.94",
    evidence: "reference + judge",
  },
  {
    step: "json_extraction",
    from: "gpt-4o",
    to: "gpt-4o-mini",
    save: "68%",
    quality: "1.00",
    evidence: "deterministic",
  },
  {
    step: "sql_generation",
    from: "gpt-4o",
    to: "deepseek-chat",
    save: "55%",
    quality: "0.91",
    evidence: "reference",
  },
  {
    step: "auth_code_edit",
    from: "gpt-4.1",
    to: "n/a",
    save: "n/a",
    quality: "n/a",
    evidence: "abstain · high-risk",
    dim: true,
  },
];

const FAQ: FaqItem[] = [
  {
    q: "Will cutting cost hurt quality?",
    a: "Only if you downgrade blind. rightmodeler proves each swap against the output you already shipped and enforces a quality floor, so a step moves to a cheaper model only when quality holds. When it can't prove that, it abstains and keeps the frontier model.",
  },
  {
    q: "How much can I save?",
    a: "It depends on your traces: which steps are over-provisioned, and how cheap a model still clears your quality floor. rightmodeler measures it on your own runs rather than quoting a benchmark; the figures on this page are an illustrative example, not measured results.",
  },
  {
    q: "Do I have to switch models everywhere?",
    a: "No. The audit is per step, not all-or-nothing. Adopt one safe swap and leave the rest on the frontier model.",
  },
];

export default function ReduceLlmCostsPage() {
  return (
    <PageShell>
      <JsonLd
        data={breadcrumbLd(
          "Cut your agent's model bill",
          "/use-cases/reduce-llm-costs",
        )}
      />

      <PageHero
        eyebrow="Use case · Reduce LLM costs"
        title="Cut your agent's model bill without guessing."
        lede="Find the steps that overpay for a frontier model, and prove the cheaper swap before you ship it."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal>
            <Tldr>
              Most of your model spend hides in a few over-provisioned steps.
              rightmodeler finds them, proves the cheaper swap on{" "}
              <span className="text-midnight-ink">your own traces</span>, and
              leaves the risky ones on the frontier model.
            </Tldr>
          </Reveal>

          {/* Problem → solution: a hairline-divided pair, not two boxes. The muted problem sets up
              the inked solution label as the payoff. */}
          <Reveal className="mt-12 grid grid-cols-1 gap-y-8 border-y border-ash-border py-8 sm:grid-cols-2 sm:gap-y-0 sm:divide-x sm:divide-ash-border">
            <div className="sm:pr-10">
              <p className="font-mono text-caption uppercase text-fog">
                The problem
              </p>
              <p className="mt-3 text-body text-driftwood">
                Your agent calls a frontier model on every step, even the ones a
                cheaper model handles perfectly. The bill scales with the
                biggest model you touch, and you can&apos;t tell which steps are
                overpaying without risking quality to find out.
              </p>
            </div>
            <div className="sm:pl-10">
              <p className="font-mono text-caption uppercase text-midnight-ink">
                With rightmodeler
              </p>
              <p className="mt-3 text-body text-driftwood">
                It replays each step through cheaper candidates on your real
                inputs, judges the output against what you shipped, and shows
                exactly which swaps are safe, with savings and evidence on every
                call. You apply the safe ones; it abstains on the rest.
              </p>
            </div>
          </Reveal>

          {/* Illustrative per-step ledger */}
          <Reveal delay={0.08} className="mt-12">
            <div className="overflow-hidden rounded-xl border border-ash-border bg-warm-sand">
              <div className="flex items-center justify-between border-b border-ash-border px-4 py-3">
                <span className="font-mono text-caption text-driftwood">
                  cheaper-models · per-step
                </span>
                <span className="font-mono text-caption text-fog">
                  [ illustrative example ]
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] border-collapse font-mono text-[13px]">
                  <thead>
                    <tr className="border-b border-ash-border text-fog">
                      <th className="px-4 py-2.5 text-left font-normal">
                        Step
                      </th>
                      <th className="px-4 py-2.5 text-left font-normal">
                        Current → Candidate
                      </th>
                      <th className="px-4 py-2.5 text-right font-normal">
                        Save
                      </th>
                      <th className="px-4 py-2.5 text-right font-normal">
                        Quality
                      </th>
                      <th className="px-4 py-2.5 text-left font-normal">
                        Evidence
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((r) => {
                      const ink = r.dim ? "text-fog" : "text-midnight-ink";
                      return (
                        <tr
                          key={r.step}
                          className="border-b border-ash-border last:border-0"
                        >
                          <td className={`px-4 py-2.5 ${ink}`}>{r.step}</td>
                          <td className="px-4 py-2.5">
                            <span
                              className={
                                r.dim ? "text-fog" : "text-midnight-ink"
                              }
                            >
                              {r.from}
                            </span>
                            <span className="text-fog"> → </span>
                            <span
                              className={
                                r.dim ? "text-fog" : "text-midnight-ink"
                              }
                            >
                              {r.to}
                            </span>
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right tabular-nums ${ink}`}
                          >
                            {r.save}
                          </td>
                          <td
                            className={`px-4 py-2.5 text-right tabular-nums ${ink}`}
                          >
                            {r.quality}
                          </td>
                          <td className="px-4 py-2.5 text-driftwood">
                            {r.evidence}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-3 font-mono text-caption text-fog">
              Illustrative example, not measured results. rightmodeler produces
              figures like these from your own traces.
            </p>
          </Reveal>

          <Reveal delay={0.12} className="mt-10">
            <GithubButton />
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
                { href: "/glossary", label: "Glossary" },
                { href: "/manifesto", label: "Read the manifesto" },
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
