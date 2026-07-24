import type { Metadata } from "next";
import Link from "next/link";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "How it works",
  description:
    "How rightmodeler works: it detects inefficient model calls, proves on your own traces which downgrades are safe against what you already shipped, and applies the fix in your repo. Detect, prove, fix.",
  path: "/how-it-works",
  image: "/social/how-it-works.png",
});

// The three-step spine, Detect → Prove → Fix. `line` is the machine-vernacular substance slab under
// each card (mono, ink-on-recessed-slab), echoing sections/how-it-works.tsx on the home page.
const STEPS: {
  n: string;
  name: string;
  body: string;
  label: string;
  line: string;
}[] = [
  {
    n: "01",
    name: "Detect",
    body: "Point it at the traces you already emit. rightmodeler autodetects the format across nine sources and folds every run into one per-step schema, with no new SDK and no re-instrumentation.",
    label: "reads",
    line: "Claude Code · Codex · LangSmith / LangGraph · OpenAI SDK · Langfuse · Braintrust · Phoenix · OTel GenAI · LiteLLM  →  1 per-step schema",
  },
  {
    n: "02",
    name: "Prove",
    body: "It replays each step through cheaper candidates on your real inputs and judges every output against what you already shipped. Each swap gets a save %, a quality score, the evidence behind it, and a risk flag, and it abstains when the evidence is weak.",
    label: "scores",
    line: "save % · quality · evidence · risk flag  →  verdict + confidence · abstain on high-risk",
  },
  {
    n: "03",
    name: "Fix",
    body: "You approve each safe swap and rightmodeler applies it in your repo via the Skill. A report and an edit, never a live intercept. You decide what to swap, and when.",
    label: "applies",
    line: "approved swap in your repo, via the Skill · nothing changes without your approval",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "Which traces are supported?",
    a: "Nine formats, autodetected: Claude Code, Codex, LangSmith / LangGraph, the OpenAI SDK, Langfuse, Braintrust, Phoenix, OpenTelemetry GenAI, and LiteLLM StandardLoggingPayload. rightmodeler folds them all into one per-step schema, so you point it at the traces you already emit, with no new instrumentation.",
  },
  {
    q: "Does it touch production?",
    a: "No. rightmodeler replays your past traces offline and produces a report plus a repo edit. It never sits in your request path, routes live traffic, or adds latency. It is not a runtime gateway.",
  },
  {
    q: "Do you store my data?",
    a: "It runs locally on your own traces and your own replay provider key. Replays call your selected provider, OpenRouter, the Vercel AI Gateway, or a LiteLLM proxy, using your key; there is no rightmodeler server holding your traces.",
  },
];

export default function HowItWorksPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("How rightmodeler works", "/how-it-works")} />

      <PageHero
        eyebrow="How it works"
        title="How rightmodeler works"
        lede="Detect, prove, fix. The whole loop, run on the traces you already have."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal>
            <Tldr>
              rightmodeler replays your real agent traces through cheaper
              models, judges each output against{" "}
              <span className="text-midnight-ink">
                what you already shipped
              </span>
              , and applies the safe swaps in your repo.
            </Tldr>
          </Reveal>

          {/* The pipeline: one continuous hairline spine with numbered nodes.
              No card fills; warm-sand barely separates from the canvas, so depth
              comes from the spine, the display-face step titles, and a
              hairline-topped machine-output line per step. Numbering is earned:
              this is a real Detect -> Prove -> Fix sequence. */}
          <div className="relative mt-14">
            <div
              aria-hidden
              className="absolute top-2 bottom-2 left-4 w-px bg-ash-border sm:left-5"
            />

            <div className="grid grid-cols-[2rem_1fr] items-center gap-x-5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-7">
              <span className="flex justify-center">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-ash-border"
                />
              </span>
              <p className="font-mono text-caption text-fog">in ▸ raw traces</p>
            </div>

            <ol className="mt-8 space-y-12">
              {STEPS.map((step, i) => (
                <Reveal key={step.n} delay={i * 0.06}>
                  <li className="grid grid-cols-[2rem_1fr] gap-x-5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-7">
                    <div className="flex justify-center">
                      <span className="relative z-10 mt-1 flex size-8 items-center justify-center rounded-full border border-ash-border bg-parchment-white font-mono text-caption text-driftwood sm:size-9 sm:text-body">
                        {step.n}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <h2 className="font-display text-heading text-midnight-ink">
                        {step.name}
                      </h2>
                      <p className="mt-3 max-w-prose text-body text-driftwood">
                        {step.body}
                      </p>
                      <p className="mt-4 border-t border-ash-border pt-3 font-mono text-[13px] text-driftwood">
                        <span className="text-fog">{step.label} </span>
                        {step.line}
                      </p>
                    </div>
                  </li>
                </Reveal>
              ))}
            </ol>

            <div className="mt-10 grid grid-cols-[2rem_1fr] items-center gap-x-5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-7">
              <span className="flex justify-center">
                <span aria-hidden className="h-px w-3 bg-ash-border" />
              </span>
              <p className="font-mono text-caption text-fog">
                out ▸ signed report
              </p>
            </div>
          </div>

          <Reveal delay={0.1} className="mt-12 border-t border-ash-border pt-8">
            <p className="font-display text-heading-sm text-midnight-ink">
              Not observability. Not a runtime gateway.
            </p>
            <p className="mt-2 max-w-xl text-body text-driftwood">
              Observability only shows you problems; a gateway hijacks live
              traffic. rightmodeler proves the fix on runs you already shipped,
              then applies it in your repo.
            </p>
          </Reveal>

          <Reveal
            delay={0.14}
            className="mt-10 flex flex-col items-start gap-5 sm:flex-row sm:items-center"
          >
            <GithubButton />
            <Link
              href="/crucible"
              className="text-body text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
            >
              Crucible (coming soon)
            </Link>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/manifesto", label: "Read the manifesto" },
                { href: "/glossary", label: "Browse the glossary" },
                {
                  href: "/use-cases/reduce-llm-costs",
                  label: "Cut your model bill",
                },
                { href: "/integrations", label: "Integrations" },
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
