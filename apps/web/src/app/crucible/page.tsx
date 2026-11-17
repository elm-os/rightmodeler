import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { CrucibleShowcase } from "@/components/sections/crucible-showcase";
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
  title: "Crucible (in development)",
  description:
    "Crucible, in development, is designed to show cost, speed, and failures for every layer of your production AI system, over MCP and never in the request path.",
  path: "/crucible",
  image: "/social/crucible.png",
});

const FAQ: FaqItem[] = [
  {
    q: "What is Crucible?",
    a: "Crucible is the analytics and optimization suite for production AI systems that rightmodeler is building. It is designed to show what every layer costs, how fast it runs, and where it fails, and to add continuous right-sizing on top of the self-hosted agent's schedule, validating swaps to cheaper models as new traces arrive. It will be a step toward production AI that maintains itself.",
  },
  {
    q: "When can I use it?",
    a: "Not yet. Crucible is in development; join the waitlist and we will send one note when it opens. Today you can run the rightmodeler CLI from npm and self-host the agent, which runs the maintenance loop on a schedule and replays new candidates on your word.",
  },
  {
    q: "How does it connect?",
    a: "It is designed to connect over MCP, using the tracing you already emit, with no new SDK. You will keep your own API keys, and its replays will be able to go through OpenRouter, the Vercel AI Gateway, or LiteLLM.",
  },
  {
    q: "Is it a gateway?",
    a: "No. Crucible is designed to read your traces passively and never sit in your request path. Your traffic keeps flowing through your own keys and providers; Crucible will read the traces it leaves, measure, and report.",
  },
];

export default function CruciblePage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Crucible", "/crucible")} />

      <PageHero
        eyebrow="In development · by rightmodeler"
        title="Crucible: every layer will be measured and right-sized."
        lede="The analytics and optimization suite we are building for production AI systems: what every layer costs, how fast it runs, and where it fails. Software cannot maintain what it cannot see. The self-hosted agent runs the maintenance loop on a schedule today; Crucible will add the instruments."
      >
        <div className="max-w-md">
          <WaitlistForm />
          <p className="mt-3 font-mono text-caption text-fog">
            Join the waitlist. One note when it opens, no spam.
          </p>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 pt-16 sm:px-10 sm:pt-20">
          <Reveal>
            <Tldr>
              Crucible is being built to read the traces your production AI
              systems already emit: cost per layer, speed per step,{" "}
              <span className="text-midnight-ink">failures as they happen</span>
              . It will run the rightmodeler validation loop continuously, on
              top of the self-hosted agent&rsquo;s schedule, so the step behind
              a cost spike comes with measured evidence for a cheaper model it
              could run on.
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
                Crucible itself is in development. The validation framework it
                will build on, the rightmodeler CLI, is on npm now, and the
                self-hosted agent runs it on a schedule today.
              </p>
              <div className="mt-6">
                <GithubButton />
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
