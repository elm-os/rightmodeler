import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import {
  DEFAULT_QUALITY_FLOOR,
  ILLUSTRATIVE_SCORECARD,
} from "@/lib/product-facts";
import { SITE_URL } from "@/lib/site";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Glossary",
  description:
    "Plain definitions for validating a swap to a cheaper model: release gates, the quality floor, held-out cases, abstention, cascade risk, and what safe means.",
  path: "/glossary",
  image: "/social/glossary.png",
});

// The canonical definition from docs/positioning.md: reuse it verbatim wherever safe is defined.
const SAFE =
  "A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.";

type Term = { term: string; slug: string; def: string };

// Each term is anchor-linkable (#slug) so it can be cited directly. /vs pages and blog posts link
// these slugs, so never rename or remove one: recast the term and its definition instead.
const TERMS: Term[] = [
  {
    term: "Safe model swap",
    slug: "safe-model-swap",
    def: `rightmodeler validates only swaps to cheaper models. ${SAFE}`,
  },
  {
    term: "Swap candidate",
    slug: "swap-candidate",
    def: "A cheaper model shortlisted for one step, from your provider's live catalog or named with --candidate, and replayed on that step's recorded inputs. It must cost less than the recorded model, even when you name it. Clearing every gate is evidence of agreement with what you shipped, not ground-truth correctness.",
  },
  {
    term: "Model downgrade",
    slug: "model-downgrade",
    def: "Another name for a swap to a cheaper model. rightmodeler says swap, because downgrade presumes the quality loss that the release gates test for.",
  },
  {
    term: "Release gate",
    slug: "release-gate",
    def: "A check every swap must pass before it becomes a draft pull request: agreement, at a statistical lower bound, that reaches your quality floor on held-out cases, enough answered calls, and end-to-end confirmation for a step that feeds later model steps.",
  },
  {
    term: "Quality floor",
    slug: "quality-floor",
    def: `The agreement a candidate must reach on held-out cases, at a statistical lower bound, to be recommended; below it, the current model stays. The default is ${DEFAULT_QUALITY_FLOOR}, and a policy file can set it above 0.8 and below 1.`,
  },
  {
    term: "Statistical lower bound",
    slug: "statistical-lower-bound",
    def: "The low end of a 95% interval around a measured agreement rate. rightmodeler compares the bound, not the raw rate, with your floor, so a small sample has to do better to clear it. There are no confidence tiers.",
  },
  {
    term: "Held-out cases",
    slug: "held-out-cases",
    def: "Recorded cases kept out of the shortlist screen. rightmodeler splits your cases into a shortlist half, which only screens candidates on their pass rate, and a held-out half. Only the cheapest candidate that passes the screen is replayed on the held-out half, where its lower bound has to reach your quality floor, adjusted for how many candidates competed.",
  },
  {
    term: "Cascade risk",
    slug: "cascade-risk",
    def: "The chance that swapping one step to a cheaper model degrades later steps that depend on it, common in tool and loop steps. When a step feeds later model steps, its swap counts only once it is confirmed end to end, judged on your app's final output rather than on the step alone.",
  },
  {
    term: "End-to-end confirmation",
    slug: "end-to-end-confirmation",
    def: "Running your own app on recorded cases in a sandbox, apart from production, with the cheaper candidate in place on the swapped steps, then judging the app's final output against the recorded one. A swap whose step feeds later model steps needs it: without it, the swap is reported as unconfirmed and no pull request opens. If the run traces a failure to the swap, the swap is rejected; if it cannot tell, rightmodeler abstains. The CLI docs and the --modeb-config flag call this Mode B, and it needs step headers in your app. The sandbox keeps your model key out but has ordinary network access, so point your app's tools at test fixtures, not production services.",
  },
  {
    term: "Abstain",
    slug: "abstain",
    def: "rightmodeler's decision to make no recommendation when the evidence or sample is too thin to support one, with a named reason, such as too few review trials. The current model stays. A tool that always finds savings isn't measuring anything.",
  },
  {
    term: "Trace",
    slug: "trace",
    def: "The recorded steps of an agent run: the models called, their inputs, and their outputs. rightmodeler ingests traces you already emit and folds them into one per-step schema.",
  },
  {
    term: "Production traces",
    slug: "production-traces",
    def: "The model calls your production app already recorded, through a tracing platform, OpenTelemetry, or gateway logs. rightmodeler validates on them offline and never on live traffic. Claude Code sessions on disk work too; Codex sessions are read, but only a Codex turn that called no tools can enter the replay sample today. Both are traces you already have, not production traces.",
  },
  {
    term: "Reference evidence",
    slug: "reference-evidence",
    def: "Grading a cheaper model's output against the output you already accepted for the same input, rather than against a gold answer. The production result is the reference, not ground truth, so a candidate that repeats a wrong accepted answer still agrees.",
  },
  {
    term: "LLM-as-judge",
    slug: "llm-as-judge",
    def: "Using a separate model, from a different family than either compared model, to score agreement between two outputs, so nothing grades its own work. rightmodeler's judge reads both answer orders and passes a case only when both agree, and your own evaluator can grade instead.",
  },
  {
    term: "Human in the loop",
    slug: "human-in-the-loop",
    def: "In machine learning the phrase often means people labeling data or reviewing outputs. In rightmodeler's usage it is the hand work that comes back each time a model ships: noticing it, pulling real traces, building a replay, grading the outputs, writing it up so it survives review, and migrating. rightmodeler takes the work out of the loop, not the judgment; today, the final yes stays yours.",
  },
  {
    term: "Swap validation",
    slug: "evidence-backed-model-downgrading",
    def: "Testing a swap to a cheaper model on your own traces before anyone merges it. rightmodeler replays the recorded steps on cheaper candidate models, has a judge from a different vendor, or your own evaluator, grade every answer against the output you accepted, and opens a draft pull request only for a swap that clears every release gate.",
  },
  {
    term: "Validation run",
    slug: "model-downgrade-audit",
    def: "One pass of rightmodeler over your traces: it measures each cheaper candidate against the accepted output for the same input, reports the evidence and sample size, and records where it abstains.",
  },
  {
    term: "Runtime router",
    slug: "runtime-router",
    def: "A service in the request path that picks a model for each request at runtime. rightmodeler is not one: it validates one pinned model per step, offline, before a person merges the change. A gateway that serves the model you pin is a different thing, and rightmodeler can replay through one.",
  },
];

