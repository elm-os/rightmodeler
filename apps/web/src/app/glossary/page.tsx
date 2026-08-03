import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { ILLUSTRATIVE_SCORECARD } from "@/lib/product-facts";
import { SITE_URL } from "@/lib/site";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Glossary",
  description:
    "Plain definitions for model downgrading, quality floors, cascade risk, abstention, reference evidence, LLM-as-judge, and other rightmodeler terms.",
  path: "/glossary",
  image: "/social/glossary.png",
});

// Each term is anchor-linkable (#slug) so it can be cited directly. The visible catalog and the
// DefinedTermSet JSON-LD below share the same full definition, so neither representation can drift.
const TERMS: { term: string; slug: string; def: string }[] = [
  {
    term: "Evidence-backed model downgrading",
    slug: "evidence-backed-model-downgrading",
    def: "Reviewing a step for a cheaper model after measuring candidate output against the output you accepted for the same input. The decision rests on reference agreement, evidence, and sample size, not a benchmark or a hunch.",
  },
  {
    term: "Model downgrade audit",
    slug: "model-downgrade-audit",
    def: "A pass over your traces that measures each cheaper candidate against the accepted output for the same input, reports the evidence and sample size, and records where it abstains.",
  },
  {
    term: "Swap candidate",
    slug: "swap-candidate",
    def: "A cheaper model whose output agrees closely enough with the accepted reference to merit review. This is evidence of agreement with shipped output, not proof of correctness.",
  },
  {
    term: "Quality floor",
    slug: "quality-floor",
    def: `The minimum reference-agreement score a candidate must clear to be recommended; below it, the current model stays. rightmodeler's default is ${ILLUSTRATIVE_SCORECARD.floor}, and it's configurable.`,
  },
  {
    term: "Cascade risk",
    slug: "cascade-risk",
    def: "The chance that downgrading one step degrades later steps that depend on it, common in tool and loop steps. It's flagged so a local win doesn't cause a downstream regression.",
  },
  {
    term: "Abstain",
    slug: "abstain",
    def: "The audit's decision to make no recommendation when the evidence or sample is too weak to support one. A tool that always finds savings isn't measuring anything.",
  },
  {
    term: "Reference evidence",
    slug: "reference-evidence",
    def: "Grading a cheaper model's output against the output you already accepted for the same input, rather than against a gold answer. The production result is the reference, not ground truth.",
  },
  {
    term: "LLM-as-judge",
    slug: "llm-as-judge",
    def: "Using a separate model, from a different family than either compared model, to score agreement between two outputs, so nothing grades its own work.",
  },
  {
    term: "Trace",
    slug: "trace",
    def: "The recorded steps of an agent run: the models called, their inputs, and their outputs. rightmodeler ingests traces you already emit and folds them into one per-step schema.",
  },
];

const byIdSlug = (slug: string) => TERMS.find((t) => t.slug === slug)!;

// The catalog rows: three themes, three terms each. Grouping is presentation only; the LD stays
// flat so every term keeps its own DefinedTerm entry and anchor.
const THEMES: { title: string; intro: string; slugs: string[] }[] = [
  {
    title: "The decision",
    intro: "The words for reviewing a candidate swap.",
    slugs: [
      "evidence-backed-model-downgrading",
      "model-downgrade-audit",
      "swap-candidate",
    ],
  },
  {
    title: "The guardrails",
    intro: "Where the audit stops.",
    slugs: ["quality-floor", "cascade-risk", "abstain"],
  },
  {
    title: "The evidence",
    intro: "What gets measured, and by whom.",
    slugs: ["trace", "reference-evidence", "llm-as-judge"],
  },
];

const definedTermSetLd = {
  "@context": "https://schema.org",
  "@type": "DefinedTermSet",
  name: "The model-downgrade glossary",
  url: `${SITE_URL}/glossary`,
  hasDefinedTerm: TERMS.map((t) => ({
    "@type": "DefinedTerm",
    name: t.term,
    description: t.def,
    url: `${SITE_URL}/glossary#${t.slug}`,
    inDefinedTermSet: `${SITE_URL}/glossary`,
  })),
};

// ── Right-cell artifacts, standing where the reference shows code panels. Rows one and three are
// code snippets in monochrome "syntax" (comments in fog, structure in driftwood, the values that
// matter in ink; no hue, per the design system). Row two is a hand-drawn SVG: candidate models
// crossing the cell diagonally, with only the front one clearing the floor. All decorative.

// Fills its cell like the reference's code panels. Every line is kept short enough that the card
// never scrolls sideways; the mono size steps down a notch on the smallest screens so the longest
// line still fits.
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

// The decision, as it lands in a repo: the frontier model commented out, the recommended swap in its
// place, the receipts in the trailing comments.
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

// The reference's tilted-pills illustration, redrawn by hand: candidate models climb the cell on
// a diagonal, faint gray where they fell below the floor and sliding off-canvas, one crisp white
// pill with a soft shadow where a candidate cleared it. Labels read along the pills, staggered.
function FloorArtifact() {
  return (
    <svg
      viewBox="0 0 700 460"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      <text x="24" y="28" className="fill-fog font-mono" fontSize="14">
        {ILLUSTRATIVE_SCORECARD.label} scores
      </text>
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
        {/* faint construction diagonals, one crossing the flow */}
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

          {/* below the floor, fading back and running off-canvas */}
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

          {/* the one that cleared it: white pill, rounded cap, soft shadow, ink label */}
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

// The evidence, as configuration: what gets measured, against what, and by whom.
function EvidenceArtifact() {
  return (
    <CodeCard>
      <Ln>
        <C>{"// rightmodeler.config.ts"}</C>
      </Ln>
      <Ln />
      <Ln>{"export default audit({"}</Ln>
      <Ln>
        {"  traces: "}
        <V>{'"./traces/*.jsonl"'}</V>
        {",  "}
        <C>{"// 214 runs"}</C>
      </Ln>
      <Ln>
        {"  reference: "}
        <V>{'"shipped"'}</V>
        {",  "}
        <C>{"// as shipped"}</C>
      </Ln>
      <Ln>
        {"  judge: "}
        <V>{'"cross-family"'}</V>
        {",  "}
        <C>{"// no self-grade"}</C>
      </Ln>
      <Ln>
        {"  abstain: "}
        <V>{'"weak-evidence"'}</V>
        {",  "}
        <C>{"// say no"}</C>
      </Ln>
      <Ln>{"});"}</Ln>
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
        title="The model-downgrade glossary"
        lede="Plain definitions for the words rightmodeler uses."
        gradient={false}
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {/* The catalog — full-bleed rows between the frame's side rules: terms on the left, the
          artifact that shows them on the right, split by a center hairline with a junction dot
          where the rules cross. */}
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
                    <dl className="mt-10 space-y-8 sm:mt-14">
                      {terms.map((t) => (
                        <div key={t.slug} id={t.slug} className="scroll-mt-24">
                          <dt className="font-sans text-body font-medium text-midnight-ink">
                            {t.term}
                          </dt>
                          <dd className="mt-1 text-body text-driftwood">
                            {t.def}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Reveal>
                </div>

                {theme.title === "The guardrails" ? (
                  <div className="relative min-h-72 overflow-hidden border-t border-ash-border lg:min-h-0 lg:border-t-0">
                    <FloorArtifact />
                  </div>
                ) : (
                  <div className="border-t border-ash-border p-6 sm:p-10 lg:border-t-0 lg:p-12">
                    <Reveal delay={0.06} className="h-full w-full">
                      {theme.title === "The decision" ? (
                        <DecisionArtifact />
                      ) : (
                        <EvidenceArtifact />
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
