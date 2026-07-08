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
    "Crucible is rightmodeler, hosted and always-on: connect over MCP and it continuously replays new traces through cheaper models, proves what's safe, and applies the swap. Join the waitlist.",
  path: "/crucible",
});

const BULLETS: { title: string; body: string }[] = [
  {
    title: "Detect, prove, fix, continuously",
    body: "The same loop rightmodeler runs today, always-on: every new trace is audited as it arrives, so your model stack stays right-sized instead of drifting.",
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
    a: "Crucible is rightmodeler, hosted and always-on. Instead of running the audit yourself, you connect your pipeline once and Crucible replays every new trace through cheaper models, proves what's safe against what you shipped, and applies the swap, continuously.",
  },
  {
    q: "When can I use it?",
    a: "Crucible is in active development. Join the waitlist and we'll send an early-access note when it opens. The open-source engine, rightmodeler, is available now on GitHub.",
  },
  {
    q: "How does it connect?",
    a: "Over MCP, using the tracing you already emit, with no new SDK. You keep your own API keys and can route through OpenRouter, the Vercel AI Gateway, or LiteLLM.",
  },
];

export default function CruciblePage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Crucible", "/crucible")} />

      <PageHero
        eyebrow="Coming soon · by rightmodeler"
        title="Crucible: your model stack, continuously refined."
        lede="rightmodeler, hosted and always-on. No dashboards to babysit, no runtime risk."
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
              Connect your pipeline over MCP and Crucible replays every new
              trace through cheaper models, proves what&apos;s safe against{" "}
              <span className="text-midnight-ink">what you shipped</span>, and
              applies the swap, continuously.
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
              Crucible is in active development. The open-source engine behind
              it, rightmodeler, is available now on GitHub.
            </p>
            <div className="mt-6">
              <GithubButton />
            </div>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/how-it-works", label: "How it works" },
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
