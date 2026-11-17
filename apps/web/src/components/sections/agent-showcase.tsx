import Image from "next/image";
import {
  PullRequestIcon,
  QualityFloorIcon,
  ReplayLoopIcon,
  WatchSignalIcon,
} from "@/components/icons";
import { Reveal } from "@/components/reveal";
import { AgentPrCard } from "@/components/sections/agent-pr-card";

const STEPS: {
  Icon: typeof WatchSignalIcon;
  name: string;
  body: string;
}[] = [
  {
    Icon: WatchSignalIcon,
    name: "Notice",
    body: "A weekly schedule rechecks catalog prices and rebuilds the shortlist, so a cheaper model released in the last 90 days gets flagged per step.",
  },
  {
    Icon: ReplayLoopIcon,
    name: "Replay",
    body: "On your word, candidates replay your recorded calls, and swaps that feed later model steps are confirmed end to end in a sandbox.",
  },
  {
    Icon: QualityFloorIcon,
    name: "Judge",
    body: "A judge from a different vendor, or your own evaluator, grades each output against the one you accepted, with your quality floor as the bar.",
  },
  {
    Icon: PullRequestIcon,
    name: "Open the PR",
    body: "A draft pull request that changes only model identifiers, evidence attached, for your review. Thin evidence means no PR.",
  },
];

export function AgentShowcase() {
  return (
    <div>
      <h2 className="sr-only">How it decides</h2>

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-2">
        {/* At least square, free to grow: aspect-square with h-full pins the height and lets content overflow. */}
        <Reveal className="h-full lg:@container">
          <div className="relative isolate flex h-full flex-col overflow-hidden rounded-2xl border border-ash-border bg-warm-sand lg:min-h-[100cqw]">
            <Image
              src="/agent/showcase-grain.jpg"
              alt=""
              fill
              aria-hidden
              className="-z-10 object-cover object-left-bottom"
              sizes="(min-width: 1024px) 50vw, 100vw"
            />
            {/* Bleeds off the right edge on desktop on purpose: the panel clips it. */}
            <div className="ml-4 sm:ml-8 lg:-mr-16">
              <AgentPrCard />
            </div>

            {/* min-h-12 reserves two lines so both panels' kickers sit level, whatever wraps. */}
            <div className="mt-auto max-w-lg px-4 pb-4 pt-6 sm:px-8 sm:pb-8">
              <p className="font-mono text-caption uppercase text-driftwood">
                The deliverable
              </p>
              <p className="mt-2 min-h-12 text-body text-midnight-ink">
                A diff that changes only model identifiers, with the receipts
                attached.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.06} className="h-full lg:@container">
          <div className="flex h-full flex-col rounded-2xl border border-ash-border bg-warm-sand p-4 sm:p-8 lg:min-h-[100cqw]">
            <div className="rounded-xl border border-ash-border bg-parchment-white p-5 sm:p-7">
              <p className="font-mono text-caption uppercase text-fog">TL;DR</p>
              <p className="mt-3 text-subheading text-driftwood">
                rightmodeler agent rechecks the provider catalog every week for
                cheaper models. On your word, it does the validation work
                unattended, and when a swap clears every gate, it opens the
                evidence and the model edit as{" "}
                <span className="text-midnight-ink">
                  a draft pull request in your repo
                </span>
                . Today, the final yes stays yours.
              </p>
            </div>

            <div className="mt-auto max-w-md pt-10">
              <p className="font-mono text-caption uppercase text-driftwood">
                The loop
              </p>
              <p className="mt-2 min-h-12 text-body text-midnight-ink">
                Notice, replay, judge, open the PR. On a schedule and on your
                word, inside the policy you set.
              </p>
            </div>
          </div>
        </Reveal>
      </div>

      <div className="mt-4 grid gap-4 sm:mt-5 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <Reveal
            key={step.name}
            delay={i * 0.06}
            className="h-full lg:@container"
          >
            <div className="flex h-full flex-col rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-6 lg:min-h-[100cqw]">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-ash-border bg-parchment-white text-driftwood">
                <step.Icon size={19} />
              </span>
              {/* A fixed offset, not bottom-anchored, so the four titles share a line. */}
              <div className="mt-8 sm:mt-10">
                <h3 className="font-sans text-heading-sm text-midnight-ink">
                  {step.name}
                </h3>
                <p className="mt-2 text-body text-driftwood">{step.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
