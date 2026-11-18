import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { ILLUSTRATIVE_SCORECARD, TRACE_SOURCES } from "@/lib/product-facts";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Reduce LLM costs",
  description:
    "Frontier everywhere costs too much. rightmodeler validates cheaper or newer models on your production traces and opens a draft PR when a swap clears every gate.",
  path: "/use-cases/reduce-llm-costs",
  image: "/social/reduce-llm-costs.png",
});

// The canonical definition from docs/positioning.md: reuse it verbatim wherever safe is defined.
const SAFE =
  "A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.";

const BEFORE: string[] = [
  "Every step runs the frontier model, because nobody has measured a cheaper candidate on accepted outputs.",
  "Swaps happen on vibes: a leaderboard, a launch thread, a hunch. Regressions ship silently.",
  "The invoice is one number. Which step spent it, nobody can say.",
  "Evaluating one candidate properly is a two-day project, so it stays unscheduled.",
  "The expensive default survives another quarter, and the bill scales with your growth.",
];

const AFTER: string[] = [
  "Steps are validated on your own traces, with candidate agreement measured per step.",
  "Only cheaper models are candidates, each judged against the output you accepted and held to your quality floor.",
  "The report has line items: save, quality, evidence, and sample size for every step.",
  "One command on the traces you already have. No new SDK, nothing in your request path.",
  "Thin evidence means abstain: the frontier model stays exactly where it earns its price.",
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Will cutting cost hurt quality?",
    a: `rightmodeler does not establish ground-truth quality. ${SAFE} You review that evidence in a draft pull request before any model changes.`,
  },
  {
    q: "How much can I save?",
    a: "It depends on your traces: which steps are over-provisioned, and how cheap a model still clears your quality floor. rightmodeler measures it on your own runs rather than quoting a general benchmark; the figures on this page are an illustrative example, not measured results.",
  },
  {
    q: "Do I have to switch models everywhere?",
    a: "No. Validation is per step, not all-or-nothing. Only a step whose cheaper candidate clears every gate gets a draft pull request; every other step stays on its current model.",
  },
  {
    q: "Do I need new instrumentation?",
    a: `Not to validate a step. rightmodeler reads the traces you already emit across ${TRACE_SOURCES.length} formats, folds them into one per-step schema, and runs offline. Nothing sits in your request path. Only end-to-end confirmation, for a step that feeds later model steps, needs your app to tag each model call with its step.`,
  },
];

// Figures are stamped illustrative; shadows are illustration-only.

const MOCKUP_SHADOW = "shadow-[0_12px_32px_rgba(41,36,31,0.08)]";

