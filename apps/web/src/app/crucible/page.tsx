import type { Metadata } from "next";
import { Fragment } from "react";
import { CommandBlock } from "@/components/command-block";
import { JsonLd } from "@/components/json-ld";
import { CrucibleShowcase } from "@/components/sections/crucible-showcase";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { Reveal } from "@/components/reveal";
import {
  CRUCIBLE_DOWNLOAD_COMMAND,
  CRUCIBLE_QUICKSTART_URL,
  CRUCIBLE_SDK_GUIDES,
  CRUCIBLE_SEND_COMMAND,
  CRUCIBLE_SETUP_COMMAND,
  CRUCIBLE_START_COMMAND,
} from "@/lib/crucible";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import {
  CRUCIBLE_DISCUSSIONS_IDEAS_URL,
  CRUCIBLE_DISCUSSIONS_QA_URL,
  CRUCIBLE_ISSUES_NEW_URL,
  CRUCIBLE_REPO_URL,
} from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Crucible: open-source agent and MCP observability",
  description:
    "Crucible is open-source, self-hosted observability and analytics for AI agents and MCP servers: one Rust binary, built for speed and throughput, that ingests OpenTelemetry traces.",
  path: "/crucible",
  image: "/social/crucible.png",
});

const STEPS = [
  {
    name: "Send",
    body: "Your agents and MCP servers send OpenTelemetry traces over HTTP or gRPC, from any OpenTelemetry SDK or instrumentation library, from Crucible's SDKs, or through the MCP proxy, which needs no code changes.",
  },
  {
    name: "Write ahead",
    body: "Crucible validates each request in a single pass over its bytes, then appends it to a write-ahead log. Concurrent requests share one fsync, and your app gets its acknowledgment only once its spans are on disk.",
  },
  {
    name: "Store once",
    body: "A shipper batches spans into ClickHouse in its native column format, compressed. Each insert carries a token from its place in the log, so a retry after a timeout or a crash never stores a span twice.",
  },
  {
    name: "Read",
    body: "Recent spans sit in an in-memory index, so a trace can be read as soon as it is acknowledged. The web UI, the REST API, the SQL workspace and the MCP server read the same data, and alerts and exports run on it.",
  },
];

const STACK = [
  "One Rust binary",
  "OpenTelemetry traces",
  "ClickHouse 26.3 or newer",
  "Postgres 15 or newer",
];

const HOT_PATH = [
  {
    key: "parse",
    value: "one pass over the request bytes, no copies, no allocation",
  },
  { key: "commit", value: "group commit: concurrent requests share one fsync" },
  {
    key: "encode",
    value: "ClickHouse's native column format, LZ4, built in process",
  },
  {
    key: "insert",
    value: "one insert per batch and partition, resent byte for byte",
  },
  {
    key: "memory",
    value: "fixed byte budgets, then 429 or 503 with Retry-After",
  },
  {
    key: "build",
    value: "opt-level 3, thin LTO, one codegen unit, mimalloc",
  },
];

const REASONS = [
  {
    title: "Every acknowledged span is on disk.",
    body: "Crucible acknowledges a request only after its spans are written to the log and synced, and a batch that ClickHouse never confirmed is sent again after a crash with the same token, so it lands once. We test this with deterministic simulation that injects disk, network, ClickHouse and crash faults, swarm testing across configurations, a formal model of the ingest protocol, and machine-checked proofs of the log format.",
  },
  {
    title: "Both sides of the tool call.",
    body: "When an agent's MCP client passes trace context with each request, as Crucible's SDKs do, the agent's tool call and the server's span of it land in one trace. A slow or failing tool shows up where the agent felt it.",
  },
  {
    title: "Yours to run.",
    body: "Crucible is open source under the MIT license and runs on infrastructure you control: your traces stay in your ClickHouse, and your accounts, projects and keys in your Postgres.",
  },
];

