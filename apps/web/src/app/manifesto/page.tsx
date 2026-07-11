import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import {
  LogoMark,
  PullRequestIcon,
  QualityFloorIcon,
  ReplayLoopIcon,
} from "@/components/icons";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Prove it. Don't guess.",
  description:
    "The rightmodeler manifesto: nobody should downgrade a model on vibes. The case for evidence-backed model downgrading, proven on your own traces, not benchmarks.",
  path: "/manifesto",
});

const FAQ: FaqItem[] = [
  {
    q: "What is evidence-backed model downgrading?",
    a: "Moving a step to a cheaper model only after proving, on your own traces, that quality holds against the output you already shipped. The decision is backed by evidence: replays, scores, and a confidence level, not a benchmark or a hunch.",
  },
  {
    q: "How is this different from observability?",
    a: "Observability shows you what happened. It doesn't replay your steps through cheaper models, judge the results, or change anything. rightmodeler proves a specific swap is safe and applies it in your repo: detect, prove, fix.",
  },
  {
    q: "Is it safe to downgrade automatically?",
    a: "rightmodeler never swaps on its own. It abstains when the evidence is weak, flags cascade risk, and leaves the final call, and the repo edit, to you.",
  },
];

// ── The three mockups, layer by layer, in house tokens only. Each one is a still of the product's
// world (a bill with no author, the audit's decision tree, the review that ends it) tucked into
// its card and clipped by the card edge, the way the reference clips its windows. Every figure is
// stamped illustrative on the artifact that shows one. Soft shadows are illustration-only.

const MOCKUP_SHADOW = "shadow-[0_12px_32px_rgba(41,36,31,0.08)]";

// A tiny identity seat for mockup headers: the brand mark in a bordered square.
function AvatarSeat({ size = 7 }: { size?: 6 | 7 }) {
  return (
    <span
      className={`flex ${size === 7 ? "size-7" : "size-6"} shrink-0 items-center justify-center rounded-md border border-ash-border bg-warm-sand text-midnight-ink`}
    >
      <LogoMark height={size === 7 ? 11 : 9} />
    </span>
  );
}

