import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { Faq, type FaqItem } from "@/components/sections/faq";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { WaitlistForm } from "@/components/sections/waitlist-form";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Crucible (coming soon)",
  description:
    "Crucible is the analytics and optimization suite for your AI agents: cost per layer, speed per step, failures as they happen, and a model stack that keeps itself right-sized. Join the waitlist.",
  path: "/crucible",
});

const BULLETS: { title: string; body: string }[] = [
  {
    title: "Cost, by layer",
    body: "One invoice becomes a map. See exactly what each agent, step, and model spends, so the bill finally has line items you can act on.",
  },
  {
    title: "Speed, by step",
    body: "Latency broken down where it happens: p50 and p95 per step, so the slow layer stops hiding inside an aggregate.",
  },
  {
    title: "Failures, as they happen",
    body: "Failed tool calls, silent retries, and quality regressions surface in a passive feed. No stack trace does not mean nothing went wrong.",
  },
  {
    title: "Continuously right-sized",
    body: "The same detect, prove, fix loop rightmodeler runs today, always-on: every new trace is audited as it arrives, so your model stack stays right-sized instead of drifting.",
  },
  {
    title: "Connected over MCP",
    body: "Works with the tracing you already have. Crucible reads your traces over MCP, with no new SDK and no re-instrumentation.",
  },
  {
    title: "Your keys, your routes",
    body: "BYO API keys, or route through OpenRouter, the Vercel AI Gateway, or LiteLLM. Your traffic, your providers. Crucible never becomes a hop in your request path.",
  },
];

const FAQ: FaqItem[] = [
  {
    q: "What is Crucible?",
    a: "Crucible is the analytics and optimization suite for AI agents, by rightmodeler. It shows what every layer of your agent system costs, how fast it runs, and where it fails, and it runs the rightmodeler proof loop continuously so your model stack stays right-sized as new traces arrive.",
  },
  {
    q: "When can I use it?",
    a: "Crucible is in active development. Join the waitlist and we'll send an early-access note when it opens. The engine behind it, the rightmodeler skill, is available now on GitHub.",
  },
  {
    q: "How does it connect?",
    a: "Over MCP, using the tracing you already emit, with no new SDK. You keep your own API keys and can route through OpenRouter, the Vercel AI Gateway, or LiteLLM.",
  },
  {
    q: "Is it a gateway?",
    a: "No. Crucible reads your traces passively and never sits in your request path. Your traffic keeps flowing through your own keys and routes; Crucible watches, measures, and proves.",
  },
];

export default function CruciblePage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Crucible", "/crucible")} />

      <PageHero
        eyebrow="Coming soon · by rightmodeler"
        title="Crucible: every layer, measured and right-sized."
        lede="The analytics and optimization suite for your AI agents. See what every layer costs, how fast it runs, and where it fails, while Crucible keeps your model stack right-sized, continuously."
      >
        <div className="max-w-md">
          <WaitlistForm />
          <p className="mt-3 font-mono text-caption text-fog">
            Get early access. One note when it opens, no spam.
          </p>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal>
            <Tldr>
              Crucible watches your agents in production: cost per layer, speed
              per step,{" "}
              <span className="text-midnight-ink">
                failures as they happen
              </span>
              . And because it runs the rightmodeler proof loop continuously,
              it does not just show you problems, it right-sizes the stack that
              caused them.
            </Tldr>
          </Reveal>

          <ul className="mt-12 divide-y divide-ash-border border-y border-ash-border">
            {BULLETS.map((b, i) => (
              <Reveal key={b.title} delay={i * 0.06}>
                <li className="py-5">
                  <p className="font-sans text-heading-sm text-midnight-ink">
                    {b.title}
                  </p>
                  <p className="mt-1 text-body text-driftwood">{b.body}</p>
                </li>
              </Reveal>
            ))}
          </ul>

          <Reveal delay={0.1} className="mt-10">
            <p className="max-w-xl text-body text-driftwood">
              Crucible is in active development. The engine behind it, the
              rightmodeler skill, is available now on GitHub.
            </p>
            <div className="mt-6">
              <GithubButton />
            </div>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How the proof works" },
                { href: "/agent", label: "rightmodeler agent, the PR writer" },
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
