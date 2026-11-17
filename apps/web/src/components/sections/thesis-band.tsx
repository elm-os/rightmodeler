import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { Reveal } from "@/components/reveal";

// The four shortcuts from docs/positioning.md, in its order. The router row is our opinion and
// carries its reasons; it never names a product.
const FAILURES: { title: string; body: string }[] = [
  {
    title: "Blind swaps fail quietly.",
    body: "Nothing throws. The JSON still parses and is wrong on the edge cases.",
  },
  {
    title: "Routers don’t work in production.",
    body: "Our view: unvalidated on your workload, an extra hop, harder to reproduce.",
  },
  {
    title: "General benchmarks aren’t your workload.",
    body: "A leaderboard ranks models on someone else’s tasks, not your accepted outputs.",
  },
  {
    title: "Frontier everywhere costs too much.",
    body: "It feels safe until the bill compounds on steps nobody has measured.",
  },
];

// Sits directly above Platform: its closer defines "safe" before Platform's h2 uses the word.
export function ThesisBand() {
  return (
    <section className="bg-parchment-white">
      <div className="px-4 py-16 sm:px-6 sm:py-24">
        <Reveal>
          <p className="font-mono text-caption uppercase text-fog">
            Why model swaps stall
          </p>
          <h2 className="mt-4 max-w-2xl font-display text-heading text-balance text-midnight-ink sm:text-heading-lg">
            Model maintenance is a standing job.
          </h2>
          <p className="mt-5 max-w-2xl text-subheading text-pretty text-driftwood sm:text-balance">
            Every few weeks a new model restarts the manual check. Teams take
            four shortcuts. None holds up.
          </p>
        </Reveal>

        {/* The rules run edge to edge and meet the page column's own borders, like the
            dividers between sections. No closing rule: the callout's edge ends the list. */}
        <div className="-mx-4 mt-8 sm:-mx-6 sm:mt-10">
          {FAILURES.map((failure, i) => (
            <Reveal key={failure.title} delay={i * 0.06}>
              <div className="border-t border-ash-border px-4 py-5 sm:px-6 sm:py-6 md:grid md:grid-cols-2 md:items-baseline md:gap-8 lg:grid-cols-[26rem_minmax(0,1fr)]">
                <h3 className="font-sans text-heading-sm text-balance text-midnight-ink">
                  {failure.title}
                </h3>
                <p className="mt-1 text-body text-pretty text-driftwood md:mt-0">
                  {failure.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-2 sm:mt-4">
          <div className="rounded-2xl border border-ash-border bg-warm-sand p-5 sm:p-8 xl:flex xl:items-center xl:justify-between xl:gap-8">
            <div className="min-w-0">
              <p className="text-heading-sm text-balance text-midnight-ink">
                What holds up: one pinned model per step, validated on your own
                traces.
              </p>
              <p className="mt-2 text-body text-pretty text-driftwood">
                A swap is safe when it clears every release gate on your own
                traces.
              </p>
            </div>
            <Link
              href="/how-it-works"
              className="group mt-2.5 -mb-2.5 inline-flex shrink-0 items-center gap-2 rounded py-2.5 text-body text-midnight-ink underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-midnight-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-warm-sand xl:my-0"
            >
              How the gates work
              <ArrowRightIcon className="transition-transform duration-150 ease-out [@media(hover:hover)_and_(pointer:fine)]:group-hover:translate-x-0.5" />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
