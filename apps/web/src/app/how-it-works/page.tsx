import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { CommandBlock } from "@/components/command-block";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import {
  AgentSparkIcon,
  ArrowRightIcon,
  ScheduleIcon,
  ServerRackIcon,
  TerminalIcon,
} from "@/components/icons";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { TRACE_SOURCES } from "@/lib/product-facts";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { RUN_COMMAND, SKILL_COMMAND } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "How it works",
  description:
    "Run rightmodeler from your terminal, your coding agent, scheduled CI, or a self-hosted agent. It measures cheaper candidates against outputs you accepted and reports the evidence.",
  path: "/how-it-works",
  image: "/social/how-it-works.png",
});

// The three-step spine, Detect → Measure → Review. `line` is the machine-vernacular substance slab under
// each card (mono, ink-on-recessed-slab).
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
    body: `Point it at the traces you already emit. rightmodeler autodetects the format across ${TRACE_SOURCES.length} sources and folds every run into one per-step schema, with no new SDK and no re-instrumentation.`,
    label: "reads",
    line: `${TRACE_SOURCES.join(" · ")}  →  1 per-step schema`,
  },
  {
    n: "02",
    name: "Measure",
    body: "It replays each step through cheaper candidates on your real inputs and measures every output against what you accepted. Each candidate gets a cost delta, reference-agreement score, and evidence count, and it abstains when the evidence is weak.",
    label: "scores",
    line: "cost · agreement · evidence count  →  recommendation + confidence · abstain on thin evidence",
  },
  {
    n: "03",
    name: "Review",
    body: "You review the plan, and the CLI ships only the swaps you approve as a pull request with the evidence attached. It then watches CI on that PR, and if you change your mind, one command opens the pull request that restores the exact pre-swap state. Never a live intercept. You decide what to change, and when.",
    label: "applies",
    line: "approved swaps arrive as a pull request · watch reconciles CI · rollback restores byte-exact",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "What do I need to run it?",
    a: "Node 24 or newer, and the traces your AI tools already write. If you use Claude Code or Codex in your project, init finds their traces automatically. A provider key is only needed when you replay, and `npx rightmodeler estimate --base-url <provider>/v1` projects that spend first with zero paid calls.",
  },
  {
    q: "Which traces are supported?",
    a: `${TRACE_SOURCES.length} formats, autodetected: ${TRACE_SOURCES.slice(0, -1).join(", ")}, and ${TRACE_SOURCES.at(-1)}. rightmodeler folds them all into one per-step schema, so you point it at the traces you already emit, with no new instrumentation.`,
  },
  {
    q: "Does it touch production?",
    a: "No. rightmodeler replays your past traces offline and produces a report plus a repo edit. It never sits in your request path, routes live traffic, or adds latency. It is not a runtime gateway.",
  },
  {
    q: "Do you store my data?",
    a: "It runs locally on your own traces and your own replay provider key. Replays call your selected provider, OpenRouter, the Vercel AI Gateway, or a LiteLLM proxy, using your key; there is no rightmodeler server holding your traces.",
  },
  {
    q: "Can I use my existing eval framework?",
    a: "Yes. Braintrust, Langfuse, LangSmith, and promptfoo can score the replays instead of the built-in judge, and a reachable configured evaluator is always preferred. You can also build the case set from a curated dataset you already maintain, which raises how much the audit can certify, and push trials and verdicts back to your platform when the run completes.",
  },
  {
    q: "Can my coding agent run it?",
    a: "Yes. One install adds a runbook that Claude Code and Codex-class agents follow to drive the whole loop: plan preview, staged runs with resumable boundaries, and an apply dry run before anything ships. The runbook drives the same CLI through npx.",
  },
];

// ── The first-run transcript: the guided CLI session as it actually renders, in the glossary's
// monochrome "syntax" (mundane lines in driftwood, the values that matter in ink, guidance in
// fog). Every line is real 0.2.0 output; the story it tells is the free/paid split.
const Ln = ({ children }: { children?: React.ReactNode }) =>
  children ? (
    <div className="text-driftwood">{children}</div>
  ) : (
    <div aria-hidden className="h-4" />
  );
const Quiet = ({ children }: { children: React.ReactNode }) => (
  <span className="text-fog">{children}</span>
);
const Ink = ({ children }: { children: React.ReactNode }) => (
  <span className="text-midnight-ink">{children}</span>
);

