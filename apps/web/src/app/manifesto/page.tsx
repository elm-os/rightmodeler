import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { LogoMark } from "@/components/icons";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Software should maintain itself.",
  description:
    "We think the human work in the loop is the bottleneck. The case against blind swaps, runtime routers, general benchmarks and frontier bills, and for validation.",
  path: "/manifesto",
  image: "/social/manifesto.png",
});

// The canonical definition from docs/positioning.md: the section and the FAQ reuse it verbatim.
const SAFE =
  "A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.";

const FAQ: FaqItem[] = [
  {
    q: "What do you mean by the human in the loop?",
    a: "The hand work of keeping a production AI system on the right models: noticing a release, building a replay harness, grading outputs, writing it up, migrating, and doing it again every few weeks. For swaps to cheaper or newer models, rightmodeler does that work, up to a draft pull request with the evidence attached. A person still sets the policy and gives the final yes.",
  },
  {
    q: "What makes a model swap safe?",
    a: SAFE,
  },
  {
    q: "Why not use a router?",
    a: "In our view, a runtime router makes a fresh choice per request with a policy that was not validated on your workload, adds a hop and a dependency to the request path, and can send the same input to different models, which makes behavior harder to reproduce, audit, and roll back. rightmodeler validates a swap per step, offline, on your own traces, and proposes it as a draft pull request; a person decides whether it merges. The result is one pinned model per step. A gateway that serves the model you pin is a different thing, and rightmodeler replays through gateways.",
  },
  {
    q: "Does rightmodeler touch production?",
    a: "No. It is built for production AI systems and validates on production traces, the calls your app already recorded, but it runs offline beside your app, on your machine or in CI, never in your request path. Swaps that feed later model steps are confirmed by running your app in a sandbox, apart from production. That sandbox has ordinary network access, so point your app's tools at test fixtures, not production services.",
  },
  {
    q: "Will it swap models on its own?",
    a: "No. rightmodeler never merges, deploys, or swaps anything on its own, and the agent carries no merge capability. It abstains when the evidence is thin, flags cascade risk, and, when a swap clears every gate, opens a draft pull request that changes only model identifiers. A person reviews it and decides whether it merges; after a merge, one command opens the pull request that restores the exact pre-swap files.",
  },
  {
    q: "Where is this going?",
    a: "Toward autonomous self-maintenance and optimization for production AI systems, earned with evidence. Today that means validated swaps to cheaper or newer models from the CLI and scheduled maintenance from the self-hosted agent. Crucible adds open-source, self-hosted observability for AI agents and MCP servers, and rightmodeler replays its traces.",
  },
];

// Every figure is stamped illustrative on its artifact. Soft shadows are illustration-only.

const MOCKUP_SHADOW = "shadow-[0_12px_32px_rgba(41,36,31,0.08)]";

function AvatarSeat() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-ash-border bg-warm-sand text-midnight-ink">
      <LogoMark height={9} />
    </span>
  );
}

function UsageMockup() {
  const rows: { step: string; cost: string }[] = [
    { step: "classify", cost: "$1,180" },
    { step: "extract", cost: "$940" },
    { step: "summarize", cost: "$2,310" },
    { step: "judge", cost: "$860" },
    { step: "rerank", cost: "$1,040" },
    { step: "answer", cost: "$620" },
  ];
  return (
    <div className="relative mx-4 -mb-14 mt-4 sm:mx-5 md:mt-6">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white ${MOCKUP_SHADOW}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-ash-border px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2.5">
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
            $6,950 and climbing
          </span>
        </div>
      </div>
    </div>
  );
}