const byIdSlug = (slug: string) => TERMS.find((t) => t.slug === slug)!;

// `art` picks the panel beside a theme's terms; a theme without one sets its terms there instead.
const THEMES: {
  title: string;
  intro: string;
  slugs: string[];
  art?: "decision" | "floor" | "evidence";
}[] = [
  {
    title: "The decision",
    intro: "The words for a swap to a cheaper model.",
    slugs: ["safe-model-swap", "swap-candidate", "model-downgrade"],
    art: "decision",
  },
  {
    title: "The gates",
    intro: "What a swap has to clear.",
    slugs: ["release-gate", "quality-floor", "statistical-lower-bound"],
    art: "floor",
  },
  {
    title: "The guardrails",
    intro: "What stops a lucky or local win from becoming a pull request.",
    slugs: [
      "held-out-cases",
      "cascade-risk",
      "end-to-end-confirmation",
      "abstain",
    ],
  },
  {
    title: "The evidence",
    intro: "What gets measured, and by whom.",
    slugs: ["trace", "production-traces", "reference-evidence", "llm-as-judge"],
    art: "evidence",
  },
  {
    title: "The loop",
    intro: "The work in the loop, who does it, and where it runs.",
    slugs: [
      "human-in-the-loop",
      "evidence-backed-model-downgrading",
      "model-downgrade-audit",
      "runtime-router",
    ],
  },
];

