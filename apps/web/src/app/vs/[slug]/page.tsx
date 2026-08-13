import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { CopyCommand } from "@/components/copy-command";
import { JsonLd } from "@/components/json-ld";
import { Reveal } from "@/components/reveal";
import { FaqAccordion } from "@/components/sections/faq-accordion";
import { GithubButton } from "@/components/sections/github-button";
import { PageHero } from "@/components/sections/page-hero";
import { PageShell } from "@/components/sections/page-shell";
import { RelatedLinks } from "@/components/sections/related-links";
import { Tldr } from "@/components/sections/tldr";
import { CompareTable } from "@/components/vs/compare-table";
import { SplitColumns } from "@/components/vs/split-columns";
import { getAllSlugs, getComparison } from "@/content/vs";
import type { VsBlock } from "@/content/vs/types";
import { pageMetadata } from "@/lib/seo";
import { RUN_COMMAND, SITE_URL } from "@/lib/site";

// Prerender every comparison at build time. Cache Components requires generateStaticParams to
// return at least one param; unknown slugs are handled by notFound() in the page below.
export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

// Every real comparison is statically prerendered above, so navigating to one is already instant;
// the only non-instant path is the fallback for an unknown slug, which immediately 404s. Opt this
// segment out of Cache Components' instant-navigation validation, as integrations/[slug] does.
export const instant = false;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const comparison = getComparison(slug);
  if (!comparison) return {};
  return pageMetadata({
    title: comparison.title,
    description: comparison.description,
    path: `/vs/${comparison.slug}`,
  });
}

// Same ink pill as the use-cases CTA cards — page-local by house convention.
const pillPrimary =
  "inline-flex items-center justify-center rounded-xl bg-midnight-ink px-5 py-3 text-body font-medium text-parchment-white transition-transform duration-150 ease-out-strong active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white";

const rule = <div aria-hidden className="h-px w-full bg-ash-border" />;

// Every content band shares one skeleton — the same left-rail spine as the integration pages:
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

// The block renderer: JSON block type -> section. The schema (content/vs/vs-page.schema.json,
// enforced in `pnpm check`) guarantees each type carries exactly the fields it renders, so the
// guards below are unreachable fallbacks, not content switches. Winner labels stay lowercase
// "rightmodeler" (no CSS uppercase), per the brand rule.
function BlockSection({ block, name }: { block: VsBlock; name: string }) {
  switch (block.type) {
    case "tldr":
      if (!block.body) return null;
      return (
        <section className="bg-parchment-white">
          <div className="mx-auto max-w-3xl px-6 py-12 sm:px-10">
            <Reveal>
              <Tldr>{block.body}</Tldr>
            </Reveal>
          </div>
        </section>
      );

    case "positioning":
    case "fork":
      if (!block.left || !block.right) return null;
      return <SplitColumns left={block.left} right={block.right} />;

    case "contrast":
      if (!block.left || !block.right) return null;
      return (
        <SplitColumns
          left={block.left}
          right={block.right}
          markers="contrast"
        />
      );

    case "scenarios":
      if (!block.heading || !block.scenarios) return null;
      return (
        <Band heading={block.heading} intro={block.intro}>
          {block.scenarios.map((entry, i) => (
            <Reveal key={entry.scenario} delay={i * 0.04}>
              <div
                className={
                  i > 0
                    ? "border-t border-dotted border-ash-border py-6"
                    : "pb-6"
                }
              >
                <h3 className="text-subheading text-midnight-ink">
                  {entry.scenario}
                </h3>
                <p className="mt-2 font-mono text-caption text-fog">
                  the right hire:{" "}
                  {entry.winner === "ours"
                    ? "rightmodeler"
                    : entry.winner === "both"
                      ? "both, together"
                      : name}
                </p>
                <p className="mt-2 text-body text-driftwood">{entry.why}</p>
              </div>
            </Reveal>
          ))}
        </Band>
      );

    case "table":
      if (
        !block.heading ||
        !block.leftLabel ||
        !block.rightLabel ||
        !block.rows
      )
        return null;
      return (
        <Band heading={block.heading} intro={block.intro}>
          <CompareTable
            caption={block.caption}
            leftLabel={block.leftLabel}
            rightLabel={block.rightLabel}
            rows={block.rows}
          />
        </Band>
      );

    case "stack":
      if (!block.heading) return null;
      return (
        <Band heading={block.heading} intro={block.intro}>
          <div className="space-y-6">
            {block.paragraphs?.map((paragraph) => (
              <p key={paragraph} className="text-body text-driftwood">
                {paragraph}
              </p>
            ))}
            {block.commands?.map((entry) => (
              <CommandBlock
                key={entry.command}
                comment={entry.comment}
                command={entry.command}
              />
            ))}
          </div>
        </Band>
      );

    case "prose":
      if (!block.heading || !block.paragraphs) return null;
      return (
        <Band heading={block.heading} intro={block.intro}>
          <ul>
            {block.paragraphs.map((paragraph, i) => (
              <Reveal key={paragraph} delay={i * 0.04}>
                <li
                  className={
                    i > 0
                      ? "border-t border-dotted border-ash-border py-5"
                      : "pb-5"
                  }
                >
                  <span className="text-body text-driftwood">{paragraph}</span>
                </li>
              </Reveal>
            ))}
          </ul>
        </Band>
      );

    case "definitions":
      if (!block.heading || !block.terms) return null;
      return (
        <Band heading={block.heading} intro={block.intro}>
          <dl>
            {block.terms.map((entry, i) => (
              <Reveal key={entry.term} delay={i * 0.04}>
                <div
                  className={
                    i > 0
                      ? "border-t border-dotted border-ash-border py-5"
                      : "pb-5"
                  }
                >
                  <dt className="text-body font-medium text-midnight-ink">
                    {entry.slug ? (
                      <Link
                        href={`/glossary#${entry.slug}`}
                        className="underline decoration-ash-border decoration-1 underline-offset-4 transition-colors duration-150 ease-out hover:decoration-midnight-ink focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white"
                      >
                        {entry.term}
                      </Link>
                    ) : (
                      entry.term
                    )}
                  </dt>
                  <dd className="mt-1 text-body text-driftwood">{entry.def}</dd>
                </div>
              </Reveal>
            ))}
          </dl>
        </Band>
      );

    case "faq":
      if (!block.items) return null;
      return <FaqAccordion items={block.items} />;

    default:
      return null;
  }
}

