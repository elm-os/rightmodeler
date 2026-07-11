// Platform — the trio, stated once on the landing page: the skill you can run today, the agent
// that ships swaps as PRs, and Crucible watching every layer. Three link-cards on the parchment
// canvas (PostCard grammar: hairline border, surface deepens on hover, gentle press), each with a
// mono status chip that tells the truth about availability. The header carries the why-now facts
// (release cadence, price spreads) so the perceived scale comes from the problem, not from
// invented traction. Server component — composes Reveal and the shared icons only.

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
  },
  {
    chip: "Coming soon",
    strong: false,
    name: "rightmodeler agent",
    body: "The autopilot. A new model ships; your repo gets a pull request with the evidence attached. Migrations become code review.",
    cta: "Meet the agent",
    href: "/agent",
  },
  {
    chip: "Early access",
    strong: false,
    name: "Crucible",
    body: "The instruments. Cost per layer, speed per step, failures as they happen, and a stack that stays right-sized.",
    cta: "Meet Crucible",
    href: "/crucible",
  },
];

const cardClass =
  "group flex h-full flex-col rounded-xl border border-ash-border bg-parchment-white p-5 transition-[background-color,transform] duration-150 ease-out hover:bg-warm-sand active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-parchment-white sm:p-6";

function OfferingCard({ offering }: { offering: Offering }) {
  const inner = (
    <>
      <span
        className={`inline-flex w-fit items-center rounded border border-ash-border px-1.5 py-0.5 font-mono text-caption uppercase ${
          offering.strong ? "font-medium text-midnight-ink" : "text-driftwood"
        }`}
      >
        {offering.chip}
      </span>
      <span className="mt-4 font-sans text-heading-sm text-midnight-ink">
        {offering.name}
      </span>
      <span className="mt-2 flex-1 text-body text-driftwood">
        {offering.body}
      </span>
      <span className="mt-5 inline-flex items-center gap-2 text-body text-midnight-ink">
        {offering.cta}
        <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
      </span>
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
      <div className="mx-auto max-w-5xl px-6 py-16 sm:px-8 sm:py-24">
        <Reveal className="max-w-2xl">
          <p className="font-mono text-caption uppercase text-fog">
            The platform
          </p>
          <h2 className="mt-4 font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            See everything. Prove what&rsquo;s better. Switch by pull request.
          </h2>
          <p className="mt-4 text-body text-driftwood">
            A frontier release lands every few weeks, and comparable models sit
            ten times apart on price. Keeping every step of an agent system on
            the right model has become a full-time job. rightmodeler makes it a
            loop: watch, prove, ship the switch.
          </p>
        </Reveal>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
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