const START = [
  {
    name: "Get the Compose file",
    comment:
      "# needs Docker; makes a crucible folder for the Compose file, which runs the published Crucible image",
    command: CRUCIBLE_DOWNLOAD_COMMAND,
  },
  {
    name: "Start the stack",
    comment:
      "# in bash or zsh: writes three secrets and the release's image to .env, then starts ClickHouse, Postgres and Crucible",
    command: CRUCIBLE_START_COMMAND,
  },
  {
    name: "Create your organization",
    comment: "# prints the one-time setup link",
    command: CRUCIBLE_SETUP_COMMAND,
    after:
      "Open the printed /setup/ link on http://127.0.0.1:8080, create your organization and its owner, then create an API key under Settings, then API keys.",
  },
  {
    name: "Send traces",
    comment: "# point any OpenTelemetry exporter at Crucible",
    command: CRUCIBLE_SEND_COMMAND,
    after: (
      <>
        Your traces appear at http://127.0.0.1:8080/traces/ as soon as Crucible
        acknowledges them. These variables cover traces only, which is all
        Crucible takes, so metrics and logs stay where they go today.
        Crucible&apos;s SDKs for <SdkGuideLinks /> send the same OTLP and add
        helpers for agents and MCP servers.
      </>
    ),
  },
];

const FAQ: FaqItem[] = [
  {
    q: "What is Crucible?",
    a: "Open-source, self-hosted observability and analytics for AI agents and MCP servers, under the MIT license. It is one Rust binary that ingests OpenTelemetry traces and serves a web UI, a REST API and an MCP server, with ClickHouse for telemetry and Postgres for the control plane.",
  },
  {
    q: "How do I send it data?",
    a: (
      <>
        Send OTLP traces over HTTP, as protobuf or JSON, or over gRPC, from any
        OpenTelemetry SDK or exporter. Spans from OpenInference, OpenLLMetry,
        the Vercel AI SDK, MLflow and Pydantic AI are mapped as they arrive.
        Crucible&apos;s SDKs for <SdkGuideLinks /> add agent helpers and an MCP
        server wrapper, and the MCP proxy records an MCP server&apos;s calls
        with no code changes and forwards its traffic unchanged.
      </>
    ),
  },
  {
    q: "How do I install it?",
    a: "With Docker: the Compose file runs the published Crucible image, for amd64 and arm64, beside a bundled ClickHouse and Postgres. Or install the crucible binary from the GitHub release with its shell or PowerShell installer. The durability described below holds on Linux and macOS; the Windows binary is for development.",
  },
  {
    q: "Is it for agents or for MCP servers?",
    a: "Either, or both. Use it for agents only, for MCP servers only, or for both together, with an agent's tool calls linked to the server-side MCP spans through trace context.",
  },
  {
    q: "Where does my data live?",
    a: "On infrastructure you run. Crucible is self-hosted only: telemetry goes to ClickHouse 26.3 or newer, on a single server or a self-hosted cluster of replicas coordinated by ClickHouse Keeper, and accounts, projects and keys go to Postgres 15 or newer. The Docker Compose stack bundles both.",
  },
  {
    q: "Why Rust?",
    a: "For speed, throughput and predictable memory. Crucible parses OTLP without copying it, shares each fsync across concurrent requests, writes ClickHouse's native column format itself and holds memory inside fixed budgets, with no garbage collector pausing ingest. It all runs as one binary next to ClickHouse and Postgres.",
  },
  {
    q: "How does it avoid losing spans?",
    a: "It acknowledges a request only after its spans are written to a write-ahead log and synced to disk, and each batch reaches ClickHouse with a deduplication token, so a retry never stores a span twice. When it is saturated, it answers 429 or 503 with Retry-After instead of dropping data. We test this with deterministic simulation that injects faults, swarm testing, a formal model of the ingest protocol and proofs of the log format.",
  },
  {
    q: "How does it work with rightmodeler?",
    a: "crucible export writes your traces as OpenTelemetry JSON, and the rightmodeler CLI replays them to validate cheaper or newer models against the outputs you accepted. Crucible does not run the validation loop or swap models. Coding agents can also ask Crucible about their runs through its MCP server, whose tools list and search traces, read spans and payloads, report MCP server analytics and create exports.",
  },
  {
    q: "Is there a hosted version?",
    a: "No. Crucible is self-hosted only: you run it, with your own ClickHouse and Postgres, wherever you run Docker or its binary.",
  },
];

// The four SDK guides as links, in a sentence: TypeScript, Python, Go and Rust.
function SdkGuideLinks() {
  return CRUCIBLE_SDK_GUIDES.map((sdk, i) => (
    <Fragment key={sdk.name}>
      {i === 0 ? "" : i === CRUCIBLE_SDK_GUIDES.length - 1 ? " and " : ", "}
      <a href={sdk.url} className={linkClass}>
        {sdk.name}
      </a>
    </Fragment>
  ));
}

