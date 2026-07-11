// Platform — the trio as a gallery row: three tall link-cards spanning the framed column edge to
// edge, each with a bespoke line-art diagram floating in the upper field and the words anchored
// low (chip, name, one-liner, quiet arrow CTA). The diagrams are generated ink-line drawings on
// white; mix-blend-multiply melts the white into whichever surface the card shows, so hover can
// deepen the card without a pale rectangle appearing. Status chips tell the truth about
// availability; everything stays monochrome. Server component — Reveal is the client leaf.

import Image from "next/image";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { REPO_URL } from "@/lib/site";

type Offering = {
  chip: string;
  strong: boolean;
  name: string;
  body: string;
  cta: string;
  href: string;
  external?: boolean;
  art: string;
};

const OFFERINGS: Offering[] = [
  {
    chip: "Available now",
    strong: true,
    name: "rightmodeler skill",
    body: "The audit. Replay your real traces through cheaper models and approve an evidence-backed swap plan, step by step.",
    cta: "View on GitHub",
    href: REPO_URL,
    external: true,
    art: "/platform/skill.jpg",
  },
  {
    chip: "Coming soon",
    strong: false,
    name: "rightmodeler agent",
    body: "The autopilot. A new model ships; your repo gets a pull request with the evidence attached. Migrations become code review.",
    cta: "Meet the agent",
    href: "/agent",
    art: "/platform/agent.svg",
  },
  {
    chip: "Early access",
    strong: false,
    name: "Crucible",
    body: "The instruments. Cost per layer, speed per step, failures as they happen, and a stack that stays right-sized.",
    cta: "Meet Crucible",
    href: "/crucible",
    art: "/platform/crucible.jpg",
  },
];

const cardClass =
  "group flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-parchment-white transition-[background-color,transform] duration-150 ease-out hover:bg-warm-sand active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white lg:aspect-[6/7]";

function OfferingCard({ offering }: { offering: Offering }) {
  const inner = (
    <>
      {/* The diagram — centered in the upper field, white ground melted away by multiply. Height
          is capped so the words below always stay inside the card, whatever the column width. */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pt-8">
        <Image
          src={offering.art}
          alt=""
          aria-hidden
          width={480}
          height={480}
          sizes="(min-width: 768px) 30vw, 80vw"
          className="h-auto max-h-56 w-auto max-w-[72%] mix-blend-multiply sm:max-h-64"
          unoptimized={offering.art.endsWith(".svg")}
        />
      </div>

      <div className="p-5 sm:p-6">
        <span
          className={`inline-flex w-fit items-center rounded border border-ash-border px-1.5 py-0.5 font-mono text-caption uppercase ${
            offering.strong ? "font-medium text-midnight-ink" : "text-driftwood"
          }`}
        >
          {offering.chip}
        </span>
        <span className="mt-4 block font-sans text-heading-sm text-midnight-ink">
          {offering.name}
        </span>
        {/* Reserve four body lines at desktop so the three CTA arrows sit on one line. */}
        <span className="mt-2 block text-body text-driftwood md:min-h-24">
          {offering.body}
        </span>
        <span className="mt-4 inline-flex items-center gap-2 text-body text-midnight-ink">
          {offering.cta}
          <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
        </span>
      </div>
    </>
  );

  if (offering.external) {
    return (
      <a
        href={offering.href}
        target="_blank"
        rel="noreferrer noopener"
        className={cardClass}
      >
        {inner}
      </a>
    );
  }
  return (
    <Link href={offering.href} className={cardClass}>
      {inner}
    </Link>
  );
}

export function Platform() {
  return (
    <section className="bg-parchment-white">
      <div className="px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <p className="font-mono text-caption uppercase text-fog">
            The platform
          </p>
          <h2 className="mt-4 max-w-2xl font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            See everything. Prove what&rsquo;s better. Switch by pull request.
          </h2>
        </Reveal>

        <div className="mt-8 grid gap-4 sm:mt-10 sm:gap-5 md:grid-cols-3">
          {OFFERINGS.map((offering, i) => (
            <Reveal key={offering.name} delay={i * 0.06} className="h-full">
              <OfferingCard offering={offering} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
