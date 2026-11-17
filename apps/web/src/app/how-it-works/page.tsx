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
    "Run rightmodeler from your terminal, coding agent, CI or the self-hosted agent. It validates cheaper or newer models on your traces and opens a draft PR for review.",
  path: "/how-it-works",
  image: "/social/how-it-works.png",
});

// The canonical definition from docs/positioning.md: reuse it verbatim wherever safe is defined.
const SAFE =
  "A swap is safe, in rightmodeler's terms, when it clears every release gate on your own traces: agreement with the outputs you accepted, at a statistical lower bound that reaches your quality floor on held-out cases, with swaps that feed later model steps confirmed end to end in a sandbox. rightmodeler measures agreement with what you shipped, not ground-truth correctness, and abstains when the evidence is thin.";

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
    name: "Validate",
    body: `It replays the recorded steps on cheaper or newer candidate models, and a judge from a different vendor, or your own evaluator, grades every answer against the output you accepted. Replay sends recorded text conversations: cases whose conversation carries tool calls, tool definitions or non-text parts are left out of the replay sample today, and the run says how many. ${SAFE}`,
    label: "checks",
    line: "shortlist screen · held-out lower bound vs quality floor · end-to-end confirmation  →  every gate cleared, or no swap",
  },
  {
    n: "03",
    name: "Review",
    body: "A swap that clears every gate becomes a draft pull request that changes only model identifiers, with the evidence attached, and you review it like any other change. The watch command follows it through review and CI, and if you change your mind after merging, one command opens the pull request that restores the exact pre-swap files. Never a live intercept. Today, the final yes stays yours.",
    label: "applies",
    line: "cleared swaps arrive as a draft pull request · watch follows review and CI · rollback opens a byte-exact restore",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "What do I need to run it?",
    a: 'Node 24 or newer, and the traces your AI tools already write. If you use Claude Code or Codex in your project, init finds their traces automatically. A provider key is only needed when you replay, and "npx rightmodeler estimate --base-url <provider>/v1" projects that spend first with zero paid calls.',
  },
  {
    q: "Which traces are supported?",
    a: `${TRACE_SOURCES.length} formats, autodetected: ${TRACE_SOURCES.slice(0, -1).join(", ")}, and ${TRACE_SOURCES.at(-1)}. rightmodeler folds them all into one per-step schema, so you point it at the traces you already emit, with no new instrumentation.`,
  },
  {
    q: "Does it touch production?",
    a: "No. It is built for production AI systems and validates on the traces your app already recorded, but it runs offline beside your app, on your machine or in CI, and produces a report, plus a draft pull request when a swap clears every gate. It never sits in your request path, routes live traffic, or adds latency; it is not a runtime gateway. Swaps that feed later model steps are confirmed by running your app in a sandbox, apart from production. That sandbox has ordinary network access, so point your app's tools at test fixtures, not production services.",
  },
  {
    q: "Do you store my data?",
    a: "It runs locally on your own traces and your own replay provider key. Replays call your selected provider, OpenRouter, the Vercel AI Gateway, or a LiteLLM proxy, using your key; there is no rightmodeler server holding your traces.",
  },
  {
    q: "Can I use my existing eval framework?",
    a: "Yes. Braintrust, Langfuse, LangSmith, and promptfoo can score the replays instead of the built-in judge, and a reachable configured evaluator is always preferred. You can also build the case set from a curated dataset you already maintain, and push trials and verdicts back to Braintrust or Langfuse when the run completes.",
  },
  {
    q: "Can my coding agent run it?",
    a: "Yes. One install adds a runbook that Claude Code and Codex-class agents follow to drive the whole loop: plan preview, staged runs with resumable boundaries, and an apply dry run before any pull request opens. The runbook drives the same CLI through npx.",
  },
];