export default async function VsDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const comparison = getComparison(slug);
  if (!comparison) notFound();

  const data = comparison;
  // Resolve related slugs against the registry; a slug that isn't registered yet simply drops out.
  const related = data.related.flatMap((relatedSlug) => {
    const entry = getComparison(relatedSlug);
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
        name: "Comparisons",
        item: `${SITE_URL}/vs`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: data.name,
        item: `${SITE_URL}/vs/${data.slug}`,
      },
    ],
  };

  return (
    <PageShell>
      <JsonLd data={breadcrumbLd} />

      <PageHero
        eyebrow={`Comparison · ${data.name}`}
        title={data.h1}
        lede={data.lede}
      >
        <span className="inline-flex items-center rounded-md border border-ash-border bg-warm-sand px-3 py-1.5 font-mono text-caption text-midnight-ink">
          {data.verdictLabel}
        </span>
      </PageHero>

      {data.blocks.map((block, i) => (
        <Fragment key={i}>
          {rule}
          <BlockSection block={block} name={data.name} />
        </Fragment>
      ))}

      {rule}

      {/* ── CTA: run the skill today, or line up the Crucible integration. ── */}
      <section className="bg-parchment-white">
        <div className="px-4 py-14 sm:px-6 sm:py-16">
          <Reveal>
            <div className="rounded-2xl border border-ash-border bg-warm-sand p-6 sm:p-10">
              {data.cta === "crucible" ? (
                <>
                  <h2 className="font-sans text-heading-sm text-midnight-ink">
                    Continuous optimization arrives with Crucible
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
                    The skill is free on GitHub. One command installs it, and
                    your own traces settle the question.
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
              { href: "/vs", label: "All comparisons" },
              ...related.map((entry) => ({
                href: `/vs/${entry.slug}`,
                label: `rightmodeler vs ${entry.name}`,
              })),
              ...(data.integrationSlug
                ? [
                    {
                      href: `/integrations/${data.integrationSlug}`,
                      label: `rightmodeler + ${data.name}`,
                    },
                  ]
                : []),
              { href: "/how-it-works", label: "How it works" },
            ]}
          />
        </div>
      </section>
    </PageShell>
  );
}