function FirstRunTranscript() {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-ash-border bg-warm-sand p-4 sm:p-8">
      <div className="rounded-xl border border-ash-border bg-parchment-white p-5 sm:p-7">
        <div className="space-y-1.5 font-mono text-[12px] sm:text-[13px]">
          <Ln>
            <Quiet>$</Quiet> <Ink>npx rightmodeler init</Ink>
          </Ln>
          <Ln />
          <Ln>Found trace files:</Ln>
          <Ln>
            <Ink>1.</Ink> Claude Code session, about 26 model calls, 2 hours ago
          </Ln>
          <Ln>
            <Ink>2.</Ink> OpenTelemetry GenAI export, about 37 model calls,
            yesterday
          </Ln>
          <Ln>
            Choose a trace file <Ink>[1]</Ink>:
          </Ln>
          <Ln />
          <Ln>
            scan: <Ink>completed</Ink> · ingest: <Ink>completed</Ink> · corpus:{" "}
            <Ink>completed</Ink>
          </Ln>
          <Ln>
            shortlist: <Ink>completed</Ink>
          </Ln>
          <Ln />
          <Ln>
            <Quiet>
              Replay calls cheaper models through any OpenAI-compatible
              endpoint, such as OpenRouter or the Vercel AI Gateway.
            </Quiet>
          </Ln>
          <Ln>Provider base URL:</Ln>
        </div>
      </div>

      <div className="mt-auto max-w-md pt-6 sm:pt-8">
        <p className="font-mono text-caption uppercase text-driftwood">
          The first run
        </p>
        <p className="mt-2 text-body text-midnight-ink">
          It finds your traces, runs free through shortlist, and asks before
          anything spends.
        </p>
      </div>
    </div>
  );
}

// ── One run-mode card: icon seat up top (the agent page's grammar), words in the middle, and the
// command or link anchored to the bottom edge so the four actions sit level across the row.
function RunModeCard({
  Icon,
  name,
  body,
  grain,
  children,
}: {
  Icon: typeof TerminalIcon;
  name: string;
  body: string;
  grain?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-6">
      {/* Grainy brand-gradient backdrop, shared with the agent page's deliverable panel; the
          accent hues live only inside this generated image. */}
      {grain !== undefined && (
        <Image
          src={grain}
          alt=""
          fill
          aria-hidden
          className="-z-10 object-cover object-left-bottom"
          sizes="(min-width: 1024px) 33vw, 100vw"
        />
      )}
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-ash-border bg-parchment-white text-driftwood">
        <Icon size={19} />
      </span>
      <div className="mt-6 sm:mt-8">
        <h3 className="font-sans text-heading-sm text-midnight-ink">{name}</h3>
        <p className="mt-2 text-body text-driftwood">{body}</p>
      </div>
      <div className="mt-auto pt-6">{children}</div>
    </div>
  );
}

