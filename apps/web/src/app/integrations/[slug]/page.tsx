import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyCommand } from "@/components/copy-command";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { FaqAccordion } from "@/components/sections/faq-accordion";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { getAllSlugs, getIntegration } from "@/content/integrations";
import { pageMetadata } from "@/lib/seo";
import { RUN_COMMAND, SITE_URL } from "@/lib/site";

// Prerender every integration at build time. Cache Components requires generateStaticParams to
// return at least one param; unknown slugs are handled by notFound() in the page below.
export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

// Every real integration is statically prerendered above, so navigating to one is already instant;
// the only non-instant path is the fallback for an unknown slug, which immediately 404s. Opt this
// segment out of Cache Components' instant-navigation validation, as blog/[slug] does.
export const instant = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) return {};
  return pageMetadata({
    title: integration.title,
    description: integration.description,
    path: `/integrations/${integration.slug}`,
  });
}

// Same ink pill as the use-cases CTA cards — page-local by house convention.
const pillPrimary =
  "inline-flex items-center justify-center rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

const rule = <div aria-hidden className="h-px w-full bg-ash-border" />;

// Every content band shares one skeleton — the catalog grid the FAQ and the hub already use:
// section heading (and optional intro) in the left rail, content in the right cell, so the whole
// page keeps a single spine. First rows drop their top padding to top-align with the heading.
function Band({
  heading,
  intro,
  children,
}: {
  heading: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-parchment-white">
      <div className="px-6 py-14 sm:px-10 sm:py-16 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-16">
          <Reveal>
            <h2 className="max-w-xs font-sans text-heading-sm text-midnight-ink">
              {heading}
            </h2>
            {intro && (
              <p className="mt-3 max-w-xs text-body text-driftwood">{intro}</p>
            )}
          </Reveal>
          <div>{children}</div>
        </div>
      </div>
    </section>
  );
}

// One command block: a mono comment over the copyable command, the same grammar as the hero CTA.
function CommandBlock({
  comment,
  command,
}: {
  comment: string;
  command: string;
}) {
  return (
    <div>
      <p className="font-mono text-caption text-fog">{comment}</p>
      <CopyCommand command={command} className="mt-2 max-w-full" />
    </div>
  );
}

