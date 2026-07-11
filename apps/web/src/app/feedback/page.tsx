import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { FeedbackForm } from "@/components/sections/feedback-form";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Reveal } from "@/components/reveal";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Feedback",
  description:
    "Tell the rightmodeler team what to build, what broke, and what the agent should handle next. We read everything.",
  path: "/feedback",
});

export default function FeedbackPage() {
  return (
    <PageShell>
      <JsonLd data={breadcrumbLd("Feedback", "/feedback")} />

      <PageHero
        eyebrow="Feedback"
        title="Tell us where to aim."
        lede="Rough edges, missing features, trace formats we should read, steps the agent should never touch. We read everything, and it shapes what ships next."
      >
        <div className="max-w-md">
          <FeedbackForm />
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:px-10 sm:py-20">
          <Reveal>
            <p className="max-w-xl text-body text-driftwood">
              Prefer email? Reach us directly at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
              >
                {CONTACT_EMAIL}
              </a>
              . Replies come from a founder, not a queue.
            </p>
          </Reveal>

          <div className="mt-12 border-t border-ash-border pt-8">
            <RelatedLinks
              links={[
                { href: "/agent", label: "rightmodeler agent" },
                { href: "/crucible", label: "Crucible" },
                { href: "/blog", label: "Read the blog" },
              ]}
            />
          </div>
        </div>
      </section>
    </PageShell>
  );
}