const definedTermSetLd = {
  "@context": "https://schema.org",
  "@type": "DefinedTermSet",
  name: "The model-swap glossary",
  url: `${SITE_URL}/glossary`,
  hasDefinedTerm: TERMS.map((t) => ({
    "@type": "DefinedTerm",
    name: t.term,
    description: t.def,
    url: `${SITE_URL}/glossary#${t.slug}`,
    inDefinedTermSet: `${SITE_URL}/glossary`,
  })),
};

function TermList({ terms, className }: { terms: Term[]; className?: string }) {
  return (
    <dl className={`space-y-8 ${className ?? ""}`}>
      {terms.map((t) => (
        <div key={t.slug} id={t.slug} className="scroll-mt-24">
          <dt className="font-sans text-body font-medium text-midnight-ink">
            {t.term}
          </dt>
          <dd className="mt-1 text-body text-driftwood">{t.def}</dd>
        </div>
      ))}
    </dl>
  );
}

// Every line is kept short enough that the card never scrolls sideways.
function CodeCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full w-full rounded-2xl border border-ash-border bg-warm-sand p-6 sm:p-8">
      <div className="space-y-1.5 font-mono text-[12px] sm:text-sm">
        {children}
      </div>
    </div>
  );
}

const Ln = ({ children }: { children?: React.ReactNode }) =>
  children ? (
    <div className="whitespace-pre text-driftwood">{children}</div>
  ) : (
    <div aria-hidden className="h-4" />
  );
const C = ({ children }: { children: React.ReactNode }) => (
  <span className="text-fog">{children}</span>
);
const V = ({ children }: { children: React.ReactNode }) => (
  <span className="text-midnight-ink">{children}</span>
);

function DecisionArtifact() {
  return (
    <CodeCard>
      <Ln>
        <C>{`// steps/summarize.ts · ${ILLUSTRATIVE_SCORECARD.label}`}</C>
      </Ln>
      <Ln />
      <Ln>{"export const summarize = step({"}</Ln>
      <Ln>
        {"  "}
        <C>{'// model: "gpt-5.6",  · replaced'}</C>
      </Ln>
      <Ln>
        {"  model: "}
        <V>{'"gpt-5.4-mini"'}</V>
        {",  "}
        <C>
          {"// "}
          <V>85% cheaper</V>
        </C>
      </Ln>
      <Ln>
        {"  floor: "}
        <V>{ILLUSTRATIVE_SCORECARD.floor}</V>
        {",  "}
        <C>{`// Q ${ILLUSTRATIVE_SCORECARD.approved} clears it`}</C>
      </Ln>
      <Ln>{"});"}</Ln>
    </CodeCard>
  );
}

function FloorArtifact() {
  return (
    <svg
      viewBox="0 0 700 460"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      <defs>
        <filter
          id="floor-pill-shadow"
          x="-20%"
          y="-40%"
          width="140%"
          height="200%"
        >
          <feDropShadow
            dx="0"
            dy="6"
            stdDeviation="10"
            floodColor="#000000"
            floodOpacity="0.09"
          />
        </filter>
      </defs>

      <g transform="translate(70 40)">
        <line
          x1="360"
          y1="-70"
          x2="760"
          y2="330"
          className="stroke-ash-border"
          strokeWidth="1"
        />

        <g transform="rotate(-30 280 190)">
          <line
            x1="-300"
            y1="48"
            x2="900"
            y2="48"
            className="stroke-ash-border"
            strokeWidth="1"
          />

          <g opacity="0.5">
            <rect
              x="-300"
              y="268"
              width="1200"
              height="66"
              rx="18"
              className="fill-none stroke-silver-mist"
              strokeWidth="1.5"
              strokeDasharray="5 7"
            />
          </g>
          <text
            x="250"
            y="309"
            textAnchor="end"
            className="fill-fog font-sans"
            fontSize="16"
            fontWeight="500"
          >
            {`llama-4-nano · ${ILLUSTRATIVE_SCORECARD.lower}`}
          </text>

          <g opacity="0.7">
            <rect
              x="-300"
              y="178"
              width="1200"
              height="66"
              rx="18"
              className="fill-none stroke-silver-mist"
              strokeWidth="1.5"
              strokeDasharray="5 7"
            />
          </g>
          <text
            x="360"
            y="219"
            textAnchor="end"
            className="fill-fog font-sans"
            fontSize="16"
            fontWeight="500"
          >
            {`gpt-5.4-nano · ${ILLUSTRATIVE_SCORECARD.middle}`}
          </text>

          <rect
            x="-300"
            y="86"
            width="770"
            height="70"
            rx="35"
            className="fill-parchment-white"
            filter="url(#floor-pill-shadow)"
          />
          <text
            x="446"
            y="129"
            textAnchor="end"
            className="fill-midnight-ink font-sans"
            fontSize="17"
            fontWeight="500"
          >
            {`gpt-5.4-mini · ${ILLUSTRATIVE_SCORECARD.approved} · clears the floor`}
          </text>
        </g>
      </g>
    </svg>
  );
}

