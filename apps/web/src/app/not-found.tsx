import Link from "next/link";
import { Reveal } from "@/components/reveal";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";

// The index files an agent recovers from, which the marketing nav does not carry.
const AGENT_ROUTES = [
  { href: "/sitemap.xml", label: "Sitemap" },
  { href: "/llms.txt", label: "llms.txt" },
  { href: "/llms-context.txt", label: "Full site context" },
];

// Matches the anchor treatment in RelatedLinks exactly, so the two rows read as one component.
const fileLinkClass =
  "text-body text-midnight-ink underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

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
        <div className="mx-auto max-w-3xl space-y-8">
          <RelatedLinks
            links={[
              { href: "/integrations", label: "Browse integrations" },
              { href: "/agent", label: "Meet the agent" },
              { href: "/crucible", label: "Explore Crucible" },
              { href: "/blog", label: "Read the research notes" },
            ]}
          />

          {/*
            The machine-readable way out. An agent that lands here needs the index files, not the
            marketing nav, and none of them were reachable from this page before. Same RelatedLinks
            treatment so it reads as one system; these are files rather than routes, so they use
            plain anchors instead of next/link.
          */}
          <Reveal className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span className="font-mono text-caption uppercase text-fog">
              For agents
            </span>
            {AGENT_ROUTES.map((route) => (
              <a key={route.href} href={route.href} className={fileLinkClass}>
                {route.label}
              </a>
            ))}
          </Reveal>

          <p className="max-w-2xl text-body text-driftwood">
            Every page on this site is also available as Markdown. Append .md to
            any path, or send an Accept: text/markdown header.
          </p>
        </div>
      </section>
    </PageShell>
  );
}