const linkClass =
  "text-body text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

export default function CruciblePage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Crucible", "/crucible")} />

      <PageHero
        eyebrow="Open source · Self-hosted"
        title="Crucible: open-source observability for AI agents and MCP servers."
        lede="Built in Rust and engineered for speed and throughput. Use it for agents, for MCP servers, or both, with an agent's tool calls linked to the server-side MCP spans."
      >
        <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
          <GithubButton href={CRUCIBLE_REPO_URL} label="Crucible on GitHub" />
          <a href="#get-started" className={linkClass}>
            Get started
          </a>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 pt-16 sm:px-10 sm:pt-20">
          <Reveal>
            <Tldr>
              Crucible is one Rust binary. It ingests OpenTelemetry traces over
              HTTP and gRPC, writes every request to disk before it acknowledges
              it, and stores telemetry in ClickHouse, with Postgres as the
              control plane. It serves a web UI, a REST API and an MCP server,
              so{" "}
              <span className="text-midnight-ink">
                coding agents can query their own traces
              </span>
              .
            </Tldr>
          </Reveal>
        </div>

        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <Reveal>
            <CrucibleShowcase />
          </Reveal>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section
        id="how-it-works"
        aria-labelledby="crucible-how"
        className="scroll-mt-20 bg-parchment-white"
      >
        <div className="px-4 py-14 sm:px-6 sm:py-20">
          <Reveal>
            <p className="font-mono text-caption uppercase text-fog">
              How it works
            </p>
            <h2
              id="crucible-how"
              className="mt-4 max-w-2xl font-display text-heading text-balance text-midnight-ink sm:text-heading-lg"
            >
              One binary, from span to screen.
            </h2>
            <p className="mt-4 max-w-2xl text-body text-driftwood">
              Crucible runs beside ClickHouse and Postgres, and every span takes
              the same four steps through it.
            </p>
          </Reveal>

          <ol className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <li key={step.name} className="h-full">
                <Reveal delay={0.06 * i} className="h-full">
                  <div className="flex h-full flex-col rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-6">
                    <span className="font-mono text-caption text-fog">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="mt-6 font-sans text-heading-sm text-midnight-ink">
                      {step.name}
                    </h3>
                    <p className="mt-2 text-body text-driftwood">{step.body}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ol>

          <Reveal delay={0.1} className="mt-6">
            <ul className="flex flex-wrap gap-2">
              {STACK.map((chip) => (
                <li
                  key={chip}
                  className="inline-flex items-center rounded-md border border-ash-border bg-parchment-white px-3 py-1.5 font-mono text-caption text-driftwood"
                >
                  {chip}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section
        id="why"
        aria-labelledby="crucible-why"
        className="scroll-mt-20 bg-parchment-white"
      >
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal className="max-w-xl">
            <p className="font-mono text-caption uppercase text-fog">
              Why we built it
            </p>
            <h2
              id="crucible-why"
              className="mt-4 font-display text-heading text-balance text-midnight-ink sm:text-heading-lg"
            >
              You cannot maintain what you cannot see.
            </h2>
            <p className="mt-4 text-body text-driftwood">
              rightmodeler takes the work out of the loop, not the judgment, and
              that work starts with seeing what your production AI systems do:
              every model call, what it cost, how long it took, and every MCP
              tool it reached. We built Crucible to be that instrument panel,
              and to keep up with the traffic agents produce.
            </p>
          </Reveal>

          <Reveal delay={0.06} className="mt-12">
            <h3 className="font-sans text-heading-sm text-midnight-ink">
              Built in Rust, for speed and throughput.
            </h3>
            <p className="mt-2 text-body text-driftwood">
              Agent traffic is heavy: long prompts, large tool payloads, and
              bursts of spans when agents fan out. Crucible is written in Rust
              with no unsafe code, and its ingest path is built to do as little
              work per span as it can.
            </p>
            <div className="mt-5 overflow-x-auto rounded-lg border border-ash-border bg-midnight-ink/5 p-4">
              <div className="flex min-w-max flex-col gap-y-2 font-mono text-[13px] sm:min-w-0">
                {HOT_PATH.map((row) => (
                  <div key={row.key} className="flex gap-x-3">
                    <span className="w-16 shrink-0 text-fog">{row.key}</span>
                    <span className="min-w-0 text-driftwood">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-2 font-mono text-caption text-fog">
              the ingest path, as built
            </p>
          </Reveal>

          <ul className="mt-10 divide-y divide-ash-border border-y border-ash-border">
            {REASONS.map((reason, i) => (
              <li key={reason.title} className="py-5">
                <Reveal delay={0.06 * i}>
                  <h3 className="font-sans text-heading-sm text-midnight-ink">
                    {reason.title}
                  </h3>
                  <p className="mt-1 text-body text-driftwood">{reason.body}</p>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section
        id="get-started"
        aria-labelledby="crucible-start"
        className="scroll-mt-20 bg-parchment-white"
      >
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal className="max-w-xl">
            <p className="font-mono text-caption uppercase text-fog">
              Get started
            </p>
            <h2
              id="crucible-start"
              className="mt-4 font-display text-heading text-balance text-midnight-ink sm:text-heading-lg"
            >
              Run it on your own machine.
            </h2>
            <p className="mt-4 text-body text-driftwood">
              You need Docker, plus curl and openssl in a POSIX shell (Git Bash
              or WSL on Windows). Download the Compose file, start Crucible with
              a bundled ClickHouse and Postgres, and send your first trace.
            </p>
          </Reveal>

          <ol className="mt-10 flex flex-col gap-4 sm:gap-5">
            {START.map((step, i) => (
              <li key={step.name}>
                <Reveal delay={0.06 * i}>
                  <div className="rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-6">
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-caption text-fog">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <h3 className="font-sans text-heading-sm text-midnight-ink">
                        {step.name}
                      </h3>
                    </div>
                    <div className="mt-4 rounded-xl border border-ash-border bg-parchment-white p-4 sm:p-5">
                      <CommandBlock
                        comment={step.comment}
                        command={step.command}
                      />
                    </div>
                    {step.after && (
                      <p className="mt-4 text-body text-driftwood">
                        {step.after}
                      </p>
                    )}
                  </div>
                </Reveal>
              </li>
            ))}
          </ol>

          <Reveal delay={0.1} className="mt-8">
            <p className="max-w-xl text-body text-driftwood">
              The quickstart in the Crucible docs walks through each step in
              more detail.
            </p>
            <a
              href={CRUCIBLE_QUICKSTART_URL}
              className={`mt-3 inline-block ${linkClass}`}
            >
              Read the quickstart
            </a>
          </Reveal>

          <Reveal delay={0.1} className="mt-8">
            <p className="max-w-xl text-body text-driftwood">
              Questions and feedback: ask in{" "}
              <a href={CRUCIBLE_DISCUSSIONS_QA_URL} className={linkClass}>
                Q&amp;A
              </a>{" "}
              and share ideas in{" "}
              <a href={CRUCIBLE_DISCUSSIONS_IDEAS_URL} className={linkClass}>
                Ideas
              </a>{" "}
              on GitHub Discussions, and report bugs in{" "}
              <a href={CRUCIBLE_ISSUES_NEW_URL} className={linkClass}>
                GitHub issues
              </a>
              .
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-16">
            <div className="rounded-2xl border border-ash-border bg-warm-sand p-6 sm:p-8">
              <p className="font-mono text-caption uppercase text-fog">
                Works with rightmodeler
              </p>
              <p className="mt-3 max-w-xl text-body text-driftwood">
                <span className="font-mono text-[13px] text-midnight-ink">
                  crucible export
                </span>{" "}
                writes your traces as OpenTelemetry JSON, and the rightmodeler
                CLI replays them to validate cheaper or newer models against the
                outputs you accepted. Crucible does not run the validation loop
                itself. Coding agents can also ask Crucible about their runs
                through its MCP server.
              </p>
              <div className="mt-6">
                <GithubButton label="rightmodeler on GitHub" />
              </div>
            </div>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How the validation works" },
                {
                  href: "/agent",
                  label: "rightmodeler agent, the maintenance loop",
                },
                {
                  href: "/blog/the-bill-nobody-can-read",
                  label: "The bill nobody can read",
                },
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