function EvidenceArtifact() {
  return (
    <CodeCard>
      <Ln>
        <C>{`// the evidence · ${ILLUSTRATIVE_SCORECARD.label}`}</C>
      </Ln>
      <Ln />
      <Ln>
        <C>{"traces     "}</C>
        <V>214 recorded runs</V>
      </Ln>
      <Ln>
        <C>{"reference  "}</C>
        <V>the outputs you accepted</V>
      </Ln>
      <Ln>
        <C>{"judge      "}</C>
        <V>a different vendor</V>
      </Ln>
      <Ln>
        {"           "}
        <V>or your own evaluator</V>
      </Ln>
      <Ln>
        <C>{"if thin    "}</C>
        <V>abstain</V>
      </Ln>
    </CodeCard>
  );
}

export default function GlossaryPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Glossary", "/glossary")} />
      <JsonLd data={definedTermSetLd} />

      <PageHero
        eyebrow="Glossary"
        title="The model-swap glossary"
        lede="Plain definitions for the words rightmodeler uses to validate a swap to a cheaper model."
        gradient={false}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="divide-y divide-ash-border">
          {THEMES.map((theme, i) => {
            const terms = theme.slugs.map(byIdSlug);
            return (
              <div
                key={theme.title}
                className="relative grid lg:grid-cols-2 lg:divide-x lg:divide-ash-border"
              >
                {i > 0 && (
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-0 z-10 hidden size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-driftwood lg:block"
                  />
                )}

                <div className="p-6 sm:p-10 lg:p-12">
                  <Reveal>
                    <h2 className="font-display text-heading text-midnight-ink">
                      {theme.title}
                    </h2>
                    <p className="mt-3 max-w-md text-subheading text-driftwood">
                      {theme.intro}
                    </p>
                    {theme.art && (
                      <TermList terms={terms} className="mt-10 sm:mt-14" />
                    )}
                  </Reveal>
                </div>

                {theme.art === "floor" ? (
                  <div className="relative min-h-72 overflow-hidden border-t border-ash-border lg:min-h-0 lg:border-t-0">
                    <FloorArtifact />
                    {/* HTML, not SVG text: the SVG crops with slice, which cut the stamp at most widths. */}
                    <p
                      aria-hidden
                      className="absolute left-6 top-5 font-mono text-caption text-fog"
                    >
                      {ILLUSTRATIVE_SCORECARD.label} scores
                    </p>
                  </div>
                ) : (
                  <div className="border-t border-ash-border p-6 sm:p-10 lg:border-t-0 lg:p-12">
                    <Reveal delay={0.06} className="h-full w-full">
                      {theme.art === "decision" ? (
                        <DecisionArtifact />
                      ) : theme.art === "evidence" ? (
                        <EvidenceArtifact />
                      ) : (
                        <TermList terms={terms} />
                      )}
                    </Reveal>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
          <RelatedLinks
            links={[
              { href: "/how-it-works", label: "How it works" },
              { href: "/manifesto", label: "Read the manifesto" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
