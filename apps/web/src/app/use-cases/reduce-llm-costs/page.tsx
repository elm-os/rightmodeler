import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Reduce LLM costs",
  description:
    "Cut your agent's model bill without guessing. rightmodeler proves which steps can move to cheaper models on your own traces, with evidence and a quality floor on every call.",
  path: "/use-cases/reduce-llm-costs",
  image: "/social/reduce-llm-costs.png",
});

// ── The before/after band: five muted failures against five proven answers, item for item,
// separated by dotted hairlines the way the reference draws them.

const BEFORE: string[] = [
  "Every step runs the frontier model, because nobody can prove a cheaper one holds.",
  "Swaps happen on vibes: a leaderboard, a launch thread, a hunch. Regressions ship silently.",
  "The invoice is one number. Which step spent it, nobody can say.",
  "Evaluating one candidate properly is a two-day project, so it stays unscheduled.",
  "The expensive default survives another quarter, and the bill scales with your growth.",
];

const AFTER: string[] = [
  "Every step is audited on your own traces, and the safe swaps are proven per step.",
  "Candidates are judged against the output you already shipped, with a quality floor.",
  "The report has line items: save, quality, evidence, and confidence for every call.",
  "One command on the traces you already have. No new SDK, nothing in your request path.",
  "Weak evidence means abstain: the frontier model stays exactly where it earns its price.",
];

const FAQ: { q: string; a: string }[] = [
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
  {
    q: "Do I need new instrumentation?",
    a: "No. rightmodeler reads the traces you already emit across eight formats, folds them into one per-step schema, and runs offline. Nothing sits in your request path.",
  },
];

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

// ── The two mockups tucked into the CTA cards, clipped by the card edges like the reference's
// chat window and code panel. Figures are stamped illustrative; shadows are illustration-only.

const MOCKUP_SHADOW = "shadow-[0_12px_32px_rgba(41,36,31,0.08)]";

// Left card: the per-step report, mid-scroll. The abstain row keeps the honest beat.
function LedgerMockup() {
  const rows: { step: string; swap: string; meta: string; dim?: boolean }[] = [
    {
      step: "summarize",
      swap: "gpt-5.6 → gpt-5.4-mini",
      meta: "save 85% · Q 0.94",
    },
    {
      step: "extract_json",
      swap: "gpt-5.5 → gpt-5.4-nano",
      meta: "save 96% · Q 1.00",
    },
    {
      step: "sql_generation",
      swap: "gpt-5.6 → gpt-5.4",
      meta: "save 50% · Q 0.91",
    },
    {
      step: "auth_code_edit",
      swap: "stays on gpt-5.6",
      meta: "abstain · high-risk",
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
            illustrative
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

// Monochrome "syntax" tones for the config panel: structure in driftwood, comments in fog,
// values in ink.
const Ln = ({ children }: { children: React.ReactNode }) => (
  <div className="whitespace-pre text-driftwood">{children}</div>
);
const C = ({ children }: { children: React.ReactNode }) => (
  <span className="text-fog">{children}</span>
);
const V = ({ children }: { children: React.ReactNode }) => (
  <span className="text-midnight-ink">{children}</span>
);

// Right card: the audit as configuration, running off the card's corner like the reference's
// code panel.
function ConfigMockup() {
  return (
    <div className="relative -mr-6 mb-0 ml-4 mt-6 sm:-mr-8 sm:ml-6">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white p-4 sm:p-5 ${MOCKUP_SHADOW}`}
      >
        <div className="space-y-1 font-mono text-[12px]">
          <Ln>
            <C>{"// rightmodeler.config.ts"}</C>
          </Ln>
          <div aria-hidden className="h-3" />
          <Ln>{"export default audit({"}</Ln>
          <Ln>
            {"  traces: "}
            <V>{'"./traces/*.jsonl"'}</V>
            {","}
          </Ln>
          <Ln>
            {"  reference: "}
            <V>{'"shipped"'}</V>
            {","}
          </Ln>
          <Ln>
            {"  floor: "}
            <V>0.90</V>
            {","}
          </Ln>
          <Ln>
            {"  judge: "}
            <V>{'"cross-family"'}</V>
            {","}
          </Ln>
          <Ln>{"});"}</Ln>
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
      <JsonLd data={faqLd} />

      <PageHero
        eyebrow="Use case · Reduce LLM costs"
        title="Cut your agent's model bill without guessing."
        lede="Find the steps that overpay for a frontier model, and prove the cheaper swap before you ship it."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {/* ── Before / after: two full-bleed columns split by the center hairline, five muted
          failures answered item for item, dotted rules between entries like the reference. ── */}
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

      {/* ── Two ways in: run the audit now, or line up the continuous versions. Each card holds
          its mockup clipped by the card edge. ── */}
      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <div className="grid gap-4 sm:gap-5 md:grid-cols-2">
            <Reveal className="h-full">
              <div className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand">
                {/* Same subtle grain as the agent page's deliverable panel. */}
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
                    Run the audit today
                  </h2>
                  <p className="mt-2 max-w-md text-body text-driftwood">
                    One command installs the skill. The report runs on the
                    traces you already have and hands you the safe swaps.
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
                    Then make it continuous
                  </h2>
                  <p className="mt-2 max-w-md text-body text-driftwood">
                    The agent will ship safe swaps as pull requests, and
                    Crucible keeps every layer watched. Both are on the way.
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

      {/* ── FAQ: the display title on the left, dotted-ruled answers on the right. ── */}
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
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