// The first-run transcript, abridged: prompts are the current strings in harness/packages/rightmodeler/src/guidance.ts.
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
            <Quiet>$</Quiet> <Ink>{RUN_COMMAND}</Ink>
          </Ln>
          <Ln />
          <Ln>
            How should rightmodeler call models? Replay sends your recorded
            calls to cheaper models, and a judge model from another vendor
            grades each answer.
          </Ln>
          <Ln>
            <Ink>1.</Ink> My plans, through the CLIs signed in on this machine
          </Ln>
          <Ln>
            <Ink>2.</Ink> An API key for a model provider or gateway
          </Ln>
          <Ln>
            Choose <Ink>[1]</Ink>:
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

function RunModeCard({
  Icon,
  name,
  body,
  grain,
  eager,
  children,
}: {
  Icon: typeof TerminalIcon;
  name: string;
  body: string;
  grain?: string;
  /** The card sits above the fold, where its grain is the page's Largest Contentful Paint. */
  eager?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-6">
      {grain !== undefined && (
        <Image
          src={grain}
          alt=""
          fill
          aria-hidden
          loading={eager ? "eager" : undefined}
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
        lede="rightmodeler's validation loop does the hand work of checking a cheaper or newer model: replaying your traces, grading every answer, and writing up the evidence. Run it from your terminal, your coding agent, or on a schedule. Today, the final yes stays yours."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

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
                eager
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
                body="One install gives Claude Code and Codex-class agents the runbook to drive the whole loop: plan preview, staged runs, boundary resumes, and an apply dry run before any pull request opens."
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
                body="The same command runs unattended. Every event streams as JSON lines, and the exit code is the verdict, so a weekly job can validate, stop at a named boundary, and resume."
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
                name="On a schedule, self-hosted"
                body="Clone the repo, build it, and run the agent on a long-lived Node 24 host with your own GitHub App and model credentials. It runs a weekly catalog and price check that flags cheaper new or repriced models, a daily drift check on new traces whose proposals a person approves, and one regression replay for each merged swap set. On your word it replays a new candidate, and once the replay clears every gate it opens the draft pull request. It never merges. The hosted version has a waitlist."
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
              rightmodeler validates cheaper or newer models on the traces you
              already have. It replays the recorded steps on cheaper or newer
              candidates and has a judge from a different vendor, or your own
              evaluator, grade every answer against{" "}
              <span className="text-midnight-ink">
                the outputs you accepted
              </span>
              . A swap becomes a draft pull request only when it clears every
              release gate; when the evidence is thin, it abstains.
            </Tldr>
          </Reveal>

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
                out ▸ report · draft pull request
              </p>
            </div>
          </div>

          <Reveal
            delay={0.08}
            className="mt-12 border-t border-ash-border pt-8"
          >
            <p className="font-display text-heading-sm text-midnight-ink">
              How to read the evidence.
            </p>
            <p className="mt-2 max-w-xl text-body text-driftwood">
              A judge from a different vendor scores both answer orders, or the
              evaluator you name grades the replays: Braintrust, Langfuse,
              LangSmith, or promptfoo, whose assertions can be deterministic
              checks such as is-json or regex. The shortlist half only screens
              candidates on their pass rate; the cheapest one that passes is
              replayed on held-out cases, where a 95% statistical lower bound on
              its agreement, not a point estimate, must reach your quality
              floor, adjusted for how many candidates competed. Failed and
              excluded cases count against the candidate. There are no
              confidence tiers: the sample size shows how much evidence stands
              behind each result. The evidence applies only to the prompts,
              inputs, and runs evaluated. It measures agreement with what you
              shipped, not ground-truth correctness.
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-12 border-t border-ash-border pt-8">
            <p className="font-display text-heading-sm text-midnight-ink">
              Not observability. Not a runtime gateway.
            </p>
            <p className="mt-2 max-w-xl text-body text-driftwood">
              rightmodeler works offline on runs you already shipped. It
              validates cheaper or newer models step by step against the outputs
              you accepted, and only a swap that clears every gate becomes a
              draft pull request, which changes model identifiers and nothing
              else and waits for you to review and merge. Your observability
              tool keeps recording, any gateway keeps serving live traffic, and
              rightmodeler never sits in the request path.
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
              Crucible (in development)
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