export default function HowItWorksPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("How rightmodeler works", "/how-it-works")} />

      <PageHero
        eyebrow="How it works"
        title="How rightmodeler works"
        lede="Run it from your terminal, your coding agent, or on autopilot. The same loop everywhere, measured on the traces you already have."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      {/* ── Run it: the four surfaces, commands first. The terminal pair leads at panel scale
          (mode card + the first-run transcript, the page's one artifact); the other three modes
          sit as equal boxes below, the agent page's card grammar throughout. ── */}
      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-20">
          <Reveal>
            <p className="font-mono text-caption uppercase text-fog">Run it</p>
            <h2 className="mt-4 max-w-2xl font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
              Pick your surface. Same loop underneath.
            </h2>
          </Reveal>

          <div className="mt-8 grid gap-4 sm:mt-10 sm:gap-5 lg:grid-cols-3">
            <Reveal delay={0.06} className="h-full">
              <RunModeCard
                Icon={TerminalIcon}
                grain="/agent/showcase-grain.jpg"
                name="From your terminal"
                body="One command, nothing to install. It finds the traces Claude Code and Codex already left on disk, or asks for a file, and runs free through shortlist. Add a provider only when you want the replay, and estimate projects that spend first."
              >
                <div className="rounded-xl border border-ash-border bg-parchment-white p-4 sm:p-5">
                  <CommandBlock
                    comment="# needs Node 24 or newer"
                    command={RUN_COMMAND}
                  />
                </div>
              </RunModeCard>
            </Reveal>

            <Reveal delay={0.12} className="h-full lg:col-span-2">
              <FirstRunTranscript />
            </Reveal>
          </div>

          <div className="mt-4 grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Reveal delay={0.06} className="h-full">
              <RunModeCard
                Icon={AgentSparkIcon}
                name="From your coding agent"
                body="One install gives Claude Code and Codex-class agents the runbook to drive the whole loop: plan preview, staged runs, boundary resumes, and an apply dry run before anything ships."
              >
                <div className="rounded-xl border border-ash-border bg-parchment-white p-4 sm:p-5">
                  <CommandBlock
                    comment="# for Claude Code and Codex-class agents"
                    command={SKILL_COMMAND}
                  />
                </div>
              </RunModeCard>
            </Reveal>

            <Reveal delay={0.12} className="h-full">
              <RunModeCard
                Icon={ScheduleIcon}
                name="In CI, on a schedule"
                body="The same command runs unattended. Every event streams as JSON lines, and the exit code is the verdict, so a weekly job can audit, stop at a named boundary, and resume."
              >
                <p className="border-t border-ash-border pt-3 font-mono text-[13px] text-driftwood">
                  <span className="text-fog">exits </span>0 no recommendation ·
                  1 recommendation · 2 needs input · 3 budget reached
                </p>
              </RunModeCard>
            </Reveal>

            <Reveal delay={0.18} className="h-full">
              <RunModeCard
                Icon={ServerRackIcon}
                grain="/how-it-works/autopilot-grain.jpg"
                name="On autopilot, self-hosted"
                body="Clone the repo, build it, and start the agent on a Node 24 host. New model releases, price drops, and drift arrive as pull requests with the evidence attached. A hosted version is on the waitlist."
              >
                <Link
                  href="/agent"
                  className="group inline-flex items-center gap-2 rounded text-body text-midnight-ink transition-colors duration-150 hover:text-driftwood focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-warm-sand"
                >
                  Meet the agent
                  <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
                </Link>
              </RunModeCard>
            </Reveal>
          </div>
        </div>
      </section>

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
              , then reports the evidence, sample size, and abstentions for your
              review.
            </Tldr>
          </Reveal>

          {/* Where traces come from — the plain-language beat for readers who have never met the
              word. It sits before the pipeline so "raw traces" below already means something. */}
          <Reveal
            delay={0.06}
            className="mt-12 border-t border-ash-border pt-8"
          >
            <p className="font-display text-heading-sm text-midnight-ink">
              Where traces come from.
            </p>
            <p className="mt-2 max-w-xl text-body text-driftwood">
              Traces are the logs your AI tools already write: the models
              called, their inputs, and their outputs. If you use Claude Code or
              Codex, those logs are already on disk, and init finds them
              automatically. If your app logs to an observability tool like
              Langfuse, Braintrust, LangSmith, Helicone, or W&B Weave, export a
              file and point init at it. You never have to produce anything new.
            </p>
            <Link
              href="/integrations"
              className="group mt-4 inline-flex items-center gap-2 rounded text-body text-midnight-ink transition-colors duration-150 hover:text-driftwood focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
            >
              See every supported source
              <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
            </Link>
          </Reveal>

          {/* The pipeline: one continuous hairline spine with numbered nodes.
              No card fills; warm-sand barely separates from the canvas, so depth
              comes from the spine, the display-face step titles, and a
              hairline-topped machine-output line per step. Numbering is earned:
              this is a real Detect -> Measure -> Review sequence. */}
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

          <Reveal
            delay={0.08}
            className="mt-12 border-t border-ash-border pt-8"
          >
            <p className="font-display text-heading-sm text-midnight-ink">
              How to read confidence.
            </p>
            <p className="mt-2 max-w-xl text-body text-driftwood">
              Hard checks run before a model judge. When judgment is needed, a
              cross-family judge scores both output orders. Every rate is a
              statistical lower bound, not a point estimate, and a shortlist
              winner must clear your quality floor again on held-out cases
              before it is recommended. Evidence counts show what earned the
              confidence band, and the evidence type limits how high that band
              can go. Confidence applies only to the prompt, inputs, and runs
              evaluated. It measures agreement with what you shipped, not proof
              of correctness.
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-12 border-t border-ash-border pt-8">
            <p className="font-display text-heading-sm text-midnight-ink">
              Not observability. Not a runtime gateway.
            </p>
            <p className="mt-2 max-w-xl text-body text-driftwood">
              Observability only shows you problems; a gateway hijacks live
              traffic. rightmodeler measures candidates on runs you already
              shipped, then applies only the edits you approve.
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
                { href: "/vs", label: "Compare alternatives" },
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