// One SVG so nodes, capsules, and connectors stay registered at every width.
function FlowMockup() {
  return (
    <div className="relative mx-2 mb-4 mt-2 sm:mx-3 md:mt-6">
      <svg
        viewBox="24 0 432 292"
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

        <rect
          x="176"
          y="4"
          width="128"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <path
          d="M195 18 v16 M195 19 h9 l-2.5 3.5 2.5 3.5 h-9"
          className="stroke-driftwood"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text
          x="212"
          y="30"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          your traces
        </text>

        <rect
          x="86"
          y="78"
          width="308"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <path
          d="M106 94 h10 a4.5 4.5 0 0 1 0 9 h-7 m2.4 -2.4 -2.4 2.4 2.4 2.4"
          className="stroke-driftwood"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text
          x="126"
          y="104"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          replay cheaper or newer candidates
        </text>

        <rect
          x="55"
          y="186"
          width="146"
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
          clears every gate
        </text>

        <rect
          x="279"
          y="186"
          width="146"
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
          evidence too thin
        </text>

        <rect
          x="30"
          y="238"
          width="196"
          height="42"
          rx="21"
          className="fill-parchment-white stroke-ash-border"
          filter="url(#mf-node-shadow)"
        />
        <text
          x="52"
          y="264"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          ✓
        </text>
        <text
          x="70"
          y="264"
          className="fill-midnight-ink font-sans"
          fontSize="14"
          fontWeight="500"
        >
          draft PR: gpt-5.4-mini
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

function ReviewMockup() {
  return (
    <div className="relative -mr-5 mb-5 ml-4 mt-3 sm:-mr-6 sm:ml-5 md:mt-6">
      <div
        className={`rounded-xl border border-ash-border bg-parchment-white p-4 pr-9 sm:pr-10 ${MOCKUP_SHADOW}`}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="font-sans text-[15px] font-medium text-midnight-ink">
            Review the evidence
          </p>
          <span className="font-mono text-caption text-fog">
            {ILLUSTRATIVE_SCORECARD.label}
          </span>
        </div>

        <div className="mt-3 rounded-lg border border-ash-border bg-warm-sand p-3.5">
          <div className="flex items-center gap-2.5">
            <AvatarSeat />
            <span className="font-sans text-[13px] font-medium text-midnight-ink">
              rightmodeler-agent
            </span>
          </div>
          <p className="mt-2 font-mono text-[12px] text-driftwood">
            swap: summarize step to gpt-5.4-mini
          </p>
          <p className="mt-1 font-mono text-[12px] text-fog">
            Q {ILLUSTRATIVE_SCORECARD.approved} · 85% cheaper · 214 traces
            replayed
          </p>
        </div>

        <p className="mt-3 font-sans text-[13px] text-driftwood">
          Gates, sample sizes, and cost-per-case receipts attached. Whether it
          merges is your call.
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

const THESIS = {
  title: "The bottleneck is the work, not the judgment.",
  body: "Given replays, scores, and cost deltas, an engineer makes the right call in minutes. What takes days is everything before the call: noticing the release, pulling real traces, building a replay harness, grading the outputs, writing it up so it survives review, migrating, and doing it all again when the next model ships. That standing job is the part software should do. rightmodeler takes the work out of the loop, not the judgment.",
};

// Rows pair a narrow card with a wide one at lg; a section with a figure splits its wide card.
const SECTIONS: {
  title: string;
  body: string;
  Mockup?: React.ComponentType;
}[] = [
  {
    title: "Blind swaps fail quietly.",
    body: "A cheaper model drops into a step in thirty seconds. Knowing whether it got worse does not. Cheaper models fail without throwing errors: the extraction still returns valid JSON and is wrong on the edge cases, and the summary still reads well and drops the one detail the next step needed. You find out from a user.",
  },
  {
    title: "Routers don't work in production.",
    body: "This is our opinion, and these are the reasons. By routers we mean runtime model selectors that pick a model per request, not gateways that forward the model you pinned. A router decides with a policy that was not validated on your workload. It adds a hop and a dependency to the request path. The same input can take different models, so behavior is harder to reproduce, audit, and roll back. Production wants one pinned model per step, validated on your traces and changed through code review. rightmodeler replays through gateways, offline, and never sits in the request path.",
  },
  {
    title: "General benchmarks aren't your workload.",
    body: "A leaderboard ranks models on someone else's tasks. It cannot tell you whether a cheaper model matches the outputs you already accepted, on your prompts and context. Your traces are the benchmark.",
  },
  {
    title: "Frontier everywhere costs too much.",
    body: "The most expensive model on every step feels safe. Then the bill compounds, call by call, and nobody can say which step earned it. The expensive model should earn its price on the hard steps, and only your traces can show which steps those are.",
    Mockup: UsageMockup,
  },
  {
    title: "Safe means it cleared every gate.",
    body: SAFE,
  },
  {
    title: "It can say no.",
    body: "Thin evidence means abstain. A tool that finds a swap every time is not measuring anything.",
    Mockup: FlowMockup,
  },
  {
    title: "Autonomy is earned with evidence.",
    body: "We are not asking anyone to trust a system that changes models on its own. We are building the evidence that would justify one, a validated change at a time, inside the policy you set. Today rightmodeler does the work, and when a swap clears every gate it opens a draft pull request that changes only model identifiers, with the evidence attached.",
  },
  {
    title: "Nothing merges on its own.",
    body: "A person sets the policy (the quality floor, which models are allowed, an optional spend cap), gives the agent the word before it replays a new candidate, and decides whether each draft pull request merges. To roll back a merged swap, one command opens the pull request that restores the exact pre-swap files. Today, the final yes stays yours.",
    Mockup: ReviewMockup,
  },
];

export default function ManifestoPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Manifesto", "/manifesto")} />

      <PageHero
        eyebrow="Manifesto"
        title="Software should maintain itself."
        lede="We think the biggest bottleneck in maintaining software is the human in the loop: not the judgment, the work. We start with production AI systems, where a new model ships every few weeks and each one restarts the same manual job."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal>
            <h2 className="font-display text-heading text-balance text-midnight-ink">
              {THESIS.title}
            </h2>
            <p className="mt-4 text-subheading text-driftwood">{THESIS.body}</p>
          </Reveal>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <div className="grid gap-4 sm:gap-5 lg:grid-cols-3">
            {SECTIONS.map(({ title, body, Mockup }, i) => {
              const wide = i % 2 === 1;
              return (
                <Reveal
                  key={title}
                  delay={wide ? 0.06 : 0}
                  className={wide ? "h-full lg:col-span-2" : "h-full"}
                >
                  <div
                    className={`grid h-full overflow-hidden rounded-2xl border border-ash-border bg-warm-sand ${Mockup ? "md:grid-cols-2" : ""}`}
                  >
                    <div className="p-5 sm:p-6">
                      <h2 className="font-sans text-heading-sm text-midnight-ink">
                        {title}
                      </h2>
                      <p className="mt-2 text-body text-driftwood">{body}</p>
                    </div>
                    {Mockup && (
                      <div className="flex flex-col justify-end">
                        <Mockup />
                      </div>
                    )}
                  </div>
                </Reveal>
              );
            })}
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
                { href: "/agent", label: "rightmodeler agent" },
                {
                  href: "/crucible",
                  label: "Crucible, open-source observability",
                },
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
