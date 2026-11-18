import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { SocialLinks } from "@/components/sections/social-links";
import { breadcrumbLd, organizationLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "About",
  description:
    "rightmodeler is working toward production AI that maintains and optimizes itself, starting with open-source validation of cheaper or newer model swaps on your traces.",
  path: "/about",
});

const FAQ: FaqItem[] = [
  {
    q: "What is rightmodeler?",
    a: "An open-source project from ELM-OS, working toward production AI systems that maintain and optimize themselves. It starts with a validation framework for model swaps: the rightmodeler CLI validates swaps to cheaper or newer models on your production traces and opens each one that clears every release gate as a draft pull request that changes only model identifiers, for a person to review and merge.",
  },
  {
    q: "Is it open source?",
    a: "Yes, MIT licensed. The rightmodeler CLI and rightmodeler agent are both in the public GitHub repo, free to run, fork, and modify. The CLI is on npm today. The agent is self-hosted today: you clone and build it, then run it on a long-lived Node 24 host with your own GitHub App and model credentials. A hosted version of the agent has a waitlist. Crucible, open-source observability and analytics for AI agents and MCP servers, is being built in the open in its own MIT-licensed repository.",
  },
  {
    q: "How is it different from observability or a gateway?",
    a: "It answers a narrower question: whether a cheaper or newer model agrees with the outputs you accepted, step by step. Observability records what your app did, and a gateway serves the model you pin. rightmodeler reads the traces you already export, so your observability tool stays in place, and it can replay candidates through your gateway. It runs offline and never sits in your request path. A swap that clears every release gate becomes a draft pull request that changes only model identifiers, for a person to review and merge.",
  },
];

export default function AboutPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("About", "/about")} />
      <JsonLd data={organizationLd()} />

      <PageHero
        eyebrow="About"
        title="About rightmodeler"
        lede="Working toward production AI that maintains and optimizes itself, starting with validated model swaps."
      />

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-16 sm:px-8 sm:py-20">
          <p className="text-subheading text-driftwood">
            rightmodeler is an open-source project from ELM-OS. We think the
            biggest bottleneck in maintaining software is the human in the loop:
            not the judgment, the work.
          </p>
          <p className="text-body text-driftwood">
            We are solving it first for production AI systems, where a new model
            ships every few weeks and each one restarts the same manual job:
            notice it, pull real traces, build a replay, grade the outputs,
            write it up so it survives review, migrate, and do it again.
          </p>
          <p className="text-body text-driftwood">
            So we started with a validation framework for model swaps. The
            rightmodeler CLI reads the model calls your app already recorded,
            replays the recorded steps on cheaper or newer candidate models, and
            has a judge from a different vendor, or your own evaluator, grade
            every answer against the output you accepted. A swap that clears
            every release gate becomes a draft pull request that changes only
            model identifiers, with the evidence attached.
          </p>
          <p className="text-body text-driftwood">
            A swap is safe, in rightmodeler&rsquo;s terms, when it clears every
            release gate on your own traces: agreement with the outputs you
            accepted, at a statistical lower bound that reaches your quality
            floor on held-out cases, with swaps that feed later model steps
            confirmed end to end in a sandbox. rightmodeler measures agreement
            with what you shipped, not ground-truth correctness, and abstains
            when the evidence is thin.
          </p>
          <p className="text-body text-driftwood">
            The mission:{" "}
            <span className="font-medium text-midnight-ink">
              production AI systems that maintain and optimize themselves,
              earning each step of autonomy with evidence
            </span>
            . The direction is a system that maintains itself inside the policy
            you set, reached one validated change at a time.
          </p>
          <p className="text-body text-driftwood">
            Today a person sets the policy (the quality floor, which models are
            allowed, an optional spend cap), gives the agent the word before it
            replays a new candidate, and decides which draft pull requests
            merge. Rolling back is one command that opens another pull request.
            That is deliberate: autonomy is earned with evidence, and validation
            is how rightmodeler earns it.
          </p>
          <p className="text-body text-driftwood">
            The CLI is on npm today. rightmodeler agent, the maintenance loop on
            a schedule, is in the same MIT-licensed repo, and you can self-host
            it today; a hosted version has a waitlist. Crucible, open-source
            observability and analytics for AI agents and MCP servers, is being
            built in the open in its own repository. The CLI and the agent run
            offline, beside your app: the CLI on your machine or in CI, the
            agent on a host you run. Nothing sits in your request path, and
            there is no rightmodeler server and no telemetry.
          </p>

          <div className="pt-2">
            <p className="font-mono text-caption uppercase text-fog">Find us</p>
            <SocialLinks className="mt-3 -ml-2.5" />
          </div>

          <div className="border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
                { href: "/manifesto", label: "Read the manifesto" },
                { href: "/agent", label: "rightmodeler agent" },
                { href: "/crucible", label: "Crucible" },
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
