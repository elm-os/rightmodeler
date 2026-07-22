// Case-study kit: the article masthead, the framed mono "window" artifacts (stats, routing
// policies, key-value ledgers), and the listing card used on the landing band and /case-study
// index. Follows the hero ApprovalTable grammar (warm-sand window, ash-border hairlines, mono
// data, tabular numerals) and the blog PostHeader/post-card treatments, so a case study reads
// as the same product surface as a post. Server components composing client primitives only;
// strictly monochrome, with the customer's own mark confined to the logo plate and cards.

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRightIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import type { CaseStudy } from "@/content/case-studies";
import { formatPostDate } from "@/lib/site";

// Article masthead: PostHeader's markup with the company byline in the author slot, and the hero
// art carrying a small parchment plate with the customer's logo (the mark stays crisp, never
// baked into the artwork).
export function CaseStudyHeader({ study }: { study: CaseStudy }) {
  return (
    <header className="pt-16 pb-10 sm:pt-24 sm:pb-14">
      <Reveal className="mx-auto max-w-2xl px-6 sm:px-8">
        <p className="font-mono text-caption text-fog uppercase">Case study</p>

        <h1 className="mt-5 font-display text-heading-lg text-balance text-midnight-ink sm:text-display">
          {study.title}
        </h1>

        <p className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-caption text-fog">
          <span className="text-driftwood">{study.company}</span>
          <span aria-hidden>·</span>
          <time dateTime={study.date}>{formatPostDate(study.date)}</time>
          <span aria-hidden>·</span>
          <span>{study.readingMinutes} min read</span>
        </p>
      </Reveal>

      <Reveal
        delay={0.08}
        className="mx-auto mt-10 max-w-4xl px-6 sm:mt-12 sm:px-8"
      >
        <div className="relative overflow-hidden rounded-xl border border-ash-border bg-warm-sand">
          <Image
            src={study.hero.src}
            alt={study.hero.alt}
            width={1200}
            height={630}
            priority
            sizes="(min-width: 1024px) 56rem, 100vw"
            className="h-auto w-full"
          />
          <div className="absolute bottom-3 left-3 flex items-center rounded-lg border border-ash-border bg-parchment-white/95 px-3 py-2 sm:bottom-4 sm:left-4">
            <Image
              src={study.logo.src}
              alt={`${study.company} logo`}
              width={study.logo.width}
              height={study.logo.height}
              sizes="8rem"
              className="h-6 w-auto sm:h-7"
            />
          </div>
        </div>
      </Reveal>
    </header>
  );
}

// The framed mono window every case-study figure sits in: title bar with the artifact name (left)
// and a methodology fact (right), hairline-divided body, optional provenance footer.
export function Artifact({
  title,
  meta,
  footer,
  children,
}: {
  title: string;
  meta?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-ash-border bg-warm-sand">
      <div className="flex items-center justify-between gap-4 border-b border-ash-border px-4 py-2.5">
        <span className="min-w-0 truncate font-mono text-caption text-driftwood">
          {title}
        </span>
        {meta && (
          <span className="shrink-0 font-mono text-caption text-fog">
            {meta}
          </span>
        )}
      </div>

      {children}

      {footer && (
        <div className="border-t border-ash-border px-4 py-2.5">
          <p className="font-mono text-caption text-fog">{footer}</p>
        </div>
      )}
    </div>
  );
}

// One big number and its mono label. The value renders as children so a page can pass either a
// static tabular span or an AnimatedNumber; both inherit the display face from the wrapper.
export function StatCell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="font-display text-heading text-midnight-ink sm:text-heading-lg">
        {children}
      </div>
      <p className="mt-1 font-mono text-caption text-driftwood">{label}</p>
    </div>
  );
}

const ROUTE_GRID = "11rem minmax(0, 1fr)";

// Routing-policy rows: mono route id (ink) against what it covers (driftwood). Desktop keeps a
// two-column grid with a header row; on phones each route stacks so nothing scrolls sideways.
export function RouteRows({
  rows,
}: {
  rows: { route: string; covers: string }[];
}) {
  return (
    <>
      <div className="hidden sm:block">
        <div
          className="grid h-9 items-center gap-x-3 border-b border-ash-border px-4 font-mono text-caption text-fog"
          style={{ gridTemplateColumns: ROUTE_GRID }}
        >
          <span>route</span>
          <span>covers</span>
        </div>
        <div className="divide-y divide-ash-border">
          {rows.map((row) => (
            <div
              key={row.route}
              className="grid items-center gap-x-3 px-4 py-2.5 font-mono text-[13px]"
              style={{ gridTemplateColumns: ROUTE_GRID }}
            >
              <span className="text-midnight-ink">{row.route}</span>
              <span className="text-driftwood">{row.covers}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="divide-y divide-ash-border sm:hidden">
        {rows.map((row) => (
          <div key={row.route} className="px-4 py-3">
            <p className="font-mono text-[13px] text-midnight-ink">
              {row.route}
            </p>
            <p className="mt-1 font-mono text-caption text-driftwood">
              {row.covers}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

// Key-value ledger rows (label left, tabular value right). A `strong` row is the punchline and
// lifts to ink + medium, the same emphasis move the hero ledger uses for its abstain verdict.
export function KVRows({
  rows,
}: {
  rows: { label: string; value: string; strong?: boolean }[];
}) {
  return (
    <div className="divide-y divide-ash-border">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-4 px-4 py-2.5 font-mono text-[13px]"
        >
          <span
            className={
              row.strong ? "font-medium text-midnight-ink" : "text-driftwood"
            }
          >
            {row.label}
          </span>
          <span
            className={`text-right tabular-nums text-midnight-ink ${
              row.strong ? "font-medium" : ""
            }`}
          >
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// Listing card for the landing band and the /case-study index: the post-card treatment (whole
// card is the link, hover deepens the surface, press compresses) with the customer logo up top.
export function CaseStudyCard({
  study,
  titleAs: Title = "h3",
}: {
  study: CaseStudy;
  titleAs?: "h2" | "h3";
}) {
  return (
    <Link
      href={`/case-study/${study.slug}`}
      className="group flex h-full flex-col rounded-xl border border-ash-border bg-parchment-white p-6 transition-[transform,background-color] duration-200 ease-out-strong hover:bg-warm-sand active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:p-8"
    >
      <div className="flex h-10 items-center">
        <Image
          src={study.logo.src}
          alt={`${study.company} logo`}
          width={study.logo.width}
          height={study.logo.height}
          sizes="10rem"
          className="h-full w-auto"
        />
      </div>

      <Title className="mt-5 font-display text-heading-sm text-balance text-midnight-ink sm:text-heading">
        {study.headline}
      </Title>

      <p className="mt-3 text-body text-driftwood">{study.excerpt}</p>

      <div className="mt-auto flex items-center justify-between gap-4 pt-6">
        <span className="font-mono text-caption text-fog">{study.tagline}</span>
        <ArrowRightIcon className="shrink-0 text-driftwood transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
