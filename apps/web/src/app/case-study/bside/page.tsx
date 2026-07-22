// Case study: B:Side Assist. AssistAI's 11 layers moved from a single all-Terra/xhigh default to
// a per-workload routing policy. Wears the blog article surface (BlogShell, prose kit, BlogCta)
// with the case-study kit for the masthead and figure windows; the two bespoke tables here (the
// 4-column evaluation ledger) stay local. Fully static; every figure is quoted verbatim from the
// engagement write-up, baseline stamped assumed/projected and right-sized quality stamped measured.

import type { Metadata } from "next";
import { AnimatedNumber } from "@/components/animated-number";
import { BlogCta } from "@/components/blog/blog-cta";
import { BlogShell } from "@/components/blog/blog-shell";
import { H2, Lead, P, Prose, PullQuote, A } from "@/components/blog/prose";
import {
  Artifact,
  CaseStudyHeader,
  RouteRows,
  StatCell,
} from "@/components/case-study/artifacts";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { BSIDE } from "@/content/case-studies";
import { SITE_AUTHOR, SITE_NAME, SITE_URL } from "@/lib/site";

const study = BSIDE;
const url = `${SITE_URL}/case-study/${study.slug}`;

export const metadata: Metadata = {
  title: { absolute: `${study.company} case study · ${SITE_NAME}` },
  description: study.description,
  alternates: { canonical: `/case-study/${study.slug}` },
  openGraph: {
    type: "article",
    title: study.title,
    description: study.description,
    url,
    siteName: SITE_NAME,
    publishedTime: study.date,
    authors: [SITE_AUTHOR],
    images: [
      { url: study.hero.src, width: 1200, height: 630, alt: study.hero.alt },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: study.title,
    description: study.description,
    images: [study.hero.src],
  },
};

const articleLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: study.title,
  description: study.description,
  image: `${SITE_URL}${study.hero.src}`,
  datePublished: study.date,
  dateModified: study.date,
  author: { "@type": "Organization", name: SITE_AUTHOR },
  publisher: {
    "@type": "Organization",
    name: SITE_NAME,
    logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` },
  },
  mainEntityOfPage: { "@type": "WebPage", "@id": url },
  about: {
    "@type": "Organization",
    name: study.company,
    url: study.website,
  },
};

const breadcrumbLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
    {
      "@type": "ListItem",
      position: 2,
      name: "Case studies",
      item: `${SITE_URL}/case-study`,
    },
    { "@type": "ListItem", position: 3, name: study.title, item: url },
  ],
};

// The routing policy rightmodeler produced: 11 layers folded into six routes.
const POLICY = [
  { route: "luna · low", covers: "quick responses, follow-ups, summaries" },
  { route: "luna · medium", covers: "document extraction and vision" },
  { route: "luna · high", covers: "Business Wiki and failure recovery" },
  { route: "luna · xhigh", covers: "grounded research, the only xhigh route" },
  { route: "terra · high", covers: "orchestration, validation, repair" },
  { route: "sol", covers: "reserved for demanding fallbacks" },
];

// Per-20-query evaluation, verbatim. The quality row is the punchline and renders emphasised.
const METRICS = [
  {
    label: "inference cost",
    baseline: "$0.05119",
    routed: "$0.01493",
    delta: "70.8% lower",
  },
  {
    label: "total response time",
    baseline: "50.46s",
    routed: "23.54s",
    delta: "53.3% faster",
  },
  {
    label: "avg response time",
    baseline: "2.523s",
    routed: "1.177s",
    delta: "1.346s saved/query",
  },
  {
    label: "reasoning tokens",
    baseline: "2,347.64",
    routed: "730.30",
    delta: "68.9% fewer",
  },
  {
    label: "total tokens",
    baseline: "6,552.79",
    routed: "4,935.45",
    delta: "24.7% fewer",
  },
  {
    label: "throughput",
    baseline: "23.78 q/min",
    routed: "50.97 q/min",
    delta: "114.3% higher",
  },
  {
    label: "quality pass rate",
    baseline: "100% assumed",
    routed: "100% measured",
    delta: "0-point difference",
    punchline: true,
  },
];

const METRICS_GRID =
  "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr)";

export default function BsideCaseStudyPage() {
  return (
    <BlogShell>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />

      <article className="pb-4">
        <CaseStudyHeader study={study} />

        <Prose>
          <Lead>
            <A href={study.website}>B:Side Assist</A> is a financial
            intelligence platform that helps businesses understand their
            financial position. Its AI copilot, AssistAI, answers questions
            using connected bank accounts, transactions, uploaded financial
            documents, business context, and current research.
          </Lead>
          <P>
            To the user, it is one chat response. Behind the scenes, producing
            that response can involve several specialized AI jobs: one model
            call interprets the question, another inspects a document, another
            calculates a financial scenario, and another validates or repairs
            the final answer. AssistAI runs 11 of these layers, from greetings
            and summaries to validation, research, vision, and recovery.
          </P>
          <P>
            Each layer asks for something different. A greeting or a summary
            should be fast and inexpensive, while validating financial
            calculations or conducting grounded research deserves deeper
            reasoning. Right-sizing that stack produced the numbers below.
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="assistai · right-sized outcome"
            meta="projected per 20 queries"
            footer="pass rate held at 100%, measured on the same benchmark"
          >
            <div className="grid grid-cols-1 divide-y divide-ash-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <StatCell label="lower inference cost">
                <AnimatedNumber
                  value={70.8}
                  decimals={1}
                  suffix="%"
                  durationMs={900}
                />
              </StatCell>
              <StatCell label="faster end to end">
                <AnimatedNumber
                  value={53.3}
                  decimals={1}
                  suffix="%"
                  durationMs={900}
                />
              </StatCell>
              <StatCell label="higher throughput">
                <AnimatedNumber
                  value={114.3}
                  decimals={1}
                  suffix="%"
                  durationMs={900}
                />
              </StatCell>
            </div>
          </Artifact>
        </Reveal>

        <Prose>
          <H2>The challenge</H2>
          <P>
            The assumed starting architecture used gpt-5.6-terra with xhigh
            reasoning across every AssistAI layer. Terra is a capable, balanced
            model, and xhigh tells it to devote substantial reasoning effort to
            the task. That combination makes sense for difficult financial
            analysis. As the default for everything, it treats routine
            extraction and genuinely difficult analysis as if they were the same
            job, and it maximizes theoretical reasoning in places nobody
            benefits from it.
          </P>
          <PullQuote>
            It was the AI equivalent of using a supercomputer to sort a
            spreadsheet: exceptionally capable, but unnecessarily expensive and
            slow for much of the work.
          </PullQuote>
          <P>
            And the waste compounds. One user question can trigger multiple
            model calls, so small inefficiencies at each layer accumulate into
            slower responses and higher inference costs.
          </P>

          <H2>What rightmodeler changed</H2>
          <P>
            rightmodeler evaluated AssistAI as 11 distinct workloads rather than
            one generic AI request. Each layer was benchmarked on its own traces
            and matched to the cheapest model and reasoning effort that held its
            quality bar. The resulting policy:
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="rightmodeler · routing policy · assistai"
            meta="baseline: terra · xhigh everywhere"
          >
            <RouteRows rows={POLICY} />
          </Artifact>
        </Reveal>

        <Prose>
          <P>
            The shape of the policy tells the story. Most of the traffic moves
            to Luna. Terra stays only where it earns its price: orchestration,
            validation, and repair, the layers where a wrong answer is
            expensive. xhigh reasoning survives in exactly one place, grounded
            research, where reasoning depth is the product itself. And Sol waits
            in reserve for the rare fallback that genuinely needs it.
          </P>

          <H2>Projected results</H2>
          <P>
            These figures model the all Terra, all xhigh starting point using
            actual benchmark traces, current OpenAI pricing, and the observed
            xhigh reasoning and latency uplift from the grounded research
            workload.
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="rightmodeler · assistai evaluation"
            meta="per 20 queries · 11 workloads"
            footer="modeled from actual benchmark traces · current OpenAI pricing · observed xhigh uplift from grounded research"
          >
            {/* Desktop ledger */}
            <div className="hidden sm:block">
              <div
                className="grid h-9 items-center gap-x-3 border-b border-ash-border px-4 font-mono text-caption text-fog"
                style={{ gridTemplateColumns: METRICS_GRID }}
              >
                <span>metric</span>
                <span className="text-right">all terra · xhigh</span>
                <span className="text-right">right-sized</span>
                <span className="text-right">improvement</span>
              </div>
              <div className="divide-y divide-ash-border">
                {METRICS.map((m) => (
                  <div
                    key={m.label}
                    className="grid items-center gap-x-3 px-4 py-2.5 font-mono text-[13px]"
                    style={{ gridTemplateColumns: METRICS_GRID }}
                  >
                    <span
                      className={
                        m.punchline
                          ? "font-medium text-midnight-ink"
                          : "text-driftwood"
                      }
                    >
                      {m.label}
                    </span>
                    <span
                      className={`text-right tabular-nums ${
                        m.punchline
                          ? "font-medium text-midnight-ink"
                          : "text-fog"
                      }`}
                    >
                      {m.baseline}
                    </span>
                    <span
                      className={`text-right tabular-nums text-midnight-ink ${
                        m.punchline ? "font-medium" : ""
                      }`}
                    >
                      {m.routed}
                    </span>
                    {m.punchline ? (
                      <span className="flex justify-end">
                        <span className="inline-flex w-fit items-center rounded border border-ash-border px-1.5 py-0.5 font-mono text-caption font-medium text-midnight-ink">
                          {m.delta}
                        </span>
                      </span>
                    ) : (
                      <span className="text-right tabular-nums text-midnight-ink">
                        {m.delta}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Mobile: stacked records so nothing scrolls sideways */}
            <div className="divide-y divide-ash-border sm:hidden">
              {METRICS.map((m) => (
                <div key={m.label} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={`font-mono text-[13px] ${
                        m.punchline
                          ? "font-medium text-midnight-ink"
                          : "text-midnight-ink"
                      }`}
                    >
                      {m.label}
                    </span>
                    {m.punchline ? (
                      <span className="inline-flex w-fit shrink-0 items-center rounded border border-ash-border px-1.5 py-0.5 font-mono text-caption font-medium text-midnight-ink">
                        {m.delta}
                      </span>
                    ) : (
                      <span className="shrink-0 font-mono text-caption tabular-nums text-driftwood">
                        {m.delta}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-caption text-fog">
                    <span>
                      terra · xhigh{" "}
                      <span className="tabular-nums">{m.baseline}</span>
                    </span>
                    <span aria-hidden>→</span>
                    <span>
                      right-sized{" "}
                      <span className="tabular-nums text-midnight-ink">
                        {m.routed}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Artifact>
        </Reveal>

        <Prose>
          <P>
            The row that matters most is the one that did not move. The baseline
            assumed a 100% quality pass rate; the right-sized policy measured
            100% on the same benchmark. Cheaper and faster only count if quality
            holds.
          </P>
          <PullQuote>
            The savings are only real because quality held: 100% measured, not
            assumed.
          </PullQuote>

          <H2>At scale</H2>
          <P>
            Per-query savings look small until you multiply them. At the
            evaluation prices, the modeled cost reduction compounds:
          </P>
        </Prose>

        <Reveal className="mx-auto my-8 max-w-2xl px-6 sm:my-10 sm:px-8">
          <Artifact
            title="assistai · savings at volume"
            meta="modeled at current pricing"
            footer="projected at current Standard pricing · scales linearly with volume"
          >
            <div className="grid grid-cols-1 divide-y divide-ash-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <StatCell label="saved per 1,000 queries">
                <span className="tabular-nums">$1.81</span>
              </StatCell>
              <StatCell label="saved per million queries">
                <span className="tabular-nums">$1,813</span>
              </StatCell>
            </div>
          </Artifact>
        </Reveal>

        <Prose>
          <P>
            The mechanics are simple. Current Standard pricing puts Terra at
            $2.50 per million input tokens and $15 per million output tokens,
            while Luna runs $1 and $6. Every routine call that Luna handles at a
            fraction of Terra&rsquo;s price, at equal measured quality, is
            margin recovered.
          </P>
          <P>
            This is what rightmodeler produces: not a cheaper model, a policy.
            Eleven workloads, each on the smallest model and reasoning effort
            that provably holds its quality bar, with Terra and Sol kept for the
            work that deserves them.
          </P>
        </Prose>

        <BlogCta />
      </article>
    </BlogShell>
  );
}