export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) notFound();

  const data = integration;
  // Resolve related slugs against the registry; a slug that isn't registered yet simply drops out.
  const related = data.related.flatMap((relatedSlug) => {
    const entry = getIntegration(relatedSlug);
    return entry ? [entry] : [];
  });

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      {
        "@type": "ListItem",
        position: 2,
        name: "Integrations",
        item: `${SITE_URL}/integrations`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: data.name,
        item: `${SITE_URL}/integrations/${data.slug}`,
      },
    ],
  };

  return (
    <PageShell>
      <JsonLd data={breadcrumbLd} />

      <PageHero
        eyebrow={`Integration · ${data.name}`}
        title={data.h1}
        lede={data.lede}
      >
        <span className="inline-flex items-center rounded-md border border-ash-border bg-warm-sand px-3 py-1.5 font-mono text-caption text-midnight-ink">
          {data.categoryLabel}
        </span>
      </PageHero>

      {rule}

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
          <Reveal>
            <Tldr>{data.tldr}</Tldr>
          </Reveal>
        </div>
      </section>

      {rule}

      {/* ── How it works with <name>: numbered rows, dotted hairlines between steps. ── */}
      <Band heading={`How it works with ${data.name}`}>
        {data.steps.map((step, i) => (
          <Reveal key={step.label} delay={i * 0.04}>
            <div
              className={
                i > 0 ? "border-t border-dotted border-ash-border py-6" : "pb-6"
              }
            >
              <span className="font-mono text-caption uppercase text-fog">
                {step.label}
              </span>
              <h3 className="mt-2 text-subheading text-midnight-ink">
                {step.title}
              </h3>
              <p className="mt-2 text-body text-driftwood">{step.body}</p>
            </div>
          </Reveal>
        ))}
      </Band>

      {rule}

      {/* ── Setup: the standard install command first (from lib/site, so it never drifts), then
          the tool-specific commands from the data file. ── */}
      <Band heading="Setup" intro={data.setup.intro}>
        <div className="space-y-6">
          <CommandBlock
            comment="# install the rightmodeler skill"
            command={RUN_COMMAND}
          />
          {data.setup.commands.map((entry) => (
            <CommandBlock
              key={entry.command}
              comment={entry.comment}
              command={entry.command}
            />
          ))}
        </div>
      </Band>

      {rule}

      {/* ── What rightmodeler reads: the adapter's field mapping, rendered as the normalized
          ledger it produces. Factual rows; hidden for non-trace integrations. ── */}
      {data.reads.length > 0 && (
        <>
          <Band
            heading={`What rightmodeler reads from ${data.name}`}
            intro="Every run is folded into one per-step schema, the same one the replay and the judge run on."
          >
            <div className="rounded-xl border border-ash-border bg-warm-sand">
              <div className="flex items-center justify-between gap-3 border-b border-ash-border px-4 py-2.5">
                <span className="min-w-0 truncate font-mono text-caption text-driftwood">
                  normalized schema ← {data.name}
                </span>
              </div>
              <div className="divide-y divide-ash-border">
                {data.reads.map((row) => (
                  <div
                    key={row.field}
                    className="flex items-baseline justify-between gap-4 px-4 py-2.5 font-mono text-[12px]"
                  >
                    <span className="shrink-0 text-driftwood">{row.field}</span>
                    <span className="min-w-0 truncate text-right text-midnight-ink">
                      {row.source}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            {data.detection && (
              <p className="mt-4 font-mono text-caption text-fog">
                autodetected by: {data.detection}
              </p>
            )}
          </Band>
          {rule}
        </>
      )}

      {/* ── Use cases for the combination. ── */}
      <Band heading="Use cases">
        {data.useCases.map((useCase, i) => (
          <Reveal key={useCase.title} delay={i * 0.04}>
            <div
              className={
                i > 0 ? "border-t border-dotted border-ash-border py-6" : "pb-6"
              }
            >
              <h3 className="text-subheading text-midnight-ink">
                {useCase.title}
              </h3>
              <p className="mt-2 text-body text-driftwood">{useCase.body}</p>
            </div>
          </Reveal>
        ))}
      </Band>

      {rule}

      {/* ── The honest part: what this integration is not. The abstain beat, kept load-bearing. ── */}
      <Band heading="The honest part">
        <ul>
          {data.limits.map((limit, i) => (
            <Reveal key={limit} delay={i * 0.04}>
              <li
                className={
                  i > 0
                    ? "border-t border-dotted border-ash-border py-5"
                    : "pb-5"
                }
              >
                <span className="text-body text-driftwood">{limit}</span>
              </li>
            </Reveal>
          ))}
        </ul>
      </Band>

      {rule}

      <FaqAccordion items={data.faq} />

      {rule}

      {/* ── CTA: run the skill today, or line up the Crucible integration. ── */}
      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <Reveal>
            <div className="rounded-2xl border border-ash-border bg-warm-sand p-6 sm:p-10">
              {data.cta === "crucible" ? (
                <>
                  <h2 className="font-sans text-heading-sm text-midnight-ink">
                    Deeper {data.name} support arrives with Crucible
                  </h2>
                  <p className="mt-2 max-w-md text-body text-driftwood">
                    Crucible is the analytics and optimization suite on the way.
                    Join the waitlist and it will meet your stack where it runs.
                  </p>
                  <div className="mt-5">
                    <Link href="/crucible" className={pillPrimary}>
                      Join the Crucible waitlist
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="font-sans text-heading-sm text-midnight-ink">
                    Run the audit on your own traces
                  </h2>
                  <p className="mt-2 max-w-md text-body text-driftwood">
                    The skill is free on GitHub. One command installs it; your{" "}
                    {data.name} traces do the rest.
                  </p>
                  <div className="mt-5 flex flex-wrap items-center gap-4">
                    <GithubButton />
                    <CopyCommand command={RUN_COMMAND} />
                  </div>
                </>
              )}
            </div>
          </Reveal>
        </div>
      </section>

      {rule}

      <section className="bg-parchment-white">
        <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
          <RelatedLinks
            links={[
              { href: "/integrations", label: "All integrations" },
              ...related.map((entry) => ({
                href: `/integrations/${entry.slug}`,
                label: entry.name,
              })),
              { href: "/how-it-works", label: "How it works" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