// Card one — the bill: four steps, one frontier model, a total that keeps climbing. The window
// runs off the bottom of the card mid-ledger.
function UsageMockup() {
  const rows: { step: string; cost: string }[] = [
    { step: "route", cost: "$1,180" },
    { step: "extract", cost: "$940" },
    { step: "summarize", cost: "$2,310" },
    { step: "judge", cost: "$860" },
  ];
  return (
    <div className="relative mx-4 -mb-10 mt-4 sm:mx-5">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white ${MOCKUP_SHADOW}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ash-border px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2.5">
            <AvatarSeat />
            <span className="truncate font-sans text-[13px] font-medium text-midnight-ink">
              model usage · June
            </span>
          </span>
          <span className="shrink-0 font-mono text-caption text-fog">
            illustrative
          </span>
        </div>
        <div className="divide-y divide-ash-border">
          {rows.map((row) => (
            <div
              key={row.step}
              className="flex items-baseline justify-between gap-3 px-4 py-2.5 font-mono text-[12px]"
            >
              <span className="min-w-0 truncate">
                <span className="text-midnight-ink">{row.step}</span>
                <span className="text-fog"> · </span>
                <span className="text-driftwood">gpt-5.6</span>
              </span>
              <span className="shrink-0 text-driftwood tabular-nums">
                {row.cost}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-ash-border px-4 py-2.5">
          <span className="font-mono text-caption text-fog">month to date</span>
          <span className="font-sans text-[13px] font-medium text-midnight-ink tabular-nums">
            $5,290 and climbing
          </span>
        </div>
      </div>
    </div>
  );
}

// Card two — the audit's decision tree, drawn as one SVG so nodes, capsules, and connectors stay
// perfectly registered at every width: a trace comes in, candidates replay, and the two verdicts
// land on opposite branches.
function FlowMockup() {
  return (
    <div className="relative mx-3 mb-4 mt-2 sm:mx-4">
      <svg
        viewBox="0 0 480 310"
        className="h-auto w-full"
        aria-hidden
        fill="none"
      >
        <defs>
          <filter
            id="mf-node-shadow"
            x="-30%"
            y="-40%"
            width="160%"
            height="220%"
          >
            <feDropShadow
              dx="0"
              dy="4"
              stdDeviation="7"
              floodColor="#29241f"
              floodOpacity="0.1"
            />
          </filter>
        </defs>

        {/* connectors first, so every node sits above its own line */}
        <g className="stroke-fog" strokeWidth="1.5" strokeLinecap="round">
          <path d="M240 46 v30" />
          <path d="M240 120 C 240 156, 128 152, 128 186" />
          <path d="M240 120 C 240 156, 352 152, 352 186" />
          <path d="M128 216 v22" />
          <path d="M352 216 v22" />
        </g>

        {/* start node */}
        <rect
          x="181"
          y="4"
          width="118"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <path
          d="M200 18 v16 M200 19 h9 l-2.5 3.5 2.5 3.5 h-9"
          className="stroke-driftwood"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text
          x="217"
          y="30"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          new trace
        </text>

        {/* replay node */}
        <rect
          x="132"
          y="78"
          width="216"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <path
          d="M152 94 h10 a4.5 4.5 0 0 1 0 9 h-7 m2.4 -2.4 -2.4 2.4 2.4 2.4"
          className="stroke-driftwood"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text
          x="172"
          y="104"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          replay the candidates
        </text>

        {/* verdict capsules — ink, like the reference's black pills */}
        <rect
          x="59"
          y="186"
          width="138"
          height="30"
          rx="15"
          className="fill-midnight-ink"
        />
        <text
          x="128"
          y="205"
          textAnchor="middle"
          className="fill-parchment-white font-sans"
          fontSize="12.5"
          fontWeight="500"
        >
          clears the floor
        </text>

        <rect
          x="286"
          y="186"
          width="132"
          height="30"
          rx="15"
          className="fill-midnight-ink"
        />
        <text
          x="352"
          y="205"
          textAnchor="middle"
          className="fill-parchment-white font-sans"
          fontSize="12.5"
          fontWeight="500"
        >
          below the floor
        </text>

        {/* leaf nodes */}
        <rect
          x="34"
          y="238"
          width="188"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <text
          x="56"
          y="264"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          ✓
        </text>
        <text
          x="74"
          y="264"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          swap: gpt-5.4-mini
        </text>

        <rect
          x="254"
          y="238"
          width="196"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <text
          x="276"
          y="264"
          className="fill-fog font-sans"
          fontSize="14"
          fontWeight="500"
        >
          ✕
        </text>
        <text
          x="294"
          y="264"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          abstain · keep gpt-5.6
        </text>
      </svg>
    </div>
  );
}

// Card three — the review that ends the argument: the agent's finding quoted inside a review
// panel, evidence named, and the only two buttons that matter. The panel runs off the card's
// right edge, so the ink button sits against the clip like the reference.
function ReviewMockup() {
  return (
    <div className="relative -mr-5 mb-5 ml-4 mt-3 sm:-mr-6 sm:ml-5">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white p-4 pr-9 sm:pr-10 ${MOCKUP_SHADOW}`}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="font-sans text-[15px] font-medium text-midnight-ink">
            Review the evidence
          </p>
          <span className="font-mono text-caption text-fog">illustrative</span>
        </div>

        <div className="mt-3 rounded-lg border border-ash-border bg-warm-sand p-3.5">
          <div className="flex items-center gap-2.5">
            <AvatarSeat size={6} />
            <span className="font-sans text-[13px] font-medium text-midnight-ink">
              rightmodeler-agent
            </span>
          </div>
          <p className="mt-2 font-mono text-[12px] text-driftwood">
            swap: summarize step to gpt-5.4-mini
          </p>
          <p className="mt-1 font-mono text-[12px] text-fog">
            Q 0.94 · 85% cheaper · 214 traces replayed
          </p>
        </div>

        <p className="mt-3 font-sans text-[13px] text-driftwood">
          Replays, scores, and confidence attached. The merge stays yours.
        </p>

        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="rounded-lg border border-ash-border bg-parchment-white px-3.5 py-1.5 font-sans text-[13px] text-midnight-ink">
            Close
          </span>
          <span className="rounded-lg bg-midnight-ink px-3.5 py-1.5 font-sans text-[13px] font-medium text-parchment-white">
            Merge
          </span>
        </div>
      </div>
    </div>
  );
}

// The argument, one card per claim, each with its mockup tucked into the card edge.
const CLAIMS: {
  title: string;
  body: string;
  Mockup: React.ComponentType;
}[] = [
  {
    title: "The default is over-provisioned.",
    body: "The biggest model on every step feels safe. Then the bill compounds, call by call, and nobody can say which step earned it.",
    Mockup: UsageMockup,
  },
  {
    title: "Evidence beats vibes.",
    body: "Leaderboards are not your workload. Every candidate is replayed on your own traces and judged against what you shipped.",
    Mockup: FlowMockup,
  },
  {
    title: "A category, not a feature.",
    body: "Evidence-backed model downgrading: detect, prove, fix. A report you run today, pull requests next, continuous with Crucible.",
    Mockup: ReviewMockup,
  },
];

// The quiet second band: three commitments under the claims, each marked by a bespoke glyph.
const PILLARS: {
  Icon: typeof QualityFloorIcon;
  title: string;
  body: string;
}[] = [
  {
    Icon: QualityFloorIcon,
    title: "It can say no.",
    body: "Weak evidence means abstain.",
  },
  {
    Icon: ReplayLoopIcon,
    title: "Your traces are the benchmark.",
    body: "Judged against what you shipped, never a leaderboard.",
  },
  {
    Icon: PullRequestIcon,
    title: "Nothing swaps on its own.",
    body: "Risks flagged, evidence attached, merge yours.",
  },
];

export default function ManifestoPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Manifesto", "/manifesto")} />

      <PageHero
        eyebrow="Manifesto"
        title="Prove it. Don't guess."
        lede="A model downgrade is a real decision. It deserves evidence, not a vibe."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        {/* ── The claims: three cards, each holding a layered still of the product's world. ── */}
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <div className="grid gap-4 sm:gap-5 md:grid-cols-3">
            {CLAIMS.map((claim, i) => (
              <Reveal key={claim.title} delay={i * 0.06} className="h-full">
                <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand">
                  <div className="p-5 sm:p-6">
                    <h2 className="font-sans text-heading-sm text-midnight-ink">
                      {claim.title}
                    </h2>
                    <p className="mt-2 text-body text-driftwood">
                      {claim.body}
                    </p>
                  </div>
                  <div className="mt-auto">
                    <claim.Mockup />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        {/* ── The commitments: an icon-marked column band, hairlined and dotted at the joins. ── */}
        <div className="relative border-t border-ash-border">
          <span
            aria-hidden
            className="absolute left-1/3 top-0 z-10 hidden size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-driftwood md:block"
          />
          <span
            aria-hidden
            className="absolute left-2/3 top-0 z-10 hidden size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-driftwood md:block"
          />
          <div className="grid divide-y divide-ash-border md:grid-cols-3 md:divide-x md:divide-y-0">
            {PILLARS.map((pillar, i) => (
              <div key={pillar.title} className="p-6 sm:p-8">
                <Reveal delay={i * 0.06}>
                  <span className="flex size-11 items-center justify-center rounded-xl border border-ash-border bg-parchment-white text-driftwood">
                    <pillar.Icon size={20} />
                  </span>
                  <h2 className="mt-8 font-sans text-heading-sm text-midnight-ink sm:mt-10">
                    {pillar.title}
                  </h2>
                  <p className="mt-2 max-w-sm text-body text-driftwood">
                    {pillar.body}
                  </p>
                </Reveal>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
          <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
            <GithubButton />
            <Link
              href="/how-it-works"
              className="text-body text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
            >
              See how it works
            </Link>
          </div>
          <div className="mt-10 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
                { href: "/crucible", label: "Crucible (coming soon)" },
                { href: "/glossary", label: "Glossary" },
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
