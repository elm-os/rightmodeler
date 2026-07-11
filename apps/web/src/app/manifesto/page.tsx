import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
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

// ── Right-cell artifacts. The two code cards bookend the argument (every step at frontier price,
// then the same file after the audit); the middle row is a hand-drawn SVG where the manifesto line
// clears past the faded reasons teams actually switch. Monochrome throughout, all decorative.

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

function BeforeArtifact() {
  return (
    <CodeCard>
      <Ln>
        <C>{"// models.ts · before the audit"}</C>
      </Ln>
      <Ln />
      <Ln>
        {"route:      "}
        <V>{'"gpt-5.6"'}</V>
        {","}
      </Ln>
      <Ln>
        {"extract:    "}
        <V>{'"gpt-5.6"'}</V>
        {","}
      </Ln>
      <Ln>
        {"summarize:  "}
        <V>{'"gpt-5.6"'}</V>
        {","}
      </Ln>
      <Ln />
      <Ln>
        <C>{"// every step at frontier price"}</C>
      </Ln>
    </CodeCard>
  );
}

function AfterArtifact() {
  return (
    <CodeCard>
      <Ln>
        <C>{"// models.ts · after the audit"}</C>
      </Ln>
      <Ln />
      <Ln>
        {"route:      "}
        <V>{'"gpt-5.4-nano"'}</V>
        {",  "}
        <C>{"// 96% cheaper"}</C>
      </Ln>
      <Ln>
        {"extract:    "}
        <V>{'"gpt-5.4-mini"'}</V>
        {",  "}
        <C>{"// Q 1.00"}</C>
      </Ln>
      <Ln>
        {"summarize:  "}
        <V>{'"gpt-5.4-mini"'}</V>
        {",  "}
        <C>{"// Q 0.94"}</C>
      </Ln>
      <Ln />
      <Ln>
        <C>{"// frontier only where it earns it"}</C>
      </Ln>
    </CodeCard>
  );
}

// The manifesto line, drawn: the reasons teams actually switch fade into the background while the
// only proof that counts clears past them.
function VibesArtifact() {
  return (
    <svg
      viewBox="0 0 700 460"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      <defs>
        <filter
          id="vibes-pill-shadow"
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
            top of a leaderboard
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
            loud on the timeline
          </text>

          <rect
            x="-300"
            y="86"
            width="770"
            height="70"
            rx="35"
            className="fill-parchment-white"
            filter="url(#vibes-pill-shadow)"
          />
          <text
            x="446"
            y="129"
            textAnchor="end"
            className="fill-midnight-ink font-sans"
            fontSize="17"
            fontWeight="500"
          >
            proven on your own traces
          </text>
        </g>
      </g>
    </svg>
  );
}

// The argument, row by row: each principle on the left, the artifact that shows it on the right.
const ROWS: {
  title: string;
  intro: string;
  body: string;
  artifact: "before" | "vibes" | "after";
}[] = [
  {
    title: "The default is over-provisioned.",
    intro: "The biggest model on every step feels safe.",
    body: "Then the bill compounds, call by call, and a quiet regression ships where nobody is watching. The cost is real; the slip is invisible.",
    artifact: "before",
  },
  {
    title: "Evidence beats vibes.",
    intro: "Leaderboards are not your workload.",
    body: "You should not downgrade because a chart liked a model, or stay expensive because switching feels risky. The only proof that counts is your own traces, judged against the output you already shipped.",
    artifact: "vibes",
  },
  {
    title: "A category, not a feature.",
    intro: "Evidence-backed model downgrading.",
    body: "Detect the inefficient call, prove the safe swap on your data, apply the fix in your repo. The skill does it today as a report you run. The agent will ship it as a pull request. Crucible will do it continuously.",
    artifact: "after",
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

      {/* The argument as catalog rows: full-bleed between the frame's side rules, split by a
          center hairline with a junction dot where the rules cross. */}
      <section className="bg-parchment-white">
        <div className="divide-y divide-ash-border">
          {ROWS.map((row, i) => {
            // The middle row swaps sides (art left, words right): the zig-zag that tells the
            // manifesto apart from the glossary catalog at a glance. DOM order stays words-first
            // for mobile; order utilities flip it at lg, and the center hairline follows the
            // visually-right cell.
            const flip = row.artifact === "vibes";
            return (
              <div key={row.title} className="relative grid lg:grid-cols-2">
                {i > 0 && (
                  <span
                    aria-hidden
                    className="absolute left-1/2 top-0 z-10 hidden size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-driftwood lg:block"
                  />
                )}

                <div
                  className={`p-6 sm:p-10 lg:p-12 ${
                    flip
                      ? "lg:order-2 lg:border-l lg:border-ash-border"
                      : "lg:order-1"
                  }`}
                >
                  <Reveal>
                    <h2 className="font-display text-heading text-midnight-ink">
                      {row.title}
                    </h2>
                    <p className="mt-3 max-w-md text-subheading text-driftwood">
                      {row.intro}
                    </p>
                    <p className="mt-6 max-w-md text-body text-driftwood">
                      {row.body}
                    </p>
                  </Reveal>
                </div>

                {row.artifact === "vibes" ? (
                  <div className="relative min-h-72 overflow-hidden border-t border-ash-border lg:order-1 lg:min-h-0 lg:border-t-0">
                    <VibesArtifact />
                  </div>
                ) : (
                  <div className="border-t border-ash-border p-6 sm:p-10 lg:order-2 lg:border-l lg:border-t-0 lg:p-12">
                    <Reveal delay={0.06} className="h-full w-full">
                      {row.artifact === "before" ? (
                        <BeforeArtifact />
                      ) : (
                        <AfterArtifact />
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
