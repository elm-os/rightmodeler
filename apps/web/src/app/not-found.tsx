import Link from "next/link";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";

export default function NotFound() {
  return (
    <PageShell>
      <PageHero
        eyebrow="404 · Not found"
        title="This page isn't in the trace."
        lede="The address may have moved, or it may never have existed. Start again from the homepage or jump straight to the proof loop."
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
          >
            Go to homepage
          </Link>
          <Link
            href="/how-it-works"
            className="inline-flex items-center justify-center rounded-xl border border-ash-border bg-warm-sand px-5 py-3 text-body font-medium text-midnight-ink transition-colors duration-150 ease-out hover:bg-midnight-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
          >
            See how it works
          </Link>
        </div>
      </PageHero>

      <div aria-hidden className="h-px w-full bg-ash-border" />

      <section className="bg-parchment-white px-6 py-12 sm:px-10 sm:py-16">
        <div className="mx-auto max-w-3xl">
          <RelatedLinks
            links={[
              { href: "/integrations", label: "Browse integrations" },
              { href: "/agent", label: "Meet the agent" },
              { href: "/crucible", label: "Explore Crucible" },
              { href: "/blog", label: "Read the research notes" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