function LedgerMockup() {
  const rows: { step: string; swap: string; meta: string; dim?: boolean }[] = [
    {
      step: "summarize",
      swap: "gpt-5.6 → gpt-5.4-mini",
      meta: `save 85% · Q ${ILLUSTRATIVE_SCORECARD.approved}`,
    },
    {
      step: "extract_json",
      swap: "gpt-5.5 → gpt-5.4-nano",
      meta: `save 96% · Q ${ILLUSTRATIVE_SCORECARD.deterministic}`,
    },
    {
      step: "sql_generation",
      swap: "gpt-5.6 → gpt-5.4",
      meta: `save 50% · Q ${ILLUSTRATIVE_SCORECARD.alternative}`,
    },
    {
      step: "auth_code_edit",
      swap: "stays on gpt-5.6",
      meta: "abstain · thin evidence",
      dim: true,
    },
  ];
  return (
    <div className="relative mx-4 -mb-12 mt-6 sm:mx-6">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white ${MOCKUP_SHADOW}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ash-border px-4 py-2.5">
          <span className="min-w-0 truncate font-mono text-caption text-driftwood">
            rightmodeler · per-step report
          </span>
          <span className="shrink-0 font-mono text-caption text-fog">
            {ILLUSTRATIVE_SCORECARD.label}
          </span>
        </div>
        <div className="divide-y divide-ash-border">
          {rows.map((row) => (
            <div key={row.step} className="px-4 py-2.5 font-mono text-[12px]">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={`min-w-0 truncate ${row.dim ? "text-fog" : "text-midnight-ink"}`}
                >
                  {row.step}
                </span>
                <span
                  className={`shrink-0 ${row.dim ? "text-fog" : "text-fog"}`}
                >
                  {row.meta}
                </span>
              </div>
              <div
                className={`mt-0.5 ${row.dim ? "text-fog" : "text-driftwood"}`}
              >
                {row.swap}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const Ln = ({ children }: { children: React.ReactNode }) => (
  <div className="whitespace-pre text-driftwood">{children}</div>
);
const C = ({ children }: { children: React.ReactNode }) => (
  <span className="text-fog">{children}</span>
);
const V = ({ children }: { children: React.ReactNode }) => (
  <span className="text-midnight-ink">{children}</span>
);

function ConfigMockup() {
  return (
    <div className="relative -mr-6 mb-0 ml-4 mt-6 sm:-mr-8 sm:ml-6">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white p-4 sm:p-5 ${MOCKUP_SHADOW}`}
      >
        <div className="space-y-1 font-mono text-[12px]">
          <Ln>
            <C>{`// policy.json · ${ILLUSTRATIVE_SCORECARD.label}`}</C>
          </Ln>
          <div aria-hidden className="h-3" />
          <Ln>{"{"}</Ln>
          <Ln>
            {'  "qualityFloor": '}
            <V>{ILLUSTRATIVE_SCORECARD.floor}</V>
            {","}
          </Ln>
          <Ln>
            {'  "shortlistTop": '}
            <V>3</V>
            {","}
          </Ln>
          <Ln>
            {'  "denyModels": ['}
            <V>{'"llama-4-nano"'}</V>
            {"]"}
          </Ln>
          <Ln>{"}"}</Ln>
        </div>
      </div>
    </div>
  );
}

const pillPrimary =
  "inline-flex items-center justify-center rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";
const pillSecondary =
  "inline-flex items-center justify-center rounded-xl border border-ash-border bg-parchment-white px-5 py-3 text-body font-medium text-midnight-ink transition-[background-color,transform] duration-150 ease-out hover:bg-warm-sand active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

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
        lede="Frontier everywhere costs too much: the most expensive model on every step feels safe until the bill compounds, call by call, on steps nobody has measured. rightmodeler validates cheaper or newer models on your production traces and opens a draft pull request only where a swap clears every gate."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="relative grid lg:grid-cols-2 lg:divide-x lg:divide-ash-border">
          <div className="p-6 sm:p-10 lg:p-12">
            <Reveal>
              <h2 className="font-sans text-heading-sm text-midnight-ink">
                Before rightmodeler
              </h2>
              <ul className="mt-8">
                {BEFORE.map((item, i) => (
                  <li
                    key={item}
                    className={`flex gap-4 py-5 ${
                      i > 0 ? "border-t border-dotted border-ash-border" : ""
                    }`}
                  >
                    <span aria-hidden className="font-mono text-fog">
                      ✕
                    </span>
                    <span className="text-body text-driftwood">{item}</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>

          <div className="border-t border-ash-border p-6 sm:p-10 lg:border-t-0 lg:p-12">
            <Reveal delay={0.06}>
              <h2 className="font-sans text-heading-sm text-midnight-ink">
                With rightmodeler
              </h2>
              <ul className="mt-8">
                {AFTER.map((item, i) => (
                  <li
                    key={item}
                    className={`flex gap-4 py-5 ${
                      i > 0 ? "border-t border-dotted border-ash-border" : ""
                    }`}
                  >
                    <span aria-hidden className="font-mono text-midnight-ink">
                      ✓
                    </span>
                    <span className="text-body text-midnight-ink">{item}</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <div className="grid gap-4 sm:gap-5 md:grid-cols-2">
            <Reveal className="h-full">
              <div className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand">
                <Image
                  src="/agent/showcase-grain.jpg"
                  alt=""
                  fill
                  aria-hidden
                  className="-z-10 object-cover object-left-bottom"
                  sizes="(min-width: 768px) 50vw, 100vw"
                />
                <div className="p-6 sm:p-7">
                  <h2 className="font-sans text-heading-sm text-midnight-ink">
                    Run a validation today.
                  </h2>
                  <p className="mt-2 max-w-md text-body text-driftwood">
                    One command, nothing to install, on the traces you already
                    have. Validation is what makes a saving worth taking:
                    rightmodeler abstains where the evidence is thin and opens a
                    draft pull request only for a swap that clears every gate.
                  </p>
                  <div className="mt-5">
                    <GithubButton />
                  </div>
                </div>
                <div className="mt-auto">
                  <LedgerMockup />
                </div>
              </div>
            </Reveal>

            <Reveal delay={0.06} className="h-full">
              <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand">
                <div className="p-6 sm:p-7">
                  <h2 className="font-sans text-heading-sm text-midnight-ink">
                    Then put it on a schedule.
                  </h2>
                  <p className="mt-2 max-w-md text-body text-driftwood">
                    Run the same validation weekly in CI with the GitHub Actions
                    recipe in the docs, or self-host the agent: it checks the
                    catalog every week for cheaper new or repriced models, and
                    on your word it replays a new candidate and opens each swap
                    that clears every gate as a draft pull request. The hosted
                    agent has a waitlist. Crucible, in development, is planned
                    as open-source, self-hosted observability for AI agents and
                    MCP servers, including cost and latency.
                  </p>
                  <div className="mt-5 flex flex-wrap gap-2.5">
                    <Link href="/agent" className={pillPrimary}>
                      Meet the agent
                    </Link>
                    <Link href="/crucible" className={pillSecondary}>
                      Meet Crucible
                    </Link>
                  </div>
                </div>
                <div className="mt-auto">
                  <ConfigMockup />
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="px-6 py-14 sm:px-10 sm:py-16 lg:px-12">
          <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16">
            <Reveal>
              <h2 className="max-w-xs font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
                Frequently asked questions
              </h2>
            </Reveal>
            <dl>
              {FAQ.map((item, i) => (
                <Reveal key={item.q} delay={i * 0.04}>
                  <div
                    className={`py-6 ${
                      i > 0 ? "border-t border-dotted border-ash-border" : ""
                    }`}
                  >
                    <dt className="text-subheading text-midnight-ink">
                      {item.q}
                    </dt>
                    <dd className="mt-2 max-w-2xl text-body text-driftwood">
                      {item.a}
                    </dd>
                  </div>
                </Reveal>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
          <RelatedLinks
            links={[
              { href: "/how-it-works", label: "How it works" },
              { href: "/glossary", label: "Glossary" },
              { href: "/manifesto", label: "Read the manifesto" },
              { href: "/integrations", label: "Integrations" },
              { href: "/vs", label: "Compare alternatives" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
