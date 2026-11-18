import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { CrucibleShowcase } from "@/components/sections/crucible-showcase";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { CRUCIBLE_REPO_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Crucible: open-source agent and MCP observability (in development)",
  description:
    "Crucible is being built as open-source, self-hosted observability and analytics for AI agents and MCP servers: one Rust binary that will ingest OpenTelemetry.",
  path: "/crucible",
  image: "/social/crucible.png",
});

const FAQ: FaqItem[] = [
  {
    q: "What is Crucible?",
    a: "An open-source, self-hosted observability and analytics platform for AI agents and MCP servers, being built in the open on GitHub under the MIT license. It is planned as one Rust binary that will ingest OpenTelemetry and serve a REST API, a web UI and an MCP server. Nothing is released yet.",
  },
  {
    q: "When can I use it?",
    a: "Not yet. Crucible is in development and nothing has shipped; star or watch the repository on GitHub to follow along. Today you can run the rightmodeler CLI from npm and self-host the agent, which runs the maintenance loop on a schedule and replays new candidates on your word.",
  },
  {
    q: "How will I send it data?",
    a: "Three ways are planned: OTLP over HTTP or gRPC from any OpenTelemetry SDK; thin SDKs for TypeScript, Python, Go and Rust, with agent helpers and an MCP server wrapper; and an opt-in proxy that instruments an MCP server with no code changes and forwards bytes unchanged.",
  },
  {
    q: "Is it for agents or for MCP servers?",
    a: "Either, or both. It is designed for agents only, for MCP servers only, or for both together, with an agent's tool calls linked to the server-side MCP spans.",
  },
  {
    q: "Where will my data live?",
    a: "On infrastructure you run: Crucible is self-hosted only. Telemetry will be stored in ClickHouse, self-hosted or ClickHouse Cloud, your choice, and Postgres will be the control plane.",
  },
  {
    q: "How will it work with rightmodeler?",
    a: "rightmodeler will replay Crucible traces, through a Crucible export adapter, to validate cheaper or newer models against the outputs you accepted. Coding agents will also be able to ask Crucible about their runs through its MCP server.",
  },
  {
    q: "How is it being built?",
    a: "In the open, with durability and correctness as design goals: a span will be acknowledged only after it is durable on disk, and the system will be tested with deterministic simulation and formal models.",
  },
];

export default function CruciblePage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Crucible", "/crucible")} />

      <PageHero
        eyebrow="In development · built in the open"
        title="Crucible: open-source observability for AI agents and MCP servers."
        lede="Self-hosted observability and analytics, MIT licensed. It is designed for agents only, MCP servers only, or both, with an agent's tool calls linked to the server-side MCP spans. Nothing is released yet."
      >
        <div className="max-w-md">
          <GithubButton
            href={CRUCIBLE_REPO_URL}
            label="Follow Crucible on GitHub"
          />
          <p className="mt-3 font-mono text-caption text-fog">
            Star or watch the repository to follow development.
          </p>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 pt-16 sm:px-10 sm:pt-20">
          <Reveal>
            <Tldr>
              Crucible is being built as one Rust binary. It will ingest
              OpenTelemetry (OTLP over HTTP and gRPC) and serve a REST API, a
              web UI and an MCP server, so{" "}
              <span className="text-midnight-ink">
                coding agents will be able to query their own traces
              </span>
              . Telemetry will be stored in ClickHouse, self-hosted or
              ClickHouse Cloud, your choice, and Postgres will be the control
              plane.
            </Tldr>
          </Reveal>
        </div>

        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <Reveal>
            <CrucibleShowcase />
          </Reveal>
        </div>

        <div className="mx-auto max-w-3xl px-6 pb-16 sm:px-10 sm:pb-20">
          <Reveal delay={0.1}>
            <div className="rounded-2xl border border-ash-border bg-warm-sand p-6 sm:p-8">
              <p className="font-mono text-caption uppercase text-fog">
                Available today: the CLI and the agent
              </p>
              <p className="mt-3 max-w-xl text-body text-driftwood">
                Crucible itself is in development. rightmodeler will replay
                Crucible traces to validate cheaper or newer models, and agents
                will be able to ask Crucible about their runs over MCP. The
                rightmodeler CLI is on npm now, and the self-hosted agent runs
                it on a schedule today.
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
                { href: "/manifesto", label: "Read the manifesto" },
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
