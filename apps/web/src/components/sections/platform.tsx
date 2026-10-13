import Image from "next/image";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";

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
    chip: "On npm now",
    strong: true,
    name: "rightmodeler CLI",
    body: "The audit. Replay your traces through cheaper models and ship approved swaps as a pull request, evidence attached. Your coding agent can drive it through the skill.",
    cta: "Run the audit",
    href: "/how-it-works",
    art: "/platform/skill.jpg",
  },
  {
    chip: "Self-host today",
    strong: true,
    name: "rightmodeler agent",
    body: "The autopilot. A new model ships; give the word and your repo gets a pull request with the evidence attached. Migrations become code review.",
    cta: "Meet the agent",
    href: "/agent",
    art: "/platform/agent.svg",
  },
  {
    chip: "In development",
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
      {/* mix-blend-multiply melts the art's white ground into the card, so hover shows no pale
          rectangle. The height cap keeps the words below inside the card. */}
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
        {/* A heading inside an anchor is valid HTML5: anchors take flow content. */}
        <h3 className="mt-4 block font-sans text-heading-sm text-midnight-ink">
          {offering.name}
        </h3>
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
            See everything. Measure candidates. Review the pull request.
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
